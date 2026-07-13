require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

// order_date/refund_date (and other event-date columns) are stored as timestamptz.
// Rather than converting to the reporting timezone in every individual query, set it once
// per pooled connection - DATE_TRUNC/::date casts on timestamptz columns then automatically
// bucket by the configured local calendar day/month everywhere in the app, not just wherever
// this touches. Single-tenant app (one client_config row), so there's no risk of one
// customer's timezone leaking into another's request on a reused connection.
// SET TIME ZONE doesn't accept a bind parameter ($1) - Postgres only allows a literal there.
// Safe to interpolate directly since it's validated against the IANA name pattern (letters,
// digits, underscore, +/-, slash-separated segments - e.g. "Europe/London", "Etc/GMT+5") before
// ever reaching here, both here and in the PUT /api/settings/config validation below.
const IANA_TZ_PATTERN = /^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/;
pool.on('connect', async (client) => {
  try {
    const r = await client.query('SELECT timezone FROM client_config LIMIT 1');
    const tz = r.rows[0]?.timezone || 'UTC';
    await client.query(`SET TIME ZONE '${IANA_TZ_PATTERN.test(tz) ? tz : 'UTC'}'`);
  } catch (e) {
    console.error('[db] Failed to set session timezone, defaulting to UTC:', e.message);
  }
});

app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'text/csv', limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../client/build')));

// ─── VAT-EXCLUSIVE REPORTING: SCHEMA MIGRATION ──────────────────────────
// vat_rates holds one standard rate per country, editable via Settings, used to strip VAT
// out of revenue/fees for VAT-registered accounts (see getVatContext() below). Runs on every
// boot - CREATE/ALTER ...IF NOT EXISTS make it a no-op once applied, same self-migrating
// pattern amazon-spapi-proxy's /setup-db uses, just triggered automatically instead of by
// a manual call since this app has no dedicated setup endpoint.
(async function migrateVatSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vat_rates (
        country_code CHAR(2) PRIMARY KEY,
        country_name TEXT NOT NULL,
        standard_rate NUMERIC(5,2) NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE client_config ADD COLUMN IF NOT EXISTS company_country CHAR(2);
    `);
    await pool.query(`
      INSERT INTO vat_rates (country_code, country_name, standard_rate) VALUES
        ('GB','United Kingdom',20.00),('IE','Ireland',23.00),('DE','Germany',19.00),
        ('FR','France',20.00),('IT','Italy',22.00),('ES','Spain',21.00),('NL','Netherlands',21.00),
        ('BE','Belgium',21.00),('PL','Poland',23.00),('SE','Sweden',25.00),('AT','Austria',20.00),
        ('PT','Portugal',23.00),('DK','Denmark',25.00),('FI','Finland',25.50),('LU','Luxembourg',17.00),
        ('GR','Greece',24.00),('CZ','Czechia',21.00),('RO','Romania',19.00),('HU','Hungary',27.00),
        ('BG','Bulgaria',20.00),('HR','Croatia',25.00),('SK','Slovakia',20.00),('SI','Slovenia',22.00),
        ('EE','Estonia',22.00),('LV','Latvia',21.00),('LT','Lithuania',21.00),('MT','Malta',18.00),
        ('CY','Cyprus',19.00),('NO','Norway',25.00),('CH','Switzerland',8.10),
        ('US','United States',0.00),('CA','Canada',0.00),('AU','Australia',10.00)
      ON CONFLICT (country_code) DO NOTHING;
    `);
    // vat_divisor(country) / vat_divisor_seller(): centralize the "should we strip VAT, and by
    // how much" logic in SQL so every query (raw row-math or the v_sku_revenue/v_refunds_by_date
    // views below) can just divide an inclusive amount by the function call instead of each
    // reimplementing the CASE/JOIN. Both read client_config live (STABLE, not IMMUTABLE - safe
    // to call per-row since Postgres only needs to guarantee same result within one statement),
    // so a Settings change takes effect on the next query with no cache to invalidate.
    // - vat_divisor(country): sales-side. Amazon/Shopify charge VAT on a SALE based on the
    //   destination (ship-to) country, so this is per-order-line.
    // - vat_divisor_seller(): fee-side. Amazon/Shopify charge VAT on a seller's FEES based on
    //   the seller's own country of establishment, not the customer's - a single rate account-wide,
    //   not per order. See client_config.company_country.
    // Both return 1 (no-op) when not VAT-registered, or the rate's unknown.
    await pool.query(`
      CREATE OR REPLACE FUNCTION vat_divisor(p_country_code TEXT) RETURNS NUMERIC AS $FN$
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM client_config WHERE vat_number IS NOT NULL AND TRIM(vat_number) <> '') THEN 1
          ELSE 1 + COALESCE((SELECT standard_rate FROM vat_rates WHERE country_code = p_country_code), 0) / 100.0
        END;
      $FN$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION vat_divisor_seller() RETURNS NUMERIC AS $FN$
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM client_config WHERE vat_number IS NOT NULL AND TRIM(vat_number) <> '') THEN 1
          ELSE 1 + COALESCE((SELECT vr.standard_rate FROM client_config cc JOIN vat_rates vr ON vr.country_code = cc.company_country LIMIT 1), 0) / 100.0
        END;
      $FN$ LANGUAGE sql STABLE;

      -- Same rate lookup as vat_divisor_seller() above, but NOT gated on vat_registered.
      -- Amazon charges VAT on seller fees based on the seller's own country of establishment
      -- regardless of whether that seller happens to be VAT-registered (confirmed: this
      -- account's settled Commission is VAT-inclusive even though it isn't registered) - so
      -- this one always applies. Used to correct data (estimated fees, which come from a
      -- different Amazon API that returns VAT-exclusive amounts, to match the VAT-inclusive
      -- convention settled fees use), not to decide reporting presentation, which is what
      -- vat_divisor_seller() is for.
      -- LIMIT 1 on the subquery: client_config is meant to be single-row (see the LIMIT 1 used
      -- everywhere else this table is read), but isn't enforced by a constraint - without this,
      -- any duplicate row makes the whole query error with "more than one row returned by a
      -- subquery" instead of silently returning a wrong number.
      CREATE OR REPLACE FUNCTION seller_fee_vat_multiplier() RETURNS NUMERIC AS $FN$
        SELECT 1 + COALESCE((SELECT vr.standard_rate FROM client_config cc JOIN vat_rates vr ON vr.country_code = cc.company_country LIMIT 1), 0) / 100.0;
      $FN$ LANGUAGE sql STABLE;
    `);
    // Add shipping_country to the two shared revenue/refund views so every endpoint reading from
    // them (not just the ones with raw row-math) can apply vat_divisor(shipping_country) too.
    // Formulas otherwise unchanged from the original views - only the country column and its
    // upstream join are new.
    // shipping_country must be appended as the LAST column in each SELECT list -
    // CREATE OR REPLACE VIEW refuses to insert a new column in the middle of an existing
    // view's column list (only appending at the end is allowed), and the two views are
    // separate pool.query() calls so a mistake in one can't silently roll back the other.
    await pool.query(`
      CREATE OR REPLACE VIEW v_sku_revenue AS
      SELECT 'shopify'::text AS channel, sol.shopify_order_id::text AS order_id, sol.sku, sol.order_date,
        sol.product_title, sol.quantity,
        (sol.unit_price * sol.quantity::numeric)::numeric(12,2) AS gross_sales,
        (sol.discount_per_unit * sol.quantity::numeric)::numeric(12,2) AS sku_discount,
        COALESCE(sol.amount_refunded, 0)::numeric(12,2) AS refund_amount,
        ((sol.unit_price * sol.quantity::numeric) - (sol.discount_per_unit * sol.quantity::numeric))::numeric(12,2) AS net_revenue,
        false AS is_estimated_price,
        so.shipping_country
      FROM shopify_order_lines sol
      LEFT JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
      UNION ALL
      SELECT 'amazon'::text AS channel, l.amazon_order_id AS order_id, l.sku, o.order_date,
        l.title AS product_title, l.quantity,
        ((COALESCE(NULLIF(l.unit_price, 0::numeric), lp.last_price, 0::numeric) * l.quantity::numeric) + COALESCE(l.shipping_price, 0::numeric))::numeric(12,2) AS gross_sales,
        COALESCE(l.promotion_discount, 0::numeric)::numeric(12,2) AS sku_discount,
        COALESCE(l.amount_refunded, 0::numeric)::numeric(12,2) AS refund_amount,
        ((COALESCE(NULLIF(l.unit_price, 0::numeric), lp.last_price, 0::numeric) * l.quantity::numeric) + COALESCE(l.shipping_price, 0::numeric) - COALESCE(l.promotion_discount, 0::numeric))::numeric(12,2) AS net_revenue,
        (l.unit_price = 0::numeric AND lp.last_price IS NOT NULL) AS is_estimated_price,
        o.shipping_country
      FROM amazon_order_lines l
      JOIN amazon_orders o ON o.amazon_order_id = l.amazon_order_id
      LEFT JOIN v_sku_last_price lp ON lp.sku = l.sku
      WHERE o.status <> 'Canceled'::text;
    `);
    await pool.query(`
      CREATE OR REPLACE VIEW v_refunds_by_date AS
      SELECT 'amazon'::text AS channel, r.amazon_order_id AS order_id, r.sku, r.refund_date,
        r.amount_refunded::numeric AS amount_refunded, r.quantity_refunded, o.shipping_country
      FROM amazon_order_line_refunds r
      LEFT JOIN amazon_orders o ON o.amazon_order_id = r.amazon_order_id
      WHERE r.refund_date IS NOT NULL
      UNION ALL
      SELECT 'shopify'::text AS channel, t.shopify_order_id::text AS order_id, NULL::text AS sku,
        t.transaction_date AS refund_date, t.amount::numeric AS amount_refunded, NULL::integer AS quantity_refunded,
        so.shipping_country
      FROM shopify_transactions t
      LEFT JOIN shopify_orders so ON so.shopify_order_id = t.shopify_order_id
      WHERE t.kind::text = 'refund'::text AND t.status::text = 'success'::text AND t.transaction_date IS NOT NULL;
    `);
  } catch (e) {
    console.error('[db] VAT schema migration failed:', e.message);
  }
})();

// Fetch the account's VAT-registration status once per request - true iff a VAT number is set
// on file (per product decision: presence of a VAT number IS the registration signal, there's
// no separate manually-set toggle). Endpoints use this to decide whether to apply vat_divisor()
// at all; company_country feeds vat_divisor_seller() (see migration above) for fee-side stripping.
async function getVatContext() {
  try {
    const r = await pool.query("SELECT (vat_number IS NOT NULL AND TRIM(vat_number) <> '') AS registered, company_country FROM client_config LIMIT 1");
    return { registered: !!r.rows[0]?.registered, companyCountry: r.rows[0]?.company_country || null };
  } catch { return { registered: false, companyCountry: null }; }
}

// ─── FX HELPERS ──────────────────────────────────────

// Get reporting currency from client_config (cached per request)
async function getReportingCurrency() {
  try {
    const result = await pool.query('SELECT reporting_currency FROM client_config LIMIT 1');
    return result.rows[0]?.reporting_currency || 'GBP';
  } catch { return 'GBP'; }
}

// Get FX rate for a specific date, with fallback to nearest available rate
async function getFxRate(fromCurrency, toCurrency, date) {
  if (fromCurrency === toCurrency) return 1;
  try {
    // Try exact date first, then look backwards up to 7 days (weekends/holidays)
    const result = await pool.query(`
      SELECT rate FROM exchange_rates
      WHERE base_currency = $1 AND target_currency = $2
        AND date <= $3::date
      ORDER BY date DESC LIMIT 1
    `, [fromCurrency, toCurrency, date]);
    return result.rows[0] ? parseFloat(result.rows[0].rate) : 1;
  } catch { return 1; }
}

// Convert an amount from one currency to another on a specific date
async function convertAmount(amount, fromCurrency, toCurrency, date) {
  if (!amount || fromCurrency === toCurrency) return parseFloat(amount || 0);
  const rate = await getFxRate(fromCurrency, toCurrency, date);
  return parseFloat(amount) * rate;
}

// For a date range, get a single representative rate (midpoint date)
// Used for period-level conversions in summary queries
async function getPeriodRate(fromCurrency, toCurrency, dateFrom, dateTo) {
  if (fromCurrency === toCurrency) return 1;
  try {
    const result = await pool.query(`
      SELECT AVG(rate)::numeric(12,6) AS avg_rate FROM exchange_rates
      WHERE base_currency = $1 AND target_currency = $2
        AND date BETWEEN $3::date AND $4::date
    `, [fromCurrency, toCurrency, dateFrom, dateTo]);
    if (result.rows[0]?.avg_rate) return parseFloat(result.rows[0].avg_rate);
    // No synced rate falls inside the range yet - e.g. dateTo is today/a weekend and
    // the ECB source (via the daily FX sync) has nothing newer than last Friday. Fall
    // back to the nearest available rate on/before dateTo instead of silently
    // returning 1, which used to show unconverted GBP figures under a USD/EUR symbol.
    return getFxRate(fromCurrency, toCurrency, dateTo);
  } catch { return 1; }
}

// Currency symbol helper
function currencySymbol(currency) {
  return { GBP: '£', USD: '$', EUR: '€' }[currency] || currency;
}

// ─── API ROUTES ──────────────────────────────────────

// KPI Summary
app.get('/api/summary', async (req, res) => {
  const { from, to, channel = 'all' } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  // Amazon orders enriched with v_sku_revenue rollup (gross/net incl. list-price fallback for Pending orders)
  const amazonEnriched = `
    SELECT o.amazon_order_id, o.order_date, o.status,
      o.promotion_discount / vat_divisor(o.shipping_country) AS promotion_discount,
      COALESCE(r.gross_sales, o.gross_revenue) / vat_divisor(o.shipping_country) AS gross_revenue,
      COALESCE(r.net_revenue, o.net_revenue) / vat_divisor(o.shipping_country) AS net_revenue
    FROM amazon_orders o
    LEFT JOIN (
      SELECT order_id, SUM(gross_sales)::numeric(12,2) AS gross_sales, SUM(net_revenue)::numeric(12,2) AS net_revenue
      FROM v_sku_revenue WHERE channel = 'amazon' GROUP BY order_id
    ) r ON r.order_id = o.amazon_order_id
  `;
  // Shopify orders enriched with v_sku_revenue rollup (list price gross, post-discount net)
  const shopifyEnriched = `
    SELECT o.shopify_order_id, o.order_date, o.financial_status,
      o.discount_amount / vat_divisor(o.shipping_country) AS discount_amount,
      COALESCE(r.gross_sales, o.gross_revenue) / vat_divisor(o.shipping_country) AS gross_revenue,
      COALESCE(r.net_revenue, o.net_revenue) / vat_divisor(o.shipping_country) AS net_revenue
    FROM shopify_orders o
    LEFT JOIN (
      SELECT order_id, SUM(gross_sales)::numeric(12,2) AS gross_sales, SUM(net_revenue)::numeric(12,2) AS net_revenue
      FROM v_sku_revenue WHERE channel = 'shopify' GROUP BY order_id
    ) r ON r.order_id = o.shopify_order_id::text
  `;
  try {
    let result;
    if (channel === 'all') {
      result = await pool.query(`
        SELECT COUNT(*)::int AS total_orders, SUM(gross_revenue)::numeric AS gross_revenue, SUM(net_revenue)::numeric AS net_revenue,
          SUM(discount_amount)::numeric AS total_discounts,
          AVG(net_revenue)::numeric AS avg_order_value
        FROM (
          SELECT gross_revenue, net_revenue, discount_amount FROM (${shopifyEnriched}) s
          WHERE order_date::date BETWEEN $1 AND $2 AND financial_status != 'voided'
          UNION ALL
          SELECT gross_revenue, net_revenue, promotion_discount AS discount_amount
          FROM (${amazonEnriched}) a
          WHERE order_date::date BETWEEN $1 AND $2 AND status != 'Canceled'
        ) combined
      `, [dateFrom, dateTo]);
    } else if (channel === 'amazon') {
      result = await pool.query(`
        SELECT COUNT(*)::int AS total_orders, SUM(gross_revenue)::numeric AS gross_revenue, SUM(net_revenue)::numeric AS net_revenue,
          SUM(promotion_discount)::numeric AS total_discounts,
          AVG(net_revenue)::numeric AS avg_order_value
        FROM (${amazonEnriched}) a WHERE order_date::date BETWEEN $1 AND $2 AND status != 'Canceled'
      `, [dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        SELECT COUNT(*)::int AS total_orders, SUM(gross_revenue)::numeric AS gross_revenue, SUM(net_revenue)::numeric AS net_revenue,
          SUM(discount_amount)::numeric AS total_discounts,
          AVG(net_revenue)::numeric AS avg_order_value
        FROM (${shopifyEnriched}) s WHERE order_date::date BETWEEN $1 AND $2 AND financial_status != 'voided'
      `, [dateFrom, dateTo]);
    }
    const row = result.rows[0];

    // Refunds attributed by refund_date (not order_date) — independent of the order population above
    let refundResult;
    if (channel === 'amazon' || channel === 'shopify') {
      refundResult = await pool.query(`
        SELECT COALESCE(SUM(amount_refunded / vat_divisor(shipping_country)), 0)::numeric AS total_refunded, COUNT(*)::int AS refund_count
        FROM v_refunds_by_date WHERE channel = $1 AND refund_date::date BETWEEN $2 AND $3
      `, [channel, dateFrom, dateTo]);
    } else {
      refundResult = await pool.query(`
        SELECT COALESCE(SUM(amount_refunded / vat_divisor(shipping_country)), 0)::numeric AS total_refunded, COUNT(*)::int AS refund_count
        FROM v_refunds_by_date WHERE refund_date::date BETWEEN $1 AND $2
      `, [dateFrom, dateTo]);
    }
    const refundRow = refundResult.rows[0];

    // COGS for the period — sum all orders' COGS using date-matched cogs_entries
    const cogsResult = await pool.query(`
      SELECT
        COALESCE(SUM(aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)), 0)::numeric AS total_cogs,
        COALESCE(SUM((COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_commission,0) +
          COALESCE(aol.fee_fixed_closing,0) + COALESCE(aol.fee_variable_closing,0) +
          COALESCE(aol.fee_digital_services,0)) / vat_divisor_seller()), 0)::numeric AS total_fees
      FROM amazon_order_lines aol
      JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
      LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
      LEFT JOIN LATERAL (
        -- unit_cogs is entered in cogs_entries.cogs_currency (GBP/USD/EUR); revenue figures
        -- are all GBP, so convert here at the exchange rate on the order date before this
        -- value is combined with anything GBP-denominated. No-op when currency is already GBP.
        SELECT ce0.unit_cogs * COALESCE(fx.rate, 1) AS unit_cogs
        FROM cogs_entries ce0
        LEFT JOIN LATERAL (
          SELECT rate FROM exchange_rates
          WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
            AND date <= ao.order_date::date
          ORDER BY date DESC LIMIT 1
        ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
        WHERE ce0.sku = aol.sku AND ce0.effective_from <= ao.order_date::date
          AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
        ORDER BY ce0.effective_from DESC LIMIT 1
      ) ce ON true
      WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
      UNION ALL
      SELECT
        COALESCE(SUM(sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)), 0)::numeric AS total_cogs,
        0::numeric AS total_fees
      FROM shopify_order_lines sol
      LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
      LEFT JOIN LATERAL (
        SELECT ce0.unit_cogs * COALESCE(fx.rate, 1) AS unit_cogs
        FROM cogs_entries ce0
        LEFT JOIN LATERAL (
          SELECT rate FROM exchange_rates
          WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
            AND date <= sol.order_date::date
          ORDER BY date DESC LIMIT 1
        ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
        WHERE ce0.sku = sol.sku AND ce0.effective_from <= sol.order_date::date
          AND (ce0.effective_to IS NULL OR ce0.effective_to >= sol.order_date::date)
        ORDER BY ce0.effective_from DESC LIMIT 1
      ) ce ON true
      WHERE sol.order_date::date BETWEEN $1 AND $2
    `, [dateFrom, dateTo]);
    const totalCogs = cogsResult.rows.reduce((s, r) => s + parseFloat(r.total_cogs || 0), 0);
    const totalFees = cogsResult.rows.reduce((s, r) => s + parseFloat(r.total_fees || 0), 0);

    // FX conversion — apply period average rate (GBP → reporting currency)
    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const fx = (n) => ((parseFloat(n) || 0) * fxRate).toFixed(2);

    const netRevenue = parseFloat(row.net_revenue || 0) - parseFloat(refundRow.total_refunded || 0);
    const grossProfit = netRevenue - totalCogs - totalFees;
    const grossMarginPct = netRevenue > 0 ? (grossProfit / netRevenue * 100) : 0;

    res.json({
      ...row,
      gross_revenue:    fx(row.gross_revenue),
      net_revenue:      fx(netRevenue),
      total_discounts:  fx(row.total_discounts),
      avg_order_value:  fx(row.avg_order_value),
      total_refunded:   fx(refundRow.total_refunded),
      total_cogs:       fx(totalCogs),
      gross_profit:     fx(grossProfit),
      gross_margin_pct: grossMarginPct.toFixed(1),
      refund_count:     refundRow.refund_count,
      refund_rate:      row.total_orders > 0 ? ((refundRow.refund_count / row.total_orders) * 100).toFixed(1) : 0,
      reporting_currency: reportingCurrency,
      currency_symbol:  currencySymbol(reportingCurrency),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Revenue over time
app.get('/api/revenue-trend', async (req, res) => {
  const { from, to, period, channel = 'all' } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const trunc = period === 'week' ? 'week' : period === 'month' ? 'month' : period === 'year' ? 'year' : 'day';
  const amazonEnriched = `
    SELECT o.order_date,
      COALESCE(r.gross_sales, o.gross_revenue) / vat_divisor(o.shipping_country) AS gross_revenue,
      COALESCE(r.net_revenue, o.net_revenue) / vat_divisor(o.shipping_country) AS net_revenue,
      o.status
    FROM amazon_orders o
    LEFT JOIN (
      SELECT order_id, SUM(gross_sales)::numeric(12,2) AS gross_sales, SUM(net_revenue)::numeric(12,2) AS net_revenue
      FROM v_sku_revenue WHERE channel = 'amazon' GROUP BY order_id
    ) r ON r.order_id = o.amazon_order_id
  `;
  try {
    let result;
    if (channel === 'all') {
      result = await pool.query(`
        SELECT GREATEST(DATE_TRUNC($1, order_date), $2::date)::date AS period, SUM(gross_revenue)::numeric AS gross_revenue,
          SUM(net_revenue)::numeric AS net_revenue, COUNT(*)::int AS orders
        FROM (
          SELECT order_date, gross_revenue / vat_divisor(shipping_country) AS gross_revenue, net_revenue / vat_divisor(shipping_country) AS net_revenue FROM shopify_orders
          WHERE order_date::date BETWEEN $2 AND $3 AND financial_status != 'voided'
          UNION ALL
          SELECT order_date, gross_revenue, net_revenue FROM (${amazonEnriched}) a
          WHERE order_date::date BETWEEN $2 AND $3 AND status != 'Canceled'
        ) combined GROUP BY 1 ORDER BY 1
      `, [trunc, dateFrom, dateTo]);
    } else if (channel === 'amazon') {
      result = await pool.query(`
        SELECT GREATEST(DATE_TRUNC($1, order_date), $2::date)::date AS period, SUM(gross_revenue)::numeric AS gross_revenue,
          SUM(net_revenue)::numeric AS net_revenue, COUNT(*)::int AS orders
        FROM (${amazonEnriched}) a WHERE order_date::date BETWEEN $2 AND $3 AND status != 'Canceled'
        GROUP BY 1 ORDER BY 1
      `, [trunc, dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        SELECT GREATEST(DATE_TRUNC($1, order_date), $2::date)::date AS period, SUM(gross_revenue / vat_divisor(shipping_country))::numeric AS gross_revenue,
          SUM(net_revenue / vat_divisor(shipping_country))::numeric AS net_revenue, COUNT(*)::int AS orders
        FROM shopify_orders WHERE order_date::date BETWEEN $2 AND $3 AND financial_status != 'voided'
        GROUP BY 1 ORDER BY 1
      `, [trunc, dateFrom, dateTo]);
    }

    // Refunds attributed by refund_date, grouped to the same period granularity,
    // subtracted from net_revenue (same logic as /api/summary).
    let refundResult;
    if (channel === 'amazon' || channel === 'shopify') {
      refundResult = await pool.query(`
        SELECT GREATEST(DATE_TRUNC($1, refund_date), $3::date)::date AS period, COALESCE(SUM(amount_refunded / vat_divisor(shipping_country)), 0)::numeric AS total_refunded
        FROM v_refunds_by_date WHERE channel = $2 AND refund_date::date BETWEEN $3 AND $4
        GROUP BY 1
      `, [trunc, channel, dateFrom, dateTo]);
    } else {
      refundResult = await pool.query(`
        SELECT GREATEST(DATE_TRUNC($1, refund_date), $2::date)::date AS period, COALESCE(SUM(amount_refunded / vat_divisor(shipping_country)), 0)::numeric AS total_refunded
        FROM v_refunds_by_date WHERE refund_date::date BETWEEN $2 AND $3
        GROUP BY 1
      `, [trunc, dateFrom, dateTo]);
    }
    const refundsByPeriod = {};
    for (const r of refundResult.rows) {
      refundsByPeriod[r.period.toISOString().split('T')[0]] = parseFloat(r.total_refunded || 0);
    }

    // FX conversion — use period average rate
    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);

    const rows = result.rows.map(r => {
      const key = r.period.toISOString().split('T')[0];
      const refunds = refundsByPeriod[key] || 0;
      const netRevenue = parseFloat(r.net_revenue || 0) - refunds;
      return {
        ...r,
        gross_revenue: (parseFloat(r.gross_revenue || 0) * fxRate).toFixed(2),
        net_revenue:   (netRevenue * fxRate).toFixed(2),
        refunds:       (refunds * fxRate).toFixed(2),
      };
    });
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Gateway / Payout split
app.get('/api/gateway-split', async (req, res) => {
  const { from, to, channel = 'all' } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  // Amazon: net_transfer from amazon_payouts by fund_transfer_date (actual payout)
  // Shopify: net_revenue from shopify_orders by order_date (order revenue)
  try {
    let result;
    if (channel === 'amazon') {
      result = await pool.query(`
        SELECT 'Amazon Payout' AS gateway, COUNT(*)::int AS orders, SUM(net_transfer)::numeric AS revenue
        FROM amazon_payouts
        WHERE fund_transfer_date::date BETWEEN $1 AND $2
        AND net_transfer != 0
      `, [dateFrom, dateTo]);
    } else if (channel === 'all') {
      result = await pool.query(`
        SELECT gateway, SUM(orders)::int AS orders, SUM(revenue)::numeric AS revenue FROM (
          SELECT gateway, COUNT(*)::int AS orders, SUM(net_revenue / vat_divisor(shipping_country))::numeric AS revenue
          FROM shopify_orders WHERE order_date::date BETWEEN $1 AND $2 AND financial_status != 'voided'
          GROUP BY gateway
          UNION ALL
          -- amazon_payouts is a settlement batch, not order-level - no shipping_country to key
          -- VAT stripping off, so left unstripped here (known gap - see PR notes).
          SELECT 'Amazon Payout' AS gateway, COUNT(*)::int AS orders, SUM(net_transfer)::numeric AS revenue
          FROM amazon_payouts
          WHERE fund_transfer_date::date BETWEEN $1 AND $2
          AND net_transfer != 0
        ) combined GROUP BY gateway ORDER BY revenue DESC
      `, [dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        SELECT gateway, COUNT(*)::int AS orders, SUM(net_revenue / vat_divisor(shipping_country))::numeric AS revenue
        FROM shopify_orders WHERE order_date::date BETWEEN $1 AND $2 AND financial_status != 'voided'
        GROUP BY gateway ORDER BY revenue DESC
      `, [dateFrom, dateTo]);
    }

    // FX conversion — use period average rate (GBP → reporting currency)
    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const rows = result.rows.map(r => ({ ...r, revenue: (parseFloat(r.revenue || 0) * fxRate).toFixed(2) }));
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Gateway trend over time
app.get('/api/gateway-trend', async (req, res) => {
  const { from, to, period, channel = 'all' } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const trunc = period === 'week' ? 'week' : period === 'month' ? 'month' : period === 'year' ? 'year' : 'day';
  try {
    let result;
    if (channel === 'amazon') {
      result = await pool.query(`
        SELECT GREATEST(DATE_TRUNC($1, fund_transfer_date), $2::date)::date AS period, 'Amazon Payout' AS gateway, SUM(net_transfer)::numeric AS revenue
        FROM amazon_payouts
        WHERE fund_transfer_date::date BETWEEN $2 AND $3 AND net_transfer != 0
        GROUP BY 1 ORDER BY 1
      `, [trunc, dateFrom, dateTo]);
    } else if (channel === 'all') {
      result = await pool.query(`
        SELECT period, gateway, SUM(revenue)::numeric AS revenue FROM (
          SELECT GREATEST(DATE_TRUNC($1, order_date), $2::date)::date AS period, gateway, net_revenue / vat_divisor(shipping_country) AS revenue FROM shopify_orders
          WHERE order_date::date BETWEEN $2 AND $3 AND financial_status != 'voided'
          UNION ALL
          SELECT GREATEST(DATE_TRUNC($1, fund_transfer_date), $2::date)::date AS period, 'Amazon Payout' AS gateway, net_transfer AS revenue
          FROM amazon_payouts
          WHERE fund_transfer_date::date BETWEEN $2 AND $3 AND net_transfer != 0
        ) combined GROUP BY 1, 2 ORDER BY 1, 2
      `, [trunc, dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        SELECT GREATEST(DATE_TRUNC($1, order_date), $2::date)::date AS period, gateway, SUM(net_revenue / vat_divisor(shipping_country))::numeric AS revenue
        FROM shopify_orders WHERE order_date::date BETWEEN $2 AND $3 AND financial_status != 'voided'
        GROUP BY 1, 2 ORDER BY 1, 2
      `, [trunc, dateFrom, dateTo]);
    }

    // FX conversion — use period average rate (GBP → reporting currency)
    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const rows = result.rows.map(r => ({ ...r, revenue: (parseFloat(r.revenue || 0) * fxRate).toFixed(2) }));
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Shopify fees
// NOTE on VAT: shopify_payouts is a payout-batch summary with no order-level join, so there's
// no shipping_country to key sales-side VAT stripping off (same structural gap as amazon_payouts
// in /api/gateway-split above). fees IS fee-side and gets vat_divisor_seller() since that's a
// single account-wide rate with no country dependency; gross_sales/refunds/net_payouts are left
// unstripped pending a schema change to link payouts back to orders.
app.get('/api/fees', async (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query(`
      SELECT SUM(fees / vat_divisor_seller())::numeric AS total_fees, SUM(charges_gross)::numeric AS gross_sales,
        SUM(refunds)::numeric AS total_refunds, SUM(amount)::numeric AS net_payouts
      FROM shopify_payouts WHERE payout_date BETWEEN $1 AND $2 AND status = 'paid'
    `, [dateFrom, dateTo]);
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Recent orders
app.get('/api/recent-orders', async (req, res) => {
  const { limit, channel = 'all' } = req.query;
  // Order-level rollup of v_sku_revenue for Amazon, so gross/net reflect
  // the SKU-level gross-to-net bridge (incl. list-price fallback for Pending orders)
  const amazonRevenueRollup = `
    SELECT order_id, SUM(gross_sales)::numeric(12,2) AS gross_sales, SUM(net_revenue)::numeric(12,2) AS net_revenue,
      BOOL_OR(is_estimated_price) AS is_estimated_price
    FROM v_sku_revenue WHERE channel = 'amazon' GROUP BY order_id
  `;
  try {
    let result;
    if (channel === 'amazon') {
      result = await pool.query(`
        SELECT o.amazon_order_id AS shopify_order_number, o.order_date, o.status AS financial_status,
          o.fulfillment_channel AS fulfillment_status, COALESCE(r.gross_sales, o.gross_revenue) / vat_divisor(o.shipping_country) AS gross_revenue,
          COALESCE(r.net_revenue, o.net_revenue) / vat_divisor(o.shipping_country) AS net_revenue, COALESCE(o.total_refunded, 0) / vat_divisor(o.shipping_country) AS total_refunded,
          'Amazon' AS gateway, o.shipping_country, 'amazon' AS channel, COALESCE(r.is_estimated_price, false) AS is_estimated_price
        FROM amazon_orders o
        LEFT JOIN (${amazonRevenueRollup}) r ON r.order_id = o.amazon_order_id
        WHERE o.status != 'Canceled' ORDER BY o.order_date DESC LIMIT $1
      `, [limit || 10]);
    } else if (channel === 'all') {
      result = await pool.query(`
        SELECT * FROM (
          SELECT shopify_order_number::text AS shopify_order_number, order_date, financial_status, fulfillment_status,
            gross_revenue / vat_divisor(shipping_country) AS gross_revenue, net_revenue / vat_divisor(shipping_country) AS net_revenue,
            total_refunded / vat_divisor(shipping_country) AS total_refunded, gateway, shipping_country, 'shopify' AS channel, false AS is_estimated_price
          FROM shopify_orders WHERE financial_status != 'voided'
          UNION ALL
          SELECT o.amazon_order_id, o.order_date, o.status AS financial_status, o.fulfillment_channel AS fulfillment_status,
            COALESCE(r.gross_sales, o.gross_revenue) / vat_divisor(o.shipping_country) AS gross_revenue, COALESCE(r.net_revenue, o.net_revenue) / vat_divisor(o.shipping_country) AS net_revenue,
            COALESCE(o.total_refunded, 0) / vat_divisor(o.shipping_country) AS total_refunded, 'Amazon' AS gateway, o.shipping_country, 'amazon' AS channel,
            COALESCE(r.is_estimated_price, false) AS is_estimated_price
          FROM amazon_orders o
          LEFT JOIN (${amazonRevenueRollup}) r ON r.order_id = o.amazon_order_id
          WHERE o.status != 'Canceled'
        ) combined ORDER BY order_date DESC LIMIT $1
      `, [limit || 10]);
    } else {
      result = await pool.query(`
        SELECT shopify_order_number, order_date, financial_status, fulfillment_status,
          gross_revenue / vat_divisor(shipping_country) AS gross_revenue, net_revenue / vat_divisor(shipping_country) AS net_revenue,
          total_refunded / vat_divisor(shipping_country) AS total_refunded, gateway, shipping_country, 'shopify' AS channel, false AS is_estimated_price
        FROM shopify_orders WHERE financial_status != 'voided' ORDER BY order_date DESC LIMIT $1
      `, [limit || 10]);
    }

    // FX conversion — same period-average-rate pattern as every other revenue endpoint
    const reportingCurrency = await getReportingCurrency();
    const dateFrom = result.rows.length ? result.rows[result.rows.length - 1].order_date : new Date().toISOString().split('T')[0];
    const dateTo = result.rows.length ? result.rows[0].order_date : new Date().toISOString().split('T')[0];
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const rows = result.rows.map(r => ({
      ...r,
      gross_revenue: (parseFloat(r.gross_revenue || 0) * fxRate).toFixed(2),
      net_revenue: (parseFloat(r.net_revenue || 0) * fxRate).toFixed(2),
      total_refunded: (parseFloat(r.total_refunded || 0) * fxRate).toFixed(2),
    }));
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Refunds attributed by the date the refund was posted (not order date)
app.get('/api/refunds-by-date', async (req, res) => {
  const { from, to, channel = 'all', limit } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  try {
    let result;
    if (channel === 'amazon' || channel === 'shopify') {
      result = await pool.query(`
        SELECT channel, order_id, sku, refund_date, amount_refunded / vat_divisor(shipping_country) AS amount_refunded, quantity_refunded
        FROM v_refunds_by_date
        WHERE channel = $1 AND refund_date::date BETWEEN $2 AND $3
        ORDER BY refund_date DESC LIMIT $4
      `, [channel, dateFrom, dateTo, limit || 20]);
    } else {
      result = await pool.query(`
        SELECT channel, order_id, sku, refund_date, amount_refunded / vat_divisor(shipping_country) AS amount_refunded, quantity_refunded
        FROM v_refunds_by_date
        WHERE refund_date::date BETWEEN $1 AND $2
        ORDER BY refund_date DESC LIMIT $3
      `, [dateFrom, dateTo, limit || 20]);
    }
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});


// Sales by country — order-line level aggregation across all SKUs, for the Sales Summary world map.
// Also pulls fees/COGS (for gross margin %) and refunds (for refund %) per country, for the map's
// hover tooltip — same flat-COGS approach as /api/product-breakdown/countries, just without a SKU filter.
app.get('/api/sales-by-country', async (req, res) => {
  const { from, to, channel = 'all' } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  try {
    let result;
    if (channel === 'shopify') {
      result = await pool.query(`
        SELECT
          COALESCE(so.shipping_country, 'Unknown') AS country,
          SUM(sol.quantity)::int AS units_sold,
          SUM((sol.unit_price * sol.quantity) / vat_divisor(so.shipping_country))::numeric(12,2) AS gross_sales,
          SUM(((sol.unit_price - sol.discount_per_unit) * sol.quantity) / vat_divisor(so.shipping_country))::numeric(12,2) AS net_revenue,
          0::numeric AS total_fees,
          SUM(sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0))::numeric(12,2) AS total_cogs
        FROM shopify_order_lines sol
        JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
        LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
        LEFT JOIN LATERAL (
          SELECT ce0.unit_cogs * COALESCE(fx.rate, 1) AS unit_cogs
          FROM cogs_entries ce0
          LEFT JOIN LATERAL (
            SELECT rate FROM exchange_rates
            WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
              AND date <= sol.order_date::date
            ORDER BY date DESC LIMIT 1
          ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
          WHERE ce0.sku = sol.sku AND ce0.effective_from <= sol.order_date::date
            AND (ce0.effective_to IS NULL OR ce0.effective_to >= sol.order_date::date)
          ORDER BY ce0.effective_from DESC LIMIT 1
        ) ce ON true
        WHERE sol.order_date::date BETWEEN $1 AND $2
        GROUP BY 1
      `, [dateFrom, dateTo]);
    } else if (channel === 'amazon') {
      result = await pool.query(`
        SELECT
          COALESCE(ao.shipping_country, 'Unknown') AS country,
          SUM(aol.quantity)::int AS units_sold,
          SUM(((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) / vat_divisor(ao.shipping_country))::numeric(12,2) AS gross_sales,
          SUM((((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) - COALESCE(aol.promotion_discount,0)) / vat_divisor(ao.shipping_country))::numeric(12,2) AS net_revenue,
          SUM((COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_commission,0) + COALESCE(aol.fee_digital_services,0) + COALESCE(aol.fee_fixed_closing,0)) / vat_divisor_seller())::numeric(12,2) AS total_fees,
          SUM(aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0))::numeric(12,2) AS total_cogs
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
        LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
        LEFT JOIN LATERAL (
          SELECT ce0.unit_cogs * COALESCE(fx.rate, 1) AS unit_cogs
          FROM cogs_entries ce0
          LEFT JOIN LATERAL (
            SELECT rate FROM exchange_rates
            WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
              AND date <= ao.order_date::date
            ORDER BY date DESC LIMIT 1
          ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
          WHERE ce0.sku = aol.sku AND ce0.effective_from <= ao.order_date::date
            AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
          ORDER BY ce0.effective_from DESC LIMIT 1
        ) ce ON true
        WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
        GROUP BY 1
      `, [dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        SELECT country,
          SUM(units_sold)::int AS units_sold,
          SUM(gross_sales)::numeric(12,2) AS gross_sales,
          SUM(net_revenue)::numeric(12,2) AS net_revenue,
          SUM(total_fees)::numeric(12,2) AS total_fees,
          SUM(total_cogs)::numeric(12,2) AS total_cogs
        FROM (
          SELECT COALESCE(so.shipping_country, 'Unknown') AS country,
            sol.quantity AS units_sold,
            (sol.unit_price * sol.quantity) / vat_divisor(so.shipping_country) AS gross_sales,
            ((sol.unit_price - sol.discount_per_unit) * sol.quantity) / vat_divisor(so.shipping_country) AS net_revenue,
            0 AS total_fees,
            (sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)) AS total_cogs
          FROM shopify_order_lines sol
          JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
          LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
          LEFT JOIN LATERAL (
            SELECT ce0.unit_cogs * COALESCE(fx.rate, 1) AS unit_cogs
            FROM cogs_entries ce0
            LEFT JOIN LATERAL (
              SELECT rate FROM exchange_rates
              WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
                AND date <= sol.order_date::date
              ORDER BY date DESC LIMIT 1
            ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
            WHERE ce0.sku = sol.sku AND ce0.effective_from <= sol.order_date::date
              AND (ce0.effective_to IS NULL OR ce0.effective_to >= sol.order_date::date)
            ORDER BY ce0.effective_from DESC LIMIT 1
          ) ce ON true
          WHERE sol.order_date::date BETWEEN $1 AND $2
          UNION ALL
          SELECT COALESCE(ao.shipping_country, 'Unknown') AS country,
            aol.quantity AS units_sold,
            ((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) / vat_divisor(ao.shipping_country) AS gross_sales,
            (((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) - COALESCE(aol.promotion_discount,0)) / vat_divisor(ao.shipping_country) AS net_revenue,
            (COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_commission,0) + COALESCE(aol.fee_digital_services,0) + COALESCE(aol.fee_fixed_closing,0)) / vat_divisor_seller() AS total_fees,
            (aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)) AS total_cogs
          FROM amazon_order_lines aol
          JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
          LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
          LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
          LEFT JOIN LATERAL (
            SELECT ce0.unit_cogs * COALESCE(fx.rate, 1) AS unit_cogs
            FROM cogs_entries ce0
            LEFT JOIN LATERAL (
              SELECT rate FROM exchange_rates
              WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
                AND date <= ao.order_date::date
              ORDER BY date DESC LIMIT 1
            ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
            WHERE ce0.sku = aol.sku AND ce0.effective_from <= ao.order_date::date
              AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
            ORDER BY ce0.effective_from DESC LIMIT 1
          ) ce ON true
          WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
        ) combined
        GROUP BY country
      `, [dateFrom, dateTo]);
    }

    // Refunds attributed by refund_date, joined back to the order's shipping_country
    let refundResult;
    if (channel === 'amazon' || channel === 'shopify') {
      refundResult = await pool.query(channel === 'amazon' ? `
        SELECT COALESCE(ao.shipping_country, 'Unknown') AS country, SUM(v.amount_refunded / vat_divisor(ao.shipping_country))::numeric AS total_refunded
        FROM v_refunds_by_date v JOIN amazon_orders ao ON ao.amazon_order_id = v.order_id
        WHERE v.channel = 'amazon' AND v.refund_date::date BETWEEN $1 AND $2
        GROUP BY 1
      ` : `
        SELECT COALESCE(so.shipping_country, 'Unknown') AS country, SUM(v.amount_refunded / vat_divisor(so.shipping_country))::numeric AS total_refunded
        FROM v_refunds_by_date v JOIN shopify_orders so ON so.shopify_order_id::text = v.order_id
        WHERE v.channel = 'shopify' AND v.refund_date::date BETWEEN $1 AND $2
        GROUP BY 1
      `, [dateFrom, dateTo]);
    } else {
      refundResult = await pool.query(`
        SELECT country, SUM(total_refunded)::numeric AS total_refunded FROM (
          SELECT COALESCE(ao.shipping_country, 'Unknown') AS country, v.amount_refunded / vat_divisor(ao.shipping_country) AS total_refunded
          FROM v_refunds_by_date v JOIN amazon_orders ao ON ao.amazon_order_id = v.order_id
          WHERE v.channel = 'amazon' AND v.refund_date::date BETWEEN $1 AND $2
          UNION ALL
          SELECT COALESCE(so.shipping_country, 'Unknown') AS country, v.amount_refunded / vat_divisor(so.shipping_country) AS total_refunded
          FROM v_refunds_by_date v JOIN shopify_orders so ON so.shopify_order_id::text = v.order_id
          WHERE v.channel = 'shopify' AND v.refund_date::date BETWEEN $1 AND $2
        ) combined GROUP BY country
      `, [dateFrom, dateTo]);
    }
    const refundsByCountry = {};
    for (const r of refundResult.rows) refundsByCountry[r.country] = parseFloat(r.total_refunded || 0);

    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const totalGross = result.rows.reduce((s, r) => s + parseFloat(r.gross_sales || 0), 0) * fxRate;

    const rows = result.rows.map(r => {
      const gross = parseFloat(r.gross_sales || 0) * fxRate;
      const netBeforeRefunds = parseFloat(r.net_revenue || 0) * fxRate;
      const refunded = (refundsByCountry[r.country] || 0) * fxRate;
      const netSales = netBeforeRefunds - refunded;
      const fees = parseFloat(r.total_fees || 0) * fxRate;
      const cogs = parseFloat(r.total_cogs || 0) * fxRate;
      const grossMargin = netSales - fees - cogs;
      // Divide by net sales normally, but fall back to gross sales when refunds have driven net
      // to zero/negative — otherwise a heavily-refunded country would silently show "0%" margin
      // instead of the real (likely negative) figure.
      const marginBase = netSales > 0 ? netSales : gross;
      const marginPct = marginBase > 0 ? (grossMargin / marginBase * 100) : 0;
      const refundPct = gross > 0 ? (refunded / gross * 100) : 0;
      return {
        country: r.country,
        units_sold: parseInt(r.units_sold || 0, 10),
        gross_sales: gross.toFixed(2),
        net_revenue: netSales.toFixed(2),
        refund_pct: refundPct.toFixed(1),
        gross_margin_pct: marginPct.toFixed(1),
        pct: totalGross > 0 ? (gross / totalGross * 100).toFixed(1) : '0.0',
      };
    }).sort((a, b) => parseFloat(b.gross_sales) - parseFloat(a.gross_sales));

    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Order type (B2B/B2C, Amazon only) and fulfillment channel (FBA/FBM/Shopify) breakdown
app.get('/api/order-breakdown', async (req, res) => {
  const { from, to, channel = 'all' } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  // Same order-level revenue rollup pattern used by /api/recent-orders
  const amazonRevenueRollup = `
    SELECT order_id, SUM(gross_sales)::numeric(12,2) AS gross_sales, SUM(net_revenue)::numeric(12,2) AS net_revenue
    FROM v_sku_revenue WHERE channel = 'amazon' GROUP BY order_id
  `;
  const amazonEnriched = `
    SELECT o.amazon_order_id, o.order_date, o.status, o.is_business_order, o.fulfillment_channel,
      COALESCE(r.gross_sales, o.gross_revenue) / vat_divisor(o.shipping_country) AS gross_revenue,
      COALESCE(r.net_revenue, o.net_revenue) / vat_divisor(o.shipping_country) AS net_revenue
    FROM amazon_orders o
    LEFT JOIN (${amazonRevenueRollup}) r ON r.order_id = o.amazon_order_id
  `;
  try {
    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const fx = (n) => (parseFloat(n || 0) * fxRate);

    let orderType = [];
    let fulfillment = [];

    if (channel !== 'shopify') {
      const r = await pool.query(`
        SELECT is_business_order, COUNT(*)::int AS orders, SUM(gross_revenue)::numeric AS gross_revenue, SUM(net_revenue)::numeric AS net_revenue
        FROM (${amazonEnriched}) a WHERE order_date::date BETWEEN $1 AND $2 AND status != 'Canceled'
        GROUP BY is_business_order
      `, [dateFrom, dateTo]);
      orderType = r.rows.map(row => ({
        label: row.is_business_order ? 'Business (B2B)' : 'Consumer (B2C)',
        orders: row.orders,
        gross_revenue: fx(row.gross_revenue).toFixed(2),
        net_revenue: fx(row.net_revenue).toFixed(2),
      }));

      const f = await pool.query(`
        SELECT fulfillment_channel, COUNT(*)::int AS orders, SUM(gross_revenue)::numeric AS gross_revenue, SUM(net_revenue)::numeric AS net_revenue
        FROM (${amazonEnriched}) a WHERE order_date::date BETWEEN $1 AND $2 AND status != 'Canceled'
        GROUP BY fulfillment_channel
      `, [dateFrom, dateTo]);
      fulfillment = f.rows.map(row => ({
        label: row.fulfillment_channel === 'AFN' ? 'FBA' : row.fulfillment_channel === 'MFN' ? 'FBM' : (row.fulfillment_channel || 'Unknown'),
        orders: row.orders,
        gross_revenue: fx(row.gross_revenue).toFixed(2),
        net_revenue: fx(row.net_revenue).toFixed(2),
      }));
    }

    if (channel !== 'amazon') {
      const r = await pool.query(`
        SELECT COUNT(*)::int AS orders, SUM(gross_revenue / vat_divisor(shipping_country))::numeric AS gross_revenue, SUM(net_revenue / vat_divisor(shipping_country))::numeric AS net_revenue
        FROM shopify_orders WHERE order_date::date BETWEEN $1 AND $2 AND financial_status != 'voided'
      `, [dateFrom, dateTo]);
      const row = r.rows[0];
      if (row && row.orders > 0) {
        fulfillment.push({
          label: 'Shopify',
          orders: row.orders,
          gross_revenue: fx(row.gross_revenue).toFixed(2),
          net_revenue: fx(row.net_revenue).toFixed(2),
        });
      }
    }

    const order = { FBA: 0, FBM: 1, Shopify: 2 };
    fulfillment.sort((a, b) => (order[a.label] ?? 9) - (order[b.label] ?? 9));

    res.json({ order_type: orderType, fulfillment, currency_symbol: currencySymbol(reportingCurrency) });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// P&L — account-wide monthly/weekly/etc. profit & loss, Amazon only (account-level fees
// like subscription/storage are Amazon-specific — see amazon_account_fees, populated by
// the amazon-spapi-proxy finances sync). Mirrors the Product Breakdown P&L panel's own
// Gross Sales -> Discounts -> Refunds -> Net Sales -> COGS -> Fees -> Gross Margin -> PPC
// -> Product Contribution structure, but grouped by period across all SKUs instead of one.
app.get('/api/pnl', async (req, res) => {
  const { from, to, group = 'month', channel = 'all', brand, parent_asin, search, fulfillment, order_type } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const trunc = ['day', 'week', 'month', 'quarter', 'year'].includes(group) ? group : 'month';
  // Fulfillment (FBA/FBM) and order type (B2B/B2C) are Amazon-only concepts with no Shopify
  // equivalent — the client only shows these toggles when channel === 'amazon', but guard here
  // too so a stray query param can't silently apply an Amazon-only filter to Shopify order lines.
  const includeAmazon = channel !== 'shopify';
  const includeShopify = channel !== 'amazon';

  const esc = (s) => s.replace(/'/g, "''");
  const brandFilter = brand ? `AND sp.brand = '${esc(brand)}'` : '';
  const parentFilter = parent_asin ? `AND sp.parent_asin = '${esc(parent_asin)}'` : '';
  const searchFilterAmazon = search ? `AND (aol.sku ILIKE '%${esc(search)}%' OR aol.asin ILIKE '%${esc(search)}%' OR ao.amazon_order_id ILIKE '%${esc(search)}%')` : '';
  const searchFilterShopify = search ? `AND (sol.sku ILIKE '%${esc(search)}%' OR so.shopify_order_number::text ILIKE '%${esc(search)}%')` : '';
  const fulfillmentFilter = includeAmazon && fulfillment === 'FBA' ? `AND ao.fulfillment_channel = 'AFN'` : includeAmazon && fulfillment === 'FBM' ? `AND ao.fulfillment_channel = 'MFN'` : '';
  const orderTypeFilter = includeAmazon && order_type === 'B2B' ? `AND ao.is_business_order = true` : includeAmazon && order_type === 'B2C' ? `AND ao.is_business_order = false` : '';

  try {
    // Order-line level: units, gross sales, discounts, itemized COGS, order-line fees — grouped by period.
    // COGS formula matches the P&L breakdown panel exactly (itemized standard/freight/demurrage/quality/other
    // with cogs_entries -> sku_parameters -> flat unit_cogs fallback), not the flat shortcut used elsewhere.
    //
    // Amazon and Shopify order lines are unioned at per-line granularity (not pre-aggregated per
    // branch) so a single outer GROUP BY produces correct period totals across both channels.
    // Shopify order lines have no Amazon-style per-line fees (commission, FBA fulfillment, etc.) —
    // those come through separately for Shopify via the MCF fee line below — so they're 0 here.
    const amazonLinesBranch = `
      SELECT
        aol.quantity AS units_sold,
        (((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) / vat_divisor(ao.shipping_country))::numeric(12,2) AS gross_sales,
        (COALESCE(aol.promotion_discount,0) / vat_divisor(ao.shipping_country))::numeric(12,2) AS total_discounts,
        (aol.quantity * COALESCE(
          NULLIF(ce.cogs_standard, 0), NULLIF(sp.cogs_standard, 0),
          CASE WHEN COALESCE(ce.cogs_standard,0)+COALESCE(ce.cogs_freight,0)+COALESCE(ce.cogs_demurrage,0)+COALESCE(ce.cogs_quality,0)+COALESCE(ce.cogs_other,0) = 0
            AND COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
            THEN COALESCE(ce.unit_cogs, sp.unit_cogs, 0) ELSE 0 END, 0)
        )::numeric(12,2) AS cogs_standard,
        (aol.quantity * COALESCE(NULLIF(ce.cogs_freight,   0), NULLIF(sp.cogs_freight,   0), 0))::numeric(12,2) AS cogs_freight,
        (aol.quantity * COALESCE(NULLIF(ce.cogs_demurrage, 0), NULLIF(sp.cogs_demurrage, 0), 0))::numeric(12,2) AS cogs_demurrage,
        (aol.quantity * COALESCE(NULLIF(ce.cogs_quality,   0), NULLIF(sp.cogs_quality,   0), 0))::numeric(12,2) AS cogs_quality,
        (aol.quantity * COALESCE(NULLIF(ce.cogs_other,     0), NULLIF(sp.cogs_other,     0), 0))::numeric(12,2) AS cogs_other,
        (COALESCE(aol.fee_commission,0) / vat_divisor_seller())::numeric(12,2) AS fee_commission,
        (COALESCE(aol.fee_fba_fulfillment,0) / vat_divisor_seller())::numeric(12,2) AS fee_fba_fulfillment,
        (COALESCE(aol.fee_fixed_closing,0) / vat_divisor_seller())::numeric(12,2) AS fee_fixed_closing,
        (COALESCE(aol.fee_variable_closing,0) / vat_divisor_seller())::numeric(12,2) AS fee_variable_closing,
        (COALESCE(aol.fee_digital_services,0) / vat_divisor_seller())::numeric(12,2) AS fee_digital_services,
        (COALESCE(aol.fee_giftwrap_chargeback,0) / vat_divisor_seller())::numeric(12,2) AS fee_giftwrap,
        (COALESCE(aol.fee_shipping_chargeback,0) / vat_divisor_seller())::numeric(12,2) AS fee_shipping_chargeback,
        GREATEST(DATE_TRUNC('${trunc}', ao.order_date), $1::date)::date AS period
      FROM amazon_order_lines aol
      JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
      LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
      LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
      LEFT JOIN LATERAL (
        -- Itemized COGS fields are entered in cogs_entries.cogs_currency (GBP/USD/EUR); revenue
        -- figures are all GBP, so convert here at the exchange rate on the order date before
        -- these are combined with anything GBP-denominated. No-op when currency is already GBP.
        SELECT
          ce0.cogs_standard  * COALESCE(fx.rate, 1) AS cogs_standard,
          ce0.cogs_freight   * COALESCE(fx.rate, 1) AS cogs_freight,
          ce0.cogs_demurrage * COALESCE(fx.rate, 1) AS cogs_demurrage,
          ce0.cogs_quality   * COALESCE(fx.rate, 1) AS cogs_quality,
          ce0.cogs_other     * COALESCE(fx.rate, 1) AS cogs_other,
          ce0.unit_cogs      * COALESCE(fx.rate, 1) AS unit_cogs
        FROM cogs_entries ce0
        LEFT JOIN LATERAL (
          SELECT rate FROM exchange_rates
          WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
            AND date <= ao.order_date::date
          ORDER BY date DESC LIMIT 1
        ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
        WHERE ce0.sku = aol.sku AND ce0.effective_from <= ao.order_date::date
          AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
        ORDER BY ce0.effective_from DESC LIMIT 1
      ) ce ON true
      WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
        ${brandFilter} ${parentFilter} ${searchFilterAmazon} ${fulfillmentFilter} ${orderTypeFilter}
    `;

    const shopifyLinesBranch = `
      SELECT
        sol.quantity AS units_sold,
        ((sol.unit_price * sol.quantity) / vat_divisor(so.shipping_country))::numeric(12,2) AS gross_sales,
        ((sol.discount_per_unit * sol.quantity) / vat_divisor(so.shipping_country))::numeric(12,2) AS total_discounts,
        (sol.quantity * COALESCE(
          NULLIF(ce.cogs_standard, 0), NULLIF(sp.cogs_standard, 0),
          CASE WHEN COALESCE(ce.cogs_standard,0)+COALESCE(ce.cogs_freight,0)+COALESCE(ce.cogs_demurrage,0)+COALESCE(ce.cogs_quality,0)+COALESCE(ce.cogs_other,0) = 0
            AND COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
            THEN COALESCE(ce.unit_cogs, sp.unit_cogs, 0) ELSE 0 END, 0)
        )::numeric(12,2) AS cogs_standard,
        (sol.quantity * COALESCE(NULLIF(ce.cogs_freight,   0), NULLIF(sp.cogs_freight,   0), 0))::numeric(12,2) AS cogs_freight,
        (sol.quantity * COALESCE(NULLIF(ce.cogs_demurrage, 0), NULLIF(sp.cogs_demurrage, 0), 0))::numeric(12,2) AS cogs_demurrage,
        (sol.quantity * COALESCE(NULLIF(ce.cogs_quality,   0), NULLIF(sp.cogs_quality,   0), 0))::numeric(12,2) AS cogs_quality,
        (sol.quantity * COALESCE(NULLIF(ce.cogs_other,     0), NULLIF(sp.cogs_other,     0), 0))::numeric(12,2) AS cogs_other,
        0::numeric(12,2) AS fee_commission,
        0::numeric(12,2) AS fee_fba_fulfillment,
        0::numeric(12,2) AS fee_fixed_closing,
        0::numeric(12,2) AS fee_variable_closing,
        0::numeric(12,2) AS fee_digital_services,
        0::numeric(12,2) AS fee_giftwrap,
        0::numeric(12,2) AS fee_shipping_chargeback,
        GREATEST(DATE_TRUNC('${trunc}', sol.order_date), $1::date)::date AS period
      FROM shopify_order_lines sol
      JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
      LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
      LEFT JOIN LATERAL (
        SELECT
          ce0.cogs_standard  * COALESCE(fx.rate, 1) AS cogs_standard,
          ce0.cogs_freight   * COALESCE(fx.rate, 1) AS cogs_freight,
          ce0.cogs_demurrage * COALESCE(fx.rate, 1) AS cogs_demurrage,
          ce0.cogs_quality   * COALESCE(fx.rate, 1) AS cogs_quality,
          ce0.cogs_other     * COALESCE(fx.rate, 1) AS cogs_other,
          ce0.unit_cogs      * COALESCE(fx.rate, 1) AS unit_cogs
        FROM cogs_entries ce0
        LEFT JOIN LATERAL (
          SELECT rate FROM exchange_rates
          WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
            AND date <= sol.order_date::date
          ORDER BY date DESC LIMIT 1
        ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
        WHERE ce0.sku = sol.sku AND ce0.effective_from <= sol.order_date::date
          AND (ce0.effective_to IS NULL OR ce0.effective_to >= sol.order_date::date)
        ORDER BY ce0.effective_from DESC LIMIT 1
      ) ce ON true
      WHERE sol.order_date::date BETWEEN $1 AND $2
        ${brandFilter} ${parentFilter} ${searchFilterShopify}
    `;

    const combinedBranches = [
      includeAmazon ? amazonLinesBranch : null,
      includeShopify ? shopifyLinesBranch : null,
    ].filter(Boolean).join(' UNION ALL ');

    const linesResult = await pool.query(`
      WITH combined_lines AS (${combinedBranches})
      SELECT
        period,
        SUM(units_sold)::int AS units_sold,
        SUM(gross_sales)::numeric(12,2) AS gross_sales,
        SUM(total_discounts)::numeric(12,2) AS total_discounts,
        SUM(cogs_standard)::numeric(12,2) AS cogs_standard,
        SUM(cogs_freight)::numeric(12,2) AS cogs_freight,
        SUM(cogs_demurrage)::numeric(12,2) AS cogs_demurrage,
        SUM(cogs_quality)::numeric(12,2) AS cogs_quality,
        SUM(cogs_other)::numeric(12,2) AS cogs_other,
        SUM(fee_commission)::numeric(12,2) AS fee_commission,
        SUM(fee_fba_fulfillment)::numeric(12,2) AS fee_fba_fulfillment,
        SUM(fee_fixed_closing)::numeric(12,2) AS fee_fixed_closing,
        SUM(fee_variable_closing)::numeric(12,2) AS fee_variable_closing,
        SUM(fee_digital_services)::numeric(12,2) AS fee_digital_services,
        SUM(fee_giftwrap)::numeric(12,2) AS fee_giftwrap,
        SUM(fee_shipping_chargeback)::numeric(12,2) AS fee_shipping_chargeback
      FROM combined_lines
      GROUP BY 1 ORDER BY 1
    `, [dateFrom, dateTo]);

    // Refunds, attributed by refund_date (independent of the order population above)
    const refundsChannelFilter = channel === 'amazon' ? `AND channel = 'amazon'` : channel === 'shopify' ? `AND channel = 'shopify'` : '';
    const refundsResult = await pool.query(`
      SELECT GREATEST(DATE_TRUNC('${trunc}', refund_date), $1::date)::date AS period, SUM(amount_refunded / vat_divisor(shipping_country))::numeric AS total_refunded, SUM(quantity_refunded)::int AS units_refunded
      FROM v_refunds_by_date WHERE refund_date::date BETWEEN $1 AND $2 ${refundsChannelFilter}
      GROUP BY 1
    `, [dateFrom, dateTo]);

    // Commission reversal / refund admin fee, attributed by refund_date (same table/date basis
    // as refundsResult above). Amazon-only — Shopify has no equivalent. Kept as a separate query
    // from v_refunds_by_date (a view we don't have DDL access to alter) since these two columns
    // only exist on amazon_order_line_refunds.
    //
    // Amazon sometimes posts the monetary refund before the commission-reversal fee event
    // settles (fee_commission_refunded/fee_refund_admin still 0 despite a real amount_refunded).
    // For those rows, estimate from the original per-unit commission on the order line, prorated
    // by quantity refunded, with the admin fee at this account's own observed settled ratio
    // (~20% of the reversed commission — Amazon's admin cut on refunds).
    const refundFeesResult = includeAmazon ? await pool.query(`
      SELECT GREATEST(DATE_TRUNC('${trunc}', olr.refund_date), $1::date)::date AS period,
        SUM((CASE WHEN olr.fee_commission_refunded > 0 THEN olr.fee_commission_refunded
          ELSE COALESCE(aol.fee_commission / NULLIF(aol.quantity, 0), 0) * olr.quantity_refunded END) / vat_divisor_seller())::numeric AS fee_commission_refunded,
        SUM((CASE WHEN olr.fee_refund_admin > 0 THEN olr.fee_refund_admin
          ELSE COALESCE(aol.fee_commission / NULLIF(aol.quantity, 0), 0) * olr.quantity_refunded * 0.2 END) / vat_divisor_seller())::numeric AS fee_refund_admin,
        SUM((CASE WHEN olr.fee_digital_services_refunded > 0 THEN olr.fee_digital_services_refunded
          ELSE COALESCE(aol.fee_digital_services / NULLIF(aol.quantity, 0), 0) * olr.quantity_refunded END) / vat_divisor_seller())::numeric AS fee_digital_services_refunded,
        BOOL_OR(olr.amount_refunded > 0 AND COALESCE(olr.fee_commission_refunded, 0) = 0) AS has_estimated
      FROM amazon_order_line_refunds olr
      LEFT JOIN amazon_order_lines aol ON aol.amazon_order_id = olr.amazon_order_id AND aol.sku = olr.sku
      WHERE olr.refund_date::date BETWEEN $1 AND $2
      GROUP BY 1
    `, [dateFrom, dateTo]) : { rows: [] };

    // COGS credit-back for genuine physical returns — priced at the COGS rate active on the
    // ORIGINAL order date (reversing at the same cost basis it was recorded at), but attributed
    // to the matching REFUND's date rather than the physical return_date, so it lands in the
    // same period as the revenue reversal it corresponds to (matches refundsResult above). Each
    // return row is matched to its nearest-in-time refund event on the same order/sku (refund
    // usually precedes the physical return by ~1-2 weeks in this account, but not always, so
    // "nearest" rather than "most recent prior"). A refund alone does NOT credit COGS here —
    // only a matching row in amazon_customer_returns (Amazon's FBA Customer Returns report)
    // does, since a refund only reverses revenue and doesn't mean the unit physically came back.
    const returnsCogsResult = includeAmazon ? await pool.query(`
      SELECT GREATEST(DATE_TRUNC('${trunc}', COALESCE(rf.refund_date, acr.return_date)), $1::date)::date AS period,
        SUM(acr.quantity * (
          COALESCE(
            NULLIF(ce.cogs_standard, 0), NULLIF(sp.cogs_standard, 0),
            CASE WHEN COALESCE(ce.cogs_standard,0)+COALESCE(ce.cogs_freight,0)+COALESCE(ce.cogs_demurrage,0)+COALESCE(ce.cogs_quality,0)+COALESCE(ce.cogs_other,0) = 0
              AND COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
              THEN COALESCE(ce.unit_cogs, sp.unit_cogs, 0) ELSE 0 END, 0)
          + COALESCE(NULLIF(ce.cogs_freight,   0), NULLIF(sp.cogs_freight,   0), 0)
          + COALESCE(NULLIF(ce.cogs_demurrage, 0), NULLIF(sp.cogs_demurrage, 0), 0)
          + COALESCE(NULLIF(ce.cogs_quality,   0), NULLIF(sp.cogs_quality,   0), 0)
          + COALESCE(NULLIF(ce.cogs_other,     0), NULLIF(sp.cogs_other,     0), 0)
        ))::numeric AS total_cogs_returned
      FROM amazon_customer_returns acr
      JOIN amazon_orders ao ON ao.amazon_order_id = acr.amazon_order_id
      LEFT JOIN sku_parameters sp ON sp.sku = acr.sku
      LEFT JOIN LATERAL (
        SELECT olr.refund_date FROM amazon_order_line_refunds olr
        WHERE olr.amazon_order_id = acr.amazon_order_id AND olr.sku = acr.sku
        ORDER BY ABS(EXTRACT(EPOCH FROM (olr.refund_date - acr.return_date::timestamptz))) ASC
        LIMIT 1
      ) rf ON true
      LEFT JOIN LATERAL (
        SELECT
          ce0.cogs_standard  * COALESCE(fx.rate, 1) AS cogs_standard,
          ce0.cogs_freight   * COALESCE(fx.rate, 1) AS cogs_freight,
          ce0.cogs_demurrage * COALESCE(fx.rate, 1) AS cogs_demurrage,
          ce0.cogs_quality   * COALESCE(fx.rate, 1) AS cogs_quality,
          ce0.cogs_other     * COALESCE(fx.rate, 1) AS cogs_other,
          ce0.unit_cogs      * COALESCE(fx.rate, 1) AS unit_cogs
        FROM cogs_entries ce0
        LEFT JOIN LATERAL (
          SELECT rate FROM exchange_rates
          WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
            AND date <= ao.order_date::date
          ORDER BY date DESC LIMIT 1
        ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
        WHERE ce0.sku = acr.sku
          AND ce0.effective_from <= ao.order_date::date
          AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
        ORDER BY ce0.effective_from DESC LIMIT 1
      ) ce ON true
      WHERE COALESCE(rf.refund_date::date, acr.return_date) BETWEEN $1 AND $2 ${brandFilter} ${parentFilter} ${fulfillmentFilter} ${orderTypeFilter}
      GROUP BY 1
    `, [dateFrom, dateTo]) : { rows: [] };

    // PPC spend, Amazon Ads only
    const ppcResult = await pool.query(`
      SELECT GREATEST(DATE_TRUNC('${trunc}', report_date), $1::date)::date AS period, SUM(cost / vat_divisor_seller())::numeric AS ppc_cost, SUM(units_sold_clicks_14d)::int AS ppc_units
      FROM amazon_ppc_product_performance WHERE report_date BETWEEN $1 AND $2
      GROUP BY 1
    `, [dateFrom, dateTo]);

    // Account-level fees (subscription, storage, coupons, etc.) — itemized by whatever fee_type
    // Amazon actually reports, rather than a hardcoded row list, since these categories are only
    // as good as what's been synced via amazon-spapi-proxy's finances job. Adjustment-type events
    // (inventory reimbursements/disposals) are kept in their own bucket, matching the reference
    // P&L's separate "Adjustments" line rather than being folded into "Fees". ReserveDebit and
    // ReserveCredit are excluded entirely here (at the SQL level) — they're a rolling cash-flow
    // timing mechanism (Amazon holding back and releasing settlement funds against future
    // returns/risk), not a real gain or loss, so they don't belong on an accrual P&L. They'll
    // surface on the Cash Flow page once that's built out. FBALongTermStorageFee is also
    // excluded here — Amazon's Financial Events only carry a settlement (posted_date) for this
    // fee, not the inventory-age snapshot date it was actually calculated from, so it's sourced
    // instead from amazon_ltsf_charges (keyed by snapshot_date) below and merged back in.
    // Adjustment-sourced rows (inventory reimbursements/disposals compensation) are NOT run
    // through vat_divisor_seller() - they're Amazon paying the seller back, not a fee charge, so
    // VAT-on-fees doesn't apply to them the way it does to Commission/Storage/Subscription/etc.
    const accountFeesResult = await pool.query(`
      SELECT GREATEST(DATE_TRUNC('${trunc}', posted_date), $1::date)::date AS period, event_source, fee_type,
        SUM(CASE WHEN event_source = 'Adjustment' THEN amount ELSE amount / vat_divisor_seller() END)::numeric AS amount
      FROM amazon_account_fees WHERE posted_date::date BETWEEN $1 AND $2
        AND fee_type NOT IN ('ReserveDebit', 'ReserveCredit', 'FBALongTermStorageFee')
      GROUP BY 1, 2, 3
    `, [dateFrom, dateTo]);

    // FBA Long-Term Storage Fee, sourced by snapshot_date (when the fee was actually accrued,
    // per the monthly inventory-age snapshot) rather than posted_date (when Amazon settled it —
    // sometimes a full month or more later). Synced separately via amazon-spapi-proxy's
    // /sync-ltsf endpoint, which pulls Amazon's Reports API "FBA Long-Term Storage Fee Charges"
    // report into amazon_ltsf_charges. Merged into accountFeesByPeriod/feeTypeTotals below so it
    // flows through the same itemized-fees display and total logic as every other fee type.
    const ltsfResult = await pool.query(`
      SELECT GREATEST(DATE_TRUNC('${trunc}', snapshot_date), $1::date)::date AS period, SUM(amount / vat_divisor_seller())::numeric AS amount
      FROM amazon_ltsf_charges WHERE snapshot_date BETWEEN $1 AND $2
      GROUP BY 1
    `, [dateFrom, dateTo]);

    // MCF (Multi-Channel Fulfillment) fees — Amazon charges the account to fulfil a Shopify
    // order out of FBA inventory. The fee itself comes from Amazon's Financial Events (same
    // sync as the other account-level fees), so it's a product-attributable Amazon cost even
    // though the underlying order is a Shopify order — shown as its own line under Fees,
    // grouped independently of the Amazon order-line filters above (fulfillment/order_type/
    // search/brand don't apply to a Shopify-side order).
    const mcfResult = await pool.query(`
      SELECT GREATEST(DATE_TRUNC('${trunc}', fee_date), $1::date)::date AS period, SUM(fee_amount / vat_divisor_seller())::numeric AS mcf_fees
      FROM amazon_mcf_fees WHERE fee_date::date BETWEEN $1 AND $2
      GROUP BY 1
    `, [dateFrom, dateTo]);

    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const fx = (n) => (parseFloat(n || 0) * fxRate);

    // Index refunds/PPC/MCF by period key for merging
    const refundsByPeriod = {};
    const unitsRefundedByPeriod = {};
    for (const r of refundsResult.rows) {
      const key = r.period.toISOString().split('T')[0];
      refundsByPeriod[key] = parseFloat(r.total_refunded || 0);
      unitsRefundedByPeriod[key] = parseInt(r.units_refunded || 0, 10);
    }
    const refundFeesByPeriod = {};
    for (const r of refundFeesResult.rows) {
      const key = r.period.toISOString().split('T')[0];
      refundFeesByPeriod[key] = {
        commission_refunded: parseFloat(r.fee_commission_refunded || 0),
        refund_admin_fee: parseFloat(r.fee_refund_admin || 0),
        digital_services_refunded: parseFloat(r.fee_digital_services_refunded || 0),
      };
    }
    const returnsCogsByPeriod = {};
    for (const r of returnsCogsResult.rows) {
      returnsCogsByPeriod[r.period.toISOString().split('T')[0]] = parseFloat(r.total_cogs_returned || 0);
    }
    const ppcByPeriod = {};
    const ppcUnitsByPeriod = {};
    for (const r of ppcResult.rows) {
      const key = r.period.toISOString().split('T')[0];
      ppcByPeriod[key] = parseFloat(r.ppc_cost || 0);
      ppcUnitsByPeriod[key] = parseInt(r.ppc_units || 0, 10);
    }
    const mcfByPeriod = {};
    for (const r of mcfResult.rows) mcfByPeriod[r.period.toISOString().split('T')[0]] = parseFloat(r.mcf_fees || 0);

    // Account fees: group by period, split into (a) named fee_type rows for display and
    // (b) itemized Adjustment rows by fee_type (e.g. ReserveDebit, WAREHOUSE_LOST,
    // REVERSAL_REIMBURSEMENT), per period. Also track fee_type totals across the whole
    // range so the UI can list only the categories that actually have data.
    const accountFeesByPeriod = {}; // { period: { [feeType]: amount } }
    const adjustmentsByPeriod = {}; // { period: amount } — scalar total, kept for OPEX math
    const adjustmentItemsByPeriod = {}; // { period: { [feeType]: amount } } — itemized, for the dropdown
    const feeTypeTotals = {}; // { feeType: totalAbsAmount } — for sorting which rows to show
    const adjustmentTypeTotals = {}; // { feeType: totalAbsAmount } — same, for Adjustments dropdown
    for (const r of accountFeesResult.rows) {
      const key = r.period.toISOString().split('T')[0];
      const amt = parseFloat(r.amount || 0);
      if (r.event_source === 'Adjustment') {
        adjustmentsByPeriod[key] = (adjustmentsByPeriod[key] || 0) + amt;
        if (!adjustmentItemsByPeriod[key]) adjustmentItemsByPeriod[key] = {};
        adjustmentItemsByPeriod[key][r.fee_type] = (adjustmentItemsByPeriod[key][r.fee_type] || 0) + amt;
        adjustmentTypeTotals[r.fee_type] = (adjustmentTypeTotals[r.fee_type] || 0) + Math.abs(amt);
      } else {
        if (!accountFeesByPeriod[key]) accountFeesByPeriod[key] = {};
        accountFeesByPeriod[key][r.fee_type] = (accountFeesByPeriod[key][r.fee_type] || 0) + amt;
        feeTypeTotals[r.fee_type] = (feeTypeTotals[r.fee_type] || 0) + Math.abs(amt);
      }
    }
    // Merge in the accrual-dated LTSF rows (see comment above ltsfResult) under the same
    // 'FBALongTermStorageFee' key the old settlement-dated query used to populate, so the P&L
    // display, sort-by-magnitude, and __total__ aggregation logic below don't need to know this
    // fee type now comes from a different table.
    for (const r of ltsfResult.rows) {
      const key = r.period.toISOString().split('T')[0];
      const amt = parseFloat(r.amount || 0);
      if (!accountFeesByPeriod[key]) accountFeesByPeriod[key] = {};
      accountFeesByPeriod[key]['FBALongTermStorageFee'] = (accountFeesByPeriod[key]['FBALongTermStorageFee'] || 0) + amt;
      feeTypeTotals['FBALongTermStorageFee'] = (feeTypeTotals['FBALongTermStorageFee'] || 0) + Math.abs(amt);
    }
    const accountFeeTypes = Object.keys(feeTypeTotals).sort((a, b) => feeTypeTotals[b] - feeTypeTotals[a]);
    const adjustmentTypes = Object.keys(adjustmentTypeTotals).sort((a, b) => adjustmentTypeTotals[b] - adjustmentTypeTotals[a]);

    function buildPeriodRow(periodKey, r) {
      const unitsSold = parseInt(r?.units_sold || 0, 10);
      const unitsRefunded = unitsRefundedByPeriod[periodKey] || 0;
      const ppcUnits = ppcUnitsByPeriod[periodKey] || 0;
      const organicUnits = Math.max(unitsSold - ppcUnits, 0);
      const grossSales = fx(r?.gross_sales || 0);
      const totalDiscounts = fx(r?.total_discounts || 0);
      const netRevenue = grossSales - totalDiscounts;
      const totalRefunded = fx(refundsByPeriod[periodKey] || 0);
      const netSales = netRevenue - totalRefunded;
      // Sign convention: every cost/fee value below is stored NEGATIVE (an outflow),
      // so totals are computed by simple addition. This avoids the double-negation bug
      // that happens when magnitudes (positive) and pre-signed deltas (negative) are mixed
      // under a single subtraction.
      const cogs = {
        standard: -fx(r?.cogs_standard || 0),
        freight: -fx(r?.cogs_freight || 0),
        demurrage: -fx(r?.cogs_demurrage || 0),
        quality: -fx(r?.cogs_quality || 0),
        other: -fx(r?.cogs_other || 0),
        // Credit-back for genuine physical returns only (amazon_customer_returns), not every
        // refund — see returnsCogsResult above.
        returned: fx(returnsCogsByPeriod[periodKey] || 0),
      };
      cogs.total = cogs.standard + cogs.freight + cogs.demurrage + cogs.quality + cogs.other + cogs.returned;
      const refundFees = refundFeesByPeriod[periodKey] || { commission_refunded: 0, refund_admin_fee: 0, digital_services_refunded: 0 };
      const lineFees = {
        commission: -fx(r?.fee_commission || 0),
        // Amazon reverses (credits back) its commission on a refund, but keeps ~20% of that
        // reversal as an admin fee (RefundCommission) — see runSyncFinances in
        // amazon-spapi-proxy. Both are refund-date-scoped like total_refunded above, not
        // order-date-scoped like the original commission.
        commission_refunded: fx(refundFees.commission_refunded || 0), // positive: a credit
        fba_fulfillment: -fx(r?.fee_fba_fulfillment || 0),
        fixed_closing: -fx(r?.fee_fixed_closing || 0),
        variable_closing: -fx(r?.fee_variable_closing || 0),
        // Digital Services Fee also gets partially reversed on refund - netted directly into
        // this line (not a separate row like commission_refunded) since it's a small fee.
        digital_services: -fx(r?.fee_digital_services || 0) + fx(refundFees.digital_services_refunded || 0),
        giftwrap: -fx(r?.fee_giftwrap || 0),
        shipping_chargeback: -fx(r?.fee_shipping_chargeback || 0),
        refund_admin_fee: -fx(refundFees.refund_admin_fee || 0), // negative: a charge
        // MCF fee is period-keyed independently (from amazon_mcf_fees), not part of the Amazon
        // order-line query above, since the underlying order is a Shopify order fulfilled via FBA.
        mcf: -fx(mcfByPeriod[periodKey] || 0),
      };
      const lineFeesTotal = Object.values(lineFees).reduce((s, v) => s + v, 0); // negative
      const accountFeesRaw = accountFeesByPeriod[periodKey] || {};
      const accountFees = {};
      let accountFeesTotal = 0;
      for (const ft of accountFeeTypes) {
        const v = fx(accountFeesRaw[ft] || 0); // already negative from sync (charges stored as -Math.abs)
        accountFees[ft] = v;
        accountFeesTotal += v;
      }
      const adjustments = fx(adjustmentsByPeriod[periodKey] || 0); // signed as Amazon reports it (can be +/-)
      const adjustmentItemsRaw = adjustmentItemsByPeriod[periodKey] || {};
      const adjustmentItems = {};
      for (const at of adjustmentTypes) {
        adjustmentItems[at] = fx(adjustmentItemsRaw[at] || 0); // signed as Amazon reports it (can be +/-)
      }
      const ppcCost = -fx(ppcByPeriod[periodKey] || 0); // negative (spend)

      // Gross Margin / Product Contribution only include costs that can be attributed to a
      // specific product/order line: COGS, per-order-line fees (commission, FBA fulfillment,
      // closing fees, etc.), and PPC spend. Everything account-wide/not product-attributable
      // (Amazon's account-level fees + adjustments, plus future headcount/fixed-cost entries)
      // lives under OPEX — the bridge from Product Contribution down to the true bottom-line
      // Profit. Headcount and Fixed Costs have no data source yet (scaffolded at 0), so OPEX
      // currently equals Other Fees.
      const grossMargin = netSales + cogs.total + lineFeesTotal; // netSales minus |cogs| minus |product fees|
      const productContribution = grossMargin + ppcCost;
      const otherFeesTotal = accountFeesTotal + adjustments; // negative-leaning, but adjustments can be +
      const headcountTotal = 0; // no data source yet
      const fixedCostsTotal = 0; // no data source yet
      const opexTotal = headcountTotal + otherFeesTotal + fixedCostsTotal;
      const profit = productContribution + opexTotal;

      const marginPct = netSales > 0 ? (productContribution / netSales * 100) : 0;
      const cogsMagnitude = Math.abs(cogs.total);
      // P&L page ROI = Profit / COGS (account-wide bottom line vs. cost of goods) — distinct
      // from the Product Breakdown page's ROI, which is Product Contribution / COGS (per-SKU,
      // before OPEX is allocated). Profit is computed above, so this always reflects the
      // post-OPEX bottom line.
      const roiPct = cogsMagnitude > 0 ? (profit / cogsMagnitude * 100) : 0;
      const profitPct = netSales > 0 ? (profit / netSales * 100) : 0;

      return {
        period: periodKey,
        units_sold: unitsSold,
        units_refunded: -unitsRefunded,
        net_units_sold: unitsSold - unitsRefunded,
        organic_units: organicUnits,
        ppc_units: ppcUnits,
        gross_sales: grossSales.toFixed(2),
        total_discounts: (-totalDiscounts).toFixed(2),
        net_revenue: netRevenue.toFixed(2),
        total_refunded: (-totalRefunded).toFixed(2),
        net_sales: netSales.toFixed(2),
        cogs: {
          standard: cogs.standard.toFixed(2),
          freight: cogs.freight.toFixed(2),
          demurrage: cogs.demurrage.toFixed(2),
          quality: cogs.quality.toFixed(2),
          other: cogs.other.toFixed(2),
          returned: cogs.returned.toFixed(2),
          total: cogs.total.toFixed(2),
        },
        fees: {
          commission: lineFees.commission.toFixed(2),
          commission_refunded: lineFees.commission_refunded.toFixed(2),
          fba_fulfillment: lineFees.fba_fulfillment.toFixed(2),
          fixed_closing: lineFees.fixed_closing.toFixed(2),
          variable_closing: lineFees.variable_closing.toFixed(2),
          digital_services: lineFees.digital_services.toFixed(2),
          giftwrap: lineFees.giftwrap.toFixed(2),
          shipping_chargeback: lineFees.shipping_chargeback.toFixed(2),
          refund_admin_fee: lineFees.refund_admin_fee.toFixed(2),
          mcf: lineFees.mcf.toFixed(2),
          total: lineFeesTotal.toFixed(2),
        },
        ppc_cost: ppcCost.toFixed(2),
        gross_margin: grossMargin.toFixed(2),
        product_contribution: productContribution.toFixed(2),
        margin_pct: marginPct.toFixed(1),
        roi_pct: roiPct.toFixed(1),
        // OPEX — account-wide operating expenses that can't be attributed to a specific
        // product, bridging Product Contribution down to Profit. Headcount and Fixed Costs
        // are scaffolded categories with no data source yet (always 0); Other Fees holds
        // everything Amazon charges at the account level (subscription, storage, coupons)
        // plus inventory Adjustments (excluding Reserve Debit/Credit, which are cash-flow
        // timing rather than P&L items — see comment above accountFeesResult).
        opex: {
          headcount: { total: headcountTotal.toFixed(2) },
          fixed_costs: { total: fixedCostsTotal.toFixed(2) },
          other_fees: {
            account_fees: Object.fromEntries(Object.entries(accountFees).map(([k, v]) => [k, v.toFixed(2)])),
            account_fees_total: accountFeesTotal.toFixed(2),
            adjustments: adjustments.toFixed(2),
            adjustment_items: Object.fromEntries(Object.entries(adjustmentItems).map(([k, v]) => [k, v.toFixed(2)])),
            total: otherFeesTotal.toFixed(2),
          },
          total: opexTotal.toFixed(2),
        },
        profit: profit.toFixed(2),
        profit_pct: profitPct.toFixed(1),
      };
    }

    // Union of all period keys seen across lines/refunds/ppc/account-fees, so a period with
    // e.g. only a subscription fee and no sales still shows up as its own column.
    const allPeriodKeys = new Set([
      ...linesResult.rows.map(r => r.period.toISOString().split('T')[0]),
      ...Object.keys(refundsByPeriod),
      ...Object.keys(refundFeesByPeriod),
      ...Object.keys(returnsCogsByPeriod),
      ...Object.keys(ppcByPeriod),
      ...Object.keys(accountFeesByPeriod),
      ...Object.keys(adjustmentsByPeriod),
      ...Object.keys(mcfByPeriod),
    ]);
    const linesByPeriod = {};
    for (const r of linesResult.rows) linesByPeriod[r.period.toISOString().split('T')[0]] = r;

    const periods = [...allPeriodKeys].sort().map(key => buildPeriodRow(key, linesByPeriod[key]));

    // Total row — recompute from summed raw inputs rather than summing already-rounded
    // period rows, so rounding doesn't drift the total away from period-by-period figures.
    const totalRaw = linesResult.rows.reduce((acc, r) => {
      acc.units_sold += parseInt(r.units_sold || 0, 10);
      acc.gross_sales += parseFloat(r.gross_sales || 0);
      acc.total_discounts += parseFloat(r.total_discounts || 0);
      acc.cogs_standard += parseFloat(r.cogs_standard || 0);
      acc.cogs_freight += parseFloat(r.cogs_freight || 0);
      acc.cogs_demurrage += parseFloat(r.cogs_demurrage || 0);
      acc.cogs_quality += parseFloat(r.cogs_quality || 0);
      acc.cogs_other += parseFloat(r.cogs_other || 0);
      acc.fee_commission += parseFloat(r.fee_commission || 0);
      acc.fee_fba_fulfillment += parseFloat(r.fee_fba_fulfillment || 0);
      acc.fee_fixed_closing += parseFloat(r.fee_fixed_closing || 0);
      acc.fee_variable_closing += parseFloat(r.fee_variable_closing || 0);
      acc.fee_digital_services += parseFloat(r.fee_digital_services || 0);
      acc.fee_giftwrap += parseFloat(r.fee_giftwrap || 0);
      acc.fee_shipping_chargeback += parseFloat(r.fee_shipping_chargeback || 0);
      return acc;
    }, { units_sold: 0, gross_sales: 0, total_discounts: 0, cogs_standard: 0, cogs_freight: 0, cogs_demurrage: 0, cogs_quality: 0, cogs_other: 0, fee_commission: 0, fee_fba_fulfillment: 0, fee_fixed_closing: 0, fee_variable_closing: 0, fee_digital_services: 0, fee_giftwrap: 0, fee_shipping_chargeback: 0 });
    totalRaw.period = '__total__';
    // Total refunds/ppc/account-fees/adjustments are just the sum over all real periods —
    // captured before adding the '__total__' key itself, so it can't fold into its own sum.
    const sumMap = (m) => Object.values(m).reduce((s, v) => s + v, 0);
    const perPeriodAccountFees = Object.values(accountFeesByPeriod);
    const perPeriodAdjustmentItems = Object.values(adjustmentItemsByPeriod);
    refundsByPeriod['__total__'] = sumMap(refundsByPeriod);
    unitsRefundedByPeriod['__total__'] = sumMap(unitsRefundedByPeriod);
    refundFeesByPeriod['__total__'] = {
      commission_refunded: Object.values(refundFeesByPeriod).reduce((s, v) => s + (v.commission_refunded || 0), 0),
      refund_admin_fee: Object.values(refundFeesByPeriod).reduce((s, v) => s + (v.refund_admin_fee || 0), 0),
      digital_services_refunded: Object.values(refundFeesByPeriod).reduce((s, v) => s + (v.digital_services_refunded || 0), 0),
    };
    returnsCogsByPeriod['__total__'] = sumMap(returnsCogsByPeriod);
    ppcByPeriod['__total__'] = sumMap(ppcByPeriod);
    ppcUnitsByPeriod['__total__'] = sumMap(ppcUnitsByPeriod);
    adjustmentsByPeriod['__total__'] = sumMap(adjustmentsByPeriod);
    mcfByPeriod['__total__'] = sumMap(mcfByPeriod);
    accountFeesByPeriod['__total__'] = {};
    for (const ft of accountFeeTypes) {
      accountFeesByPeriod['__total__'][ft] = perPeriodAccountFees.reduce((s, m) => s + (m[ft] || 0), 0);
    }
    adjustmentItemsByPeriod['__total__'] = {};
    for (const at of adjustmentTypes) {
      adjustmentItemsByPeriod['__total__'][at] = perPeriodAdjustmentItems.reduce((s, m) => s + (m[at] || 0), 0);
    }
    const totals = buildPeriodRow('__total__', totalRaw);

    res.json({
      periods,
      totals,
      account_fee_types: accountFeeTypes,
      adjustment_types: adjustmentTypes,
      currency_symbol: currencySymbol(reportingCurrency),
      group: trunc,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Product Breakdown — per SKU, both channels, date filtered
app.get('/api/product-breakdown', async (req, res) => {
  const { from, to, channel = 'all', sort = 'gross_sales', dir = 'desc', brand, parent_asin } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  // Sorting happens in JS after fxRows is built (see below) — gross_profit, gross_margin_pct,
  // and product_contribution are computed post-query and don't exist as raw SQL columns, and
  // gross_sales/net_revenue/etc. are ambiguous to ORDER BY directly in the 'all' channel query
  // (both shopify_skus and amazon_skus CTEs expose same-named columns into the FROM scope).
  const validSorts = ['gross_sales', 'net_revenue', 'units_sold', 'total_refunded', 'units_refunded', 'total_discounts', 'gross_profit', 'gross_margin_pct', 'product_contribution'];
  const sortCol = validSorts.includes(sort) ? sort : 'gross_sales';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';

  // Optional brand/parent_asin filter — restricts which SKUs are included
  const brandFilter = brand ? `AND sp.brand = '${brand.replace(/'/g, "''")}'` : '';
  const parentFilter = parent_asin ? `AND sp.parent_asin = '${parent_asin.replace(/'/g, "''")}'` : '';
  try {
    // Refunds by SKU, attributed by refund_date within selected range. Estimates
    // fee_commission_refunded/fee_refund_admin (prorated from the order line's original
    // commission, admin fee at the account's observed ~20% ratio) for refunds where the
    // monetary amount has posted but Amazon's commission-reversal fee event hasn't settled yet.
    const refundCte = `
      refunds_by_sku AS (
        SELECT olr.sku, SUM(olr.amount_refunded / vat_divisor(ao.shipping_country))::numeric AS total_refunded, SUM(COALESCE(olr.quantity_refunded,0))::int AS units_refunded,
          SUM((CASE WHEN olr.fee_commission_refunded > 0 THEN olr.fee_commission_refunded
            ELSE COALESCE(aol.fee_commission / NULLIF(aol.quantity, 0), 0) * olr.quantity_refunded END) / vat_divisor_seller())::numeric AS fee_commission_refunded,
          SUM((CASE WHEN olr.fee_refund_admin > 0 THEN olr.fee_refund_admin
            ELSE COALESCE(aol.fee_commission / NULLIF(aol.quantity, 0), 0) * olr.quantity_refunded * 0.2 END) / vat_divisor_seller())::numeric AS fee_refund_admin,
          SUM((CASE WHEN olr.fee_digital_services_refunded > 0 THEN olr.fee_digital_services_refunded
            ELSE COALESCE(aol.fee_digital_services / NULLIF(aol.quantity, 0), 0) * olr.quantity_refunded END) / vat_divisor_seller())::numeric AS fee_digital_services_refunded
        FROM amazon_order_line_refunds olr
        LEFT JOIN amazon_order_lines aol ON aol.amazon_order_id = olr.amazon_order_id AND aol.sku = olr.sku
        LEFT JOIN amazon_orders ao ON ao.amazon_order_id = olr.amazon_order_id
        WHERE olr.sku IS NOT NULL AND olr.refund_date::date BETWEEN $1 AND $2
        GROUP BY olr.sku
      ),
      shopify_refunds_by_sku AS (
        SELECT
          sol.sku,
          SUM(
            (st.amount * (sol.line_gross / NULLIF(order_totals.order_gross, 0))) / vat_divisor(so.shipping_country)
          )::numeric AS total_refunded,
          COUNT(DISTINCT st.shopify_transaction_id)::int AS units_refunded
        FROM shopify_transactions st
        JOIN shopify_order_lines sol ON sol.shopify_order_id = st.shopify_order_id
        LEFT JOIN shopify_orders so ON so.shopify_order_id = st.shopify_order_id
        JOIN (
          SELECT shopify_order_id, SUM(line_gross) AS order_gross
          FROM shopify_order_lines
          GROUP BY shopify_order_id
        ) order_totals ON order_totals.shopify_order_id = st.shopify_order_id
        WHERE st.kind = 'refund' AND st.status = 'success' AND st.transaction_date::date BETWEEN $1 AND $2
        GROUP BY sol.sku
      ),
      all_refunds_by_sku AS (
        SELECT sku,
          SUM(total_refunded)::numeric AS total_refunded,
          SUM(units_refunded)::int AS units_refunded
        FROM (
          SELECT sku, total_refunded, units_refunded FROM refunds_by_sku
          UNION ALL
          SELECT sku, total_refunded, units_refunded FROM shopify_refunds_by_sku
        ) combined GROUP BY sku
      ),
      -- COGS per SKU: weighted by quantity at the COGS rate active on each order date.
      -- NOT credited back for refunds here — a refund only reverses revenue, it doesn't mean
      -- the physical unit came back. The credit-back for genuine returns is a separate step
      -- below (returns_by_sku), keyed off amazon_customer_returns rather than amount_refunded.
      amazon_cogs AS (
        SELECT
          aol.sku,
          -- Itemized per-unit COGS (standard/freight/demurrage/quality/other), each falling back
          -- cogs_entries -> sku_parameters -> flat unit_cogs. Matches the P&L breakdown panel's
          -- calculation exactly (previously this used a flat unit_cogs-only shortcut, which caused
          -- the table row and the P&L panel to disagree on margin whenever itemized components
          -- were populated but didn't equal the flat unit_cogs value).
          SUM(aol.quantity * (
            COALESCE(
              NULLIF(ce.cogs_standard, 0), NULLIF(sp.cogs_standard, 0),
              CASE WHEN COALESCE(ce.cogs_standard,0)+COALESCE(ce.cogs_freight,0)+COALESCE(ce.cogs_demurrage,0)+COALESCE(ce.cogs_quality,0)+COALESCE(ce.cogs_other,0) = 0
                AND COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
                THEN COALESCE(ce.unit_cogs, sp.unit_cogs, 0) ELSE 0 END, 0)
            + COALESCE(NULLIF(ce.cogs_freight,   0), NULLIF(sp.cogs_freight,   0), 0)
            + COALESCE(NULLIF(ce.cogs_demurrage, 0), NULLIF(sp.cogs_demurrage, 0), 0)
            + COALESCE(NULLIF(ce.cogs_quality,   0), NULLIF(sp.cogs_quality,   0), 0)
            + COALESCE(NULLIF(ce.cogs_other,     0), NULLIF(sp.cogs_other,     0), 0)
          ))::numeric AS total_cogs_sold,
          SUM(aol.quantity)::int AS cogs_units,
          -- Includes giftwrap + shipping chargebacks (previously missing here, present in the
          -- P&L panel) — that gap alone could make the table's margin look better than reality.
          SUM((COALESCE(aol.fee_fba_fulfillment, 0) + COALESCE(aol.fee_commission, 0) +
              COALESCE(aol.fee_fixed_closing, 0) + COALESCE(aol.fee_variable_closing, 0) +
              COALESCE(aol.fee_digital_services, 0) + COALESCE(aol.fee_giftwrap_chargeback, 0) +
              COALESCE(aol.fee_shipping_chargeback, 0)) / vat_divisor_seller())::numeric AS total_fees
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
        LEFT JOIN LATERAL (
          -- Convert itemized COGS from cogs_entries.cogs_currency to GBP at the exchange rate
          -- on the order date, so it lines up with GBP-denominated revenue below. No-op for GBP.
          SELECT
            ce0.cogs_standard  * COALESCE(fx.rate, 1) AS cogs_standard,
            ce0.cogs_freight   * COALESCE(fx.rate, 1) AS cogs_freight,
            ce0.cogs_demurrage * COALESCE(fx.rate, 1) AS cogs_demurrage,
            ce0.cogs_quality   * COALESCE(fx.rate, 1) AS cogs_quality,
            ce0.cogs_other     * COALESCE(fx.rate, 1) AS cogs_other,
            ce0.unit_cogs      * COALESCE(fx.rate, 1) AS unit_cogs
          FROM cogs_entries ce0
          LEFT JOIN LATERAL (
            SELECT rate FROM exchange_rates
            WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
              AND date <= ao.order_date::date
            ORDER BY date DESC LIMIT 1
          ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
          WHERE ce0.sku = aol.sku
            AND ce0.effective_from <= ao.order_date::date
            AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
          ORDER BY ce0.effective_from DESC LIMIT 1
        ) ce ON true
        WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
        GROUP BY aol.sku
      ),
      shopify_cogs AS (
        SELECT
          sol.sku,
          -- Same itemized COGS calc as amazon_cogs above, for consistency with the P&L panel.
          SUM(sol.quantity * (
            COALESCE(
              NULLIF(ce.cogs_standard, 0), NULLIF(sp.cogs_standard, 0),
              CASE WHEN COALESCE(ce.cogs_standard,0)+COALESCE(ce.cogs_freight,0)+COALESCE(ce.cogs_demurrage,0)+COALESCE(ce.cogs_quality,0)+COALESCE(ce.cogs_other,0) = 0
                AND COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
                THEN COALESCE(ce.unit_cogs, sp.unit_cogs, 0) ELSE 0 END, 0)
            + COALESCE(NULLIF(ce.cogs_freight,   0), NULLIF(sp.cogs_freight,   0), 0)
            + COALESCE(NULLIF(ce.cogs_demurrage, 0), NULLIF(sp.cogs_demurrage, 0), 0)
            + COALESCE(NULLIF(ce.cogs_quality,   0), NULLIF(sp.cogs_quality,   0), 0)
            + COALESCE(NULLIF(ce.cogs_other,     0), NULLIF(sp.cogs_other,     0), 0)
          ))::numeric AS total_cogs_sold,
          SUM(sol.quantity)::int AS cogs_units,
          -- MCF fees allocated proportionally by line revenue share within each order
          COALESCE(SUM(
            (mcf.fee_amount * (sol.line_gross / NULLIF(order_totals.order_gross, 0))) / vat_divisor_seller()
          ), 0)::numeric AS total_fees
        FROM shopify_order_lines sol
        LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
        LEFT JOIN LATERAL (
          SELECT
            ce0.cogs_standard  * COALESCE(fx.rate, 1) AS cogs_standard,
            ce0.cogs_freight   * COALESCE(fx.rate, 1) AS cogs_freight,
            ce0.cogs_demurrage * COALESCE(fx.rate, 1) AS cogs_demurrage,
            ce0.cogs_quality   * COALESCE(fx.rate, 1) AS cogs_quality,
            ce0.cogs_other     * COALESCE(fx.rate, 1) AS cogs_other,
            ce0.unit_cogs      * COALESCE(fx.rate, 1) AS unit_cogs
          FROM cogs_entries ce0
          LEFT JOIN LATERAL (
            SELECT rate FROM exchange_rates
            WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
              AND date <= sol.order_date::date
            ORDER BY date DESC LIMIT 1
          ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
          WHERE ce0.sku = sol.sku
            AND ce0.effective_from <= sol.order_date::date
            AND (ce0.effective_to IS NULL OR ce0.effective_to >= sol.order_date::date)
          ORDER BY ce0.effective_from DESC LIMIT 1
        ) ce ON true
        LEFT JOIN amazon_mcf_fees mcf ON mcf.shopify_order_id = sol.shopify_order_id
        LEFT JOIN (
          SELECT shopify_order_id, SUM(line_gross) AS order_gross
          FROM shopify_order_lines GROUP BY shopify_order_id
        ) order_totals ON order_totals.shopify_order_id = sol.shopify_order_id
        WHERE sol.order_date::date BETWEEN $1 AND $2
        GROUP BY sol.sku
      ),
      -- COGS credit-back for genuine physical returns - priced at the COGS rate active on the
      -- ORIGINAL order date (reversing at the same cost basis it was recorded at), but
      -- attributed to the matching REFUND's date rather than the physical return_date, so it
      -- lands in the same window as the revenue reversal it corresponds to (matches
      -- refunds_by_sku above). Each return is matched to its nearest-in-time refund event on
      -- the same order/sku. Amazon-only (amazon_customer_returns is sourced from an FBA-only
      -- report); a Shopify order fulfilled via MCF would ship back to an FBA fulfillment center
      -- too, but the returns report's order-id for those is the MCF fulfillment order id, not
      -- the Shopify order id, so it wouldn't join here even if present - out of scope for now.
      returns_by_sku AS (
        SELECT
          acr.sku,
          SUM(acr.quantity * (
            COALESCE(
              NULLIF(ce.cogs_standard, 0), NULLIF(sp.cogs_standard, 0),
              CASE WHEN COALESCE(ce.cogs_standard,0)+COALESCE(ce.cogs_freight,0)+COALESCE(ce.cogs_demurrage,0)+COALESCE(ce.cogs_quality,0)+COALESCE(ce.cogs_other,0) = 0
                AND COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
                THEN COALESCE(ce.unit_cogs, sp.unit_cogs, 0) ELSE 0 END, 0)
            + COALESCE(NULLIF(ce.cogs_freight,   0), NULLIF(sp.cogs_freight,   0), 0)
            + COALESCE(NULLIF(ce.cogs_demurrage, 0), NULLIF(sp.cogs_demurrage, 0), 0)
            + COALESCE(NULLIF(ce.cogs_quality,   0), NULLIF(sp.cogs_quality,   0), 0)
            + COALESCE(NULLIF(ce.cogs_other,     0), NULLIF(sp.cogs_other,     0), 0)
          ))::numeric AS total_cogs_returned,
          SUM(acr.quantity)::int AS units_returned
        FROM amazon_customer_returns acr
        JOIN amazon_orders ao ON ao.amazon_order_id = acr.amazon_order_id
        LEFT JOIN sku_parameters sp ON sp.sku = acr.sku
        LEFT JOIN LATERAL (
          SELECT olr.refund_date FROM amazon_order_line_refunds olr
          WHERE olr.amazon_order_id = acr.amazon_order_id AND olr.sku = acr.sku
          ORDER BY ABS(EXTRACT(EPOCH FROM (olr.refund_date - acr.return_date::timestamptz))) ASC
          LIMIT 1
        ) rf ON true
        LEFT JOIN LATERAL (
          SELECT
            ce0.cogs_standard  * COALESCE(fx.rate, 1) AS cogs_standard,
            ce0.cogs_freight   * COALESCE(fx.rate, 1) AS cogs_freight,
            ce0.cogs_demurrage * COALESCE(fx.rate, 1) AS cogs_demurrage,
            ce0.cogs_quality   * COALESCE(fx.rate, 1) AS cogs_quality,
            ce0.cogs_other     * COALESCE(fx.rate, 1) AS cogs_other,
            ce0.unit_cogs      * COALESCE(fx.rate, 1) AS unit_cogs
          FROM cogs_entries ce0
          LEFT JOIN LATERAL (
            SELECT rate FROM exchange_rates
            WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
              AND date <= ao.order_date::date
            ORDER BY date DESC LIMIT 1
          ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
          WHERE ce0.sku = acr.sku
            AND ce0.effective_from <= ao.order_date::date
            AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
          ORDER BY ce0.effective_from DESC LIMIT 1
        ) ce ON true
        WHERE COALESCE(rf.refund_date::date, acr.return_date) BETWEEN $1 AND $2
        GROUP BY acr.sku
      ),
      cogs_by_sku_raw AS (
        SELECT sku,
          SUM(total_cogs_sold)::numeric AS total_cogs_sold,
          SUM(total_fees)::numeric AS total_fees
        FROM (
          SELECT sku, total_cogs_sold, total_fees FROM amazon_cogs
          UNION ALL
          SELECT sku, total_cogs_sold, total_fees FROM shopify_cogs
        ) combined GROUP BY sku
      ),
      cogs_by_sku AS (
        SELECT r.sku,
          (r.total_cogs_sold - COALESCE(ret.total_cogs_returned, 0))::numeric AS total_cogs_sold,
          r.total_fees
        FROM cogs_by_sku_raw r
        LEFT JOIN returns_by_sku ret ON ret.sku = r.sku
      ),
      shopify_cogs_only AS (
        SELECT sku, total_cogs_sold, total_fees FROM shopify_cogs
      ),
      amazon_cogs_only AS (
        SELECT ac.sku,
          (ac.total_cogs_sold - COALESCE(ret.total_cogs_returned, 0))::numeric AS total_cogs_sold,
          ac.total_fees
        FROM amazon_cogs ac
        LEFT JOIN returns_by_sku ret ON ret.sku = ac.sku
      ),
      -- PPC spend/sales per SKU (Amazon Ads only) — pre-aggregated so the join below
      -- can't fan out the surrounding SUMs (see MCF fee bug for why this matters).
      ppc_by_sku AS (
        SELECT sku,
          SUM(cost / vat_divisor_seller())::numeric AS ppc_cost,
          SUM(sales_14d)::numeric AS ppc_sales,
          SUM(clicks)::int AS ppc_clicks,
          SUM(impressions)::int AS ppc_impressions,
          SUM(units_sold_clicks_14d)::int AS ppc_units
        FROM amazon_ppc_product_performance
        WHERE report_date BETWEEN $1 AND $2 AND sku IS NOT NULL
        GROUP BY sku
      )
    `;

    let result;
    if (channel === 'shopify') {
      result = await pool.query(`
        WITH ${refundCte},
        -- Pre-aggregated so a SKU refunded this period but ordered outside it (no rows in
        -- shopify_order_lines within range) can still FULL OUTER JOIN in as its own row,
        -- instead of its refund being silently dropped because nothing to attach it to
        -- existed - the exact gap that let a real refund show in P&L but not here.
        shopify_order_agg AS (
          SELECT
            sol.sku,
            MAX(sol.product_title) AS product_title,
            SUM(sol.quantity)::int AS units_sold,
            SUM((sol.unit_price * sol.quantity) / vat_divisor(so.shipping_country))::numeric(12,2) AS gross_sales,
            (SUM((sol.unit_price * sol.quantity) / vat_divisor(so.shipping_country)) - SUM((sol.discount_per_unit * sol.quantity) / vat_divisor(so.shipping_country)))::numeric(12,2) AS net_before_refunds,
            SUM((sol.discount_per_unit * sol.quantity) / vat_divisor(so.shipping_country))::numeric(12,2) AS total_discounts
          FROM shopify_order_lines sol
          LEFT JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
          WHERE sol.order_date::date BETWEEN $1 AND $2
          GROUP BY sol.sku
        )
        SELECT
          COALESCE(o.sku, r.sku) AS sku,
          COALESCE(o.product_title, sp.product_name) AS product_title,
          NULL AS asin,
          sp.image_url,
          sp.brand,
          sp.parent_asin,
          'shopify' AS channels,
          COALESCE(o.units_sold, 0)::int AS units_sold,
          COALESCE(r.units_refunded, 0)::int AS units_refunded,
          COALESCE(o.gross_sales, 0)::numeric(12,2) AS gross_sales,
          (COALESCE(o.net_before_refunds, 0) - COALESCE(r.total_refunded, 0))::numeric(12,2) AS net_revenue,
          COALESCE(o.total_discounts, 0)::numeric(12,2) AS total_discounts,
          COALESCE(r.total_refunded, 0)::numeric(12,2) AS total_refunded,
          COALESCE(cogs.total_cogs_sold, 0)::numeric(12,2) AS total_cogs,
          COALESCE(cogs.total_fees, 0)::numeric(12,2) AS total_fees
        FROM shopify_order_agg o
        FULL OUTER JOIN shopify_refunds_by_sku r ON r.sku = o.sku
        LEFT JOIN sku_parameters sp ON sp.sku = COALESCE(o.sku, r.sku)
        LEFT JOIN shopify_cogs_only cogs ON cogs.sku = COALESCE(o.sku, r.sku)
        WHERE 1=1 ${brandFilter} ${parentFilter}
      `, [dateFrom, dateTo]);
    } else if (channel === 'amazon') {
      result = await pool.query(`
        WITH ${refundCte},
        -- Pre-aggregated order-line totals per SKU. Kept separate from the final SELECT
        -- so we can FULL OUTER JOIN against ppc_by_sku below — a SKU with ad spend but
        -- zero orders in range (wasted spend, no sales) still needs to show up as a row.
        amazon_order_agg AS (
          SELECT
            aol.sku,
            MAX(aol.title) AS product_title,
            MAX(aol.asin) AS asin,
            SUM(aol.quantity)::int AS units_sold,
            SUM(((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) / vat_divisor(ao.shipping_country))::numeric(12,2) AS gross_sales,
            SUM((((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) - COALESCE(aol.promotion_discount,0)) / vat_divisor(ao.shipping_country))::numeric(12,2) AS net_before_refunds,
            SUM(COALESCE(aol.promotion_discount,0) / vat_divisor(ao.shipping_country))::numeric(12,2) AS total_discounts
          FROM amazon_order_lines aol
          JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
          LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
          WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
          GROUP BY aol.sku
        )
        SELECT
          COALESCE(o.sku, ppc.sku, r.sku) AS sku,
          COALESCE(o.product_title, sp.product_name) AS product_title,
          COALESCE(o.asin, sp.asin) AS asin,
          sp.image_url,
          sp.brand,
          sp.parent_asin,
          'amazon' AS channels,
          COALESCE(o.units_sold, 0)::int AS units_sold,
          COALESCE(r.units_refunded, 0)::int AS units_refunded,
          COALESCE(o.gross_sales, 0)::numeric(12,2) AS gross_sales,
          (COALESCE(o.net_before_refunds, 0) - COALESCE(r.total_refunded, 0))::numeric(12,2) AS net_revenue,
          COALESCE(o.total_discounts, 0)::numeric(12,2) AS total_discounts,
          COALESCE(r.total_refunded, 0)::numeric(12,2) AS total_refunded,
          COALESCE(cogs.total_cogs_sold, 0)::numeric(12,2) AS total_cogs,
          -- Net commission reversal (credit) and refund admin fee (charge) into fees, both
          -- refund-date-scoped from refunds_by_sku — same reasoning as total_refunded above.
          (COALESCE(cogs.total_fees, 0) - COALESCE(r.fee_commission_refunded, 0) + COALESCE(r.fee_refund_admin, 0) - COALESCE(r.fee_digital_services_refunded, 0))::numeric(12,2) AS total_fees,
          COALESCE(ppc.ppc_cost, 0)::numeric(12,2) AS ppc_cost,
          COALESCE(ppc.ppc_sales, 0)::numeric(12,2) AS ppc_sales,
          COALESCE(ppc.ppc_units, 0)::int AS ppc_units
        FROM amazon_order_agg o
        FULL OUTER JOIN ppc_by_sku ppc ON ppc.sku = o.sku
        -- FULL OUTER so a SKU refunded this period but ordered outside it still surfaces as
        -- its own row, instead of the refund being silently dropped (same gap as the shopify
        -- branch above - the exact bug that let a real refund show in P&L but not here).
        FULL OUTER JOIN refunds_by_sku r ON r.sku = COALESCE(o.sku, ppc.sku)
        LEFT JOIN sku_parameters sp ON sp.sku = COALESCE(o.sku, ppc.sku, r.sku)
        LEFT JOIN amazon_cogs_only cogs ON cogs.sku = COALESCE(o.sku, ppc.sku, r.sku)
        WHERE 1=1 ${brandFilter} ${parentFilter}
      `, [dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        WITH ${refundCte},
        shopify_skus AS (
          SELECT
            sol.sku,
            MAX(sol.product_title) AS product_title,
            NULL AS asin,
            SUM(sol.quantity)::int AS units_sold,
            SUM((sol.unit_price * sol.quantity) / vat_divisor(so.shipping_country))::numeric(12,2) AS gross_sales,
            SUM(((sol.unit_price * sol.quantity) - (sol.discount_per_unit * sol.quantity)) / vat_divisor(so.shipping_country))::numeric(12,2) AS net_revenue,
            SUM((sol.discount_per_unit * sol.quantity) / vat_divisor(so.shipping_country))::numeric(12,2) AS total_discounts
          FROM shopify_order_lines sol
          LEFT JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
          WHERE sol.order_date::date BETWEEN $1 AND $2
          GROUP BY sol.sku
        ),
        amazon_skus AS (
          SELECT
            aol.sku,
            MAX(aol.title) AS product_title,
            MAX(aol.asin) AS asin,
            SUM(aol.quantity)::int AS units_sold,
            SUM(((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) / vat_divisor(ao.shipping_country))::numeric(12,2) AS gross_sales,
            SUM((((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) - COALESCE(aol.promotion_discount,0)) / vat_divisor(ao.shipping_country))::numeric(12,2) AS net_revenue,
            SUM(COALESCE(aol.promotion_discount,0) / vat_divisor(ao.shipping_country))::numeric(12,2) AS total_discounts
          FROM amazon_order_lines aol
          JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
          LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
          WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
          GROUP BY aol.sku
        )
        SELECT
          COALESCE(s.sku, a.sku, ppc.sku, ra.sku, rs.sku) AS sku,
          COALESCE(a.product_title, s.product_title, sp.product_name) AS product_title,
          COALESCE(a.asin, sp.asin) AS asin,
          sp.image_url,
          sp.brand,
          sp.parent_asin,
          CASE
            WHEN (s.sku IS NOT NULL OR rs.sku IS NOT NULL) AND (a.sku IS NOT NULL OR ra.sku IS NOT NULL) THEN 'both'
            WHEN (s.sku IS NOT NULL OR rs.sku IS NOT NULL) THEN 'shopify'
            ELSE 'amazon'
          END AS channels,
          (COALESCE(s.units_sold, 0) + COALESCE(a.units_sold, 0))::int AS units_sold,
          (COALESCE(ra.units_refunded, 0) + COALESCE(rs.units_refunded, 0))::int AS units_refunded,
          (COALESCE(s.gross_sales, 0) + COALESCE(a.gross_sales, 0))::numeric(12,2) AS gross_sales,
          (COALESCE(s.net_revenue, 0) + COALESCE(a.net_revenue, 0) - COALESCE(ra.total_refunded, 0) - COALESCE(rs.total_refunded, 0))::numeric(12,2) AS net_revenue,
          (COALESCE(s.total_discounts, 0) + COALESCE(a.total_discounts, 0))::numeric(12,2) AS total_discounts,
          (COALESCE(ra.total_refunded, 0) + COALESCE(rs.total_refunded, 0))::numeric(12,2) AS total_refunded,
          COALESCE(cogs.total_cogs_sold, 0)::numeric(12,2) AS total_cogs,
          -- Net commission reversal (credit) and refund admin fee (charge) into fees, both
          -- refund-date-scoped from refunds_by_sku (Amazon-only) — same reasoning as
          -- total_refunded above.
          (COALESCE(cogs.total_fees, 0) - COALESCE(ra.fee_commission_refunded, 0) + COALESCE(ra.fee_refund_admin, 0) - COALESCE(ra.fee_digital_services_refunded, 0))::numeric(12,2) AS total_fees,
          COALESCE(ppc.ppc_cost, 0)::numeric(12,2) AS ppc_cost,
          COALESCE(ppc.ppc_sales, 0)::numeric(12,2) AS ppc_sales,
          COALESCE(ppc.ppc_units, 0)::int AS ppc_units
        FROM shopify_skus s
        FULL OUTER JOIN amazon_skus a ON a.sku = s.sku
        -- FULL OUTER so a SKU with ad spend but zero orders anywhere (no Shopify, no
        -- Amazon sale) still surfaces as its own row instead of disappearing entirely.
        FULL OUTER JOIN ppc_by_sku ppc ON ppc.sku = COALESCE(s.sku, a.sku)
        -- FULL OUTER (and split by channel, not the pre-combined all_refunds_by_sku) so a SKU
        -- refunded this period but ordered outside it still surfaces as its own row with the
        -- right channel badge - the exact gap that let a real refund show in P&L but not here.
        FULL OUTER JOIN refunds_by_sku ra ON ra.sku = COALESCE(s.sku, a.sku, ppc.sku)
        FULL OUTER JOIN shopify_refunds_by_sku rs ON rs.sku = COALESCE(s.sku, a.sku, ppc.sku, ra.sku)
        LEFT JOIN sku_parameters sp ON sp.sku = COALESCE(s.sku, a.sku, ppc.sku, ra.sku, rs.sku)
        LEFT JOIN cogs_by_sku cogs ON cogs.sku = COALESCE(s.sku, a.sku, ppc.sku, ra.sku, rs.sku)
        WHERE 1=1 ${brandFilter} ${parentFilter}
      `, [dateFrom, dateTo]);
    }
    // FX conversion — apply period average rate to all monetary fields
    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const fxRows = result.rows.map(r => {
      const netRevenue     = parseFloat(r.net_revenue     || 0) * fxRate;
      const grossSales     = parseFloat(r.gross_sales     || 0) * fxRate;
      const totalDiscounts = parseFloat(r.total_discounts || 0) * fxRate;
      const totalRefunded  = parseFloat(r.total_refunded  || 0) * fxRate;
      const totalCogs      = parseFloat(r.total_cogs      || 0) * fxRate;
      // Shopify orders have no FBA/Amazon fees — only apply fees for Amazon or both-channel rows
      const totalFees      = r.channels === 'shopify' ? 0 : parseFloat(r.total_fees || 0) * fxRate;
      // PPC is Amazon Ads only — shopify-only rows never have spend here
      const ppcCost        = r.channels === 'shopify' ? 0 : parseFloat(r.ppc_cost  || 0) * fxRate;
      const ppcSales       = r.channels === 'shopify' ? 0 : parseFloat(r.ppc_sales || 0) * fxRate;
      const ppcUnits       = r.channels === 'shopify' ? 0 : parseInt(r.ppc_units || 0, 10);
      // Gross Profit (= Gross Margin) = Net Revenue − COGS − FBA fulfillment − listing fees
      const grossProfit    = netRevenue - totalCogs - totalFees;
      const grossMarginPct = netRevenue > 0 ? (grossProfit / netRevenue * 100) : 0;
      // Product Contribution = Gross Margin − PPC spend — the true bottom line once ad cost is included.
      const productContribution = grossProfit - ppcCost;
      // ACOS = ad spend / ad-attributed sales. ROAS = the inverse. TACOS = ad spend / total net revenue.
      const acos = ppcSales > 0 ? (ppcCost / ppcSales * 100) : 0;
      const roas = ppcCost > 0 ? (ppcSales / ppcCost) : 0;
      const tacos = netRevenue > 0 ? (ppcCost / netRevenue * 100) : 0;
      return {
        ...r,
        gross_sales:          grossSales.toFixed(2),
        net_revenue:          netRevenue.toFixed(2),
        total_discounts:      totalDiscounts.toFixed(2),
        total_refunded:       totalRefunded.toFixed(2),
        total_cogs:           totalCogs.toFixed(2),
        total_fees:           totalFees.toFixed(2),
        gross_profit:         grossProfit.toFixed(2),
        gross_margin_pct:     grossMarginPct.toFixed(1),
        product_contribution: productContribution.toFixed(2),
        ppc_cost:             ppcCost.toFixed(2),
        ppc_sales:            ppcSales.toFixed(2),
        ppc_units:            ppcUnits,
        acos:                 acos.toFixed(1),
        roas:                 roas.toFixed(2),
        tacos:                tacos.toFixed(1),
      };
    });
    // Sort here in JS (not SQL) — gross_profit/gross_margin_pct/product_contribution are
    // computed above and don't exist as raw columns, and gross_sales etc. are ambiguous to
    // ORDER BY directly in the 'all' channel query.
    const sortMult = sortDir === 'ASC' ? 1 : -1;
    fxRows.sort((a, b) => (parseFloat(a[sortCol] || 0) - parseFloat(b[sortCol] || 0)) * sortMult);
    res.json(fxRows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
// Product Breakdown — P&L breakdown for a single SKU + country
app.get('/api/product-breakdown/pnl/:sku', async (req, res) => {
  const { sku } = req.params;
  const { from, to, country, channel = 'all' } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const countryFilter = country && country !== 'all'
    ? (country === 'Unknown' ? `AND COALESCE(ao.shipping_country, 'Unknown') = 'Unknown'` : `AND ao.shipping_country = '${country.replace(/'/g,"''")}'`)
    : '';
  const countryFilterShopify = country && country !== 'all'
    ? (country === 'Unknown' ? `AND COALESCE(so.shipping_country, 'Unknown') = 'Unknown'` : `AND so.shipping_country = '${country.replace(/'/g,"''")}'`)
    : '';

  const includeAmazon  = channel !== 'shopify';
  const includeShopify = channel !== 'amazon';
  try {
    const amzResult = includeAmazon ? await pool.query(`
      SELECT
        SUM(((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) / vat_divisor(ao.shipping_country))::numeric AS gross_sales,
        SUM(COALESCE(aol.promotion_discount, 0) / vat_divisor(ao.shipping_country))::numeric AS discounts,
        SUM(COALESCE(aol.fee_commission, 0) / vat_divisor_seller())::numeric AS fee_commission,
        SUM(COALESCE(aol.fee_fba_fulfillment, 0) / vat_divisor_seller())::numeric AS fee_fba_fulfillment,
        SUM(COALESCE(aol.fee_fixed_closing, 0) / vat_divisor_seller())::numeric AS fee_fixed_closing,
        SUM(COALESCE(aol.fee_variable_closing, 0) / vat_divisor_seller())::numeric AS fee_variable_closing,
        SUM(COALESCE(aol.fee_digital_services, 0) / vat_divisor_seller())::numeric AS fee_digital_services,
        SUM(COALESCE(aol.fee_giftwrap_chargeback, 0) / vat_divisor_seller())::numeric AS fee_giftwrap,
        SUM(COALESCE(aol.fee_shipping_chargeback, 0) / vat_divisor_seller())::numeric AS fee_shipping_chargeback,
        SUM(aol.quantity)::int AS units_sold,
        BOOL_OR(aol.is_estimated_fee) AS has_estimated_fees
      FROM amazon_order_lines aol
      JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
      LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
      WHERE aol.sku = $1 AND ao.order_date::date BETWEEN $2 AND $3 AND ao.status != 'Canceled' ${countryFilter}
    `, [sku, dateFrom, dateTo]) : { rows: [{}] };

    const shpResult = includeShopify ? await pool.query(`
      SELECT
        SUM((sol.unit_price * sol.quantity) / vat_divisor(so.shipping_country))::numeric AS gross_sales,
        SUM((sol.discount_per_unit * sol.quantity) / vat_divisor(so.shipping_country))::numeric AS discounts,
        SUM(sol.quantity)::int AS units_sold,
        -- MCF fees proportionally allocated by revenue share
        COALESCE(SUM(
          (mcf.fee_amount * (sol.line_gross / NULLIF(order_totals.order_gross, 0))) / vat_divisor_seller()
        ), 0)::numeric AS mcf_fees
      FROM shopify_order_lines sol
      JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
      LEFT JOIN amazon_mcf_fees mcf ON mcf.shopify_order_id = sol.shopify_order_id
      LEFT JOIN (
        SELECT shopify_order_id, SUM(line_gross) AS order_gross
        FROM shopify_order_lines GROUP BY shopify_order_id
      ) order_totals ON order_totals.shopify_order_id = sol.shopify_order_id
      WHERE sol.sku = $1 AND sol.order_date::date BETWEEN $2 AND $3 ${countryFilterShopify}
    `, [sku, dateFrom, dateTo]) : { rows: [{}] };

    const refundResult = await pool.query(`
      SELECT COALESCE(SUM(amount_refunded / vat_divisor(shipping_country)), 0)::numeric AS total_refunded
      FROM v_refunds_by_date
      WHERE sku = $1 AND refund_date::date BETWEEN $2 AND $3
        ${!includeAmazon ? `AND channel != 'amazon'` : ''}
        ${!includeShopify ? `AND channel != 'shopify'` : ''}
    `, [sku, dateFrom, dateTo]);

    // Commission reversal / refund admin fee, refund-date-scoped (same table/date basis as
    // refundResult above) — lives on amazon_order_line_refunds, not the v_refunds_by_date view
    // (which we don't have DDL access to alter), so queried separately. Amazon-only.
    //
    // Estimates fee_commission_refunded/fee_refund_admin (prorated from the order line's
    // original commission, admin fee at the account's observed ~20% ratio) for refunds where
    // the monetary amount has posted but Amazon's commission-reversal fee event hasn't settled
    // yet — flagged via has_estimated so it feeds the same EST badge as is_estimated_fee.
    const refundFeesResult = includeAmazon ? await pool.query(`
      SELECT
        COALESCE(SUM((CASE WHEN olr.fee_commission_refunded > 0 THEN olr.fee_commission_refunded
          ELSE COALESCE(aol.fee_commission / NULLIF(aol.quantity, 0), 0) * olr.quantity_refunded END) / vat_divisor_seller()), 0)::numeric AS fee_commission_refunded,
        COALESCE(SUM((CASE WHEN olr.fee_refund_admin > 0 THEN olr.fee_refund_admin
          ELSE COALESCE(aol.fee_commission / NULLIF(aol.quantity, 0), 0) * olr.quantity_refunded * 0.2 END) / vat_divisor_seller()), 0)::numeric AS fee_refund_admin,
        COALESCE(SUM((CASE WHEN olr.fee_digital_services_refunded > 0 THEN olr.fee_digital_services_refunded
          ELSE COALESCE(aol.fee_digital_services / NULLIF(aol.quantity, 0), 0) * olr.quantity_refunded END) / vat_divisor_seller()), 0)::numeric AS fee_digital_services_refunded,
        BOOL_OR(olr.amount_refunded > 0 AND COALESCE(olr.fee_commission_refunded, 0) = 0) AS has_estimated
      FROM amazon_order_line_refunds olr
      LEFT JOIN amazon_order_lines aol ON aol.amazon_order_id = olr.amazon_order_id AND aol.sku = olr.sku
      WHERE olr.sku = $1 AND olr.refund_date::date BETWEEN $2 AND $3
    `, [sku, dateFrom, dateTo]) : { rows: [{ fee_commission_refunded: 0, fee_refund_admin: 0, fee_digital_services_refunded: 0, has_estimated: false }] };

    // PPC spend/sales for this SKU — Amazon Ads only, single-table aggregate (no join fanout risk)
    const ppcResult = includeAmazon ? await pool.query(`
      SELECT COALESCE(SUM(cost / vat_divisor_seller()), 0)::numeric AS ppc_cost, COALESCE(SUM(sales_14d), 0)::numeric AS ppc_sales
      FROM amazon_ppc_product_performance
      WHERE sku = $1 AND report_date BETWEEN $2 AND $3
    `, [sku, dateFrom, dateTo]) : { rows: [{ ppc_cost: 0, ppc_sales: 0 }] };

    // Date-matched COGS: sum per order using cogs_entries active on order date
    const cogsRows = [];
    if (includeAmazon) {
      const r = await pool.query(`
        SELECT
          SUM(aol.quantity * COALESCE(
            NULLIF(ce.cogs_standard, 0), NULLIF(sp.cogs_standard, 0),
            CASE WHEN COALESCE(ce.cogs_standard,0)+COALESCE(ce.cogs_freight,0)+COALESCE(ce.cogs_demurrage,0)+COALESCE(ce.cogs_quality,0)+COALESCE(ce.cogs_other,0) = 0
              AND COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
              THEN COALESCE(ce.unit_cogs, sp.unit_cogs, 0) ELSE 0 END, 0))::numeric AS cogs_standard,
          SUM(aol.quantity * COALESCE(NULLIF(ce.cogs_freight,   0), NULLIF(sp.cogs_freight,   0), 0))::numeric AS cogs_freight,
          SUM(aol.quantity * COALESCE(NULLIF(ce.cogs_demurrage, 0), NULLIF(sp.cogs_demurrage, 0), 0))::numeric AS cogs_demurrage,
          SUM(aol.quantity * COALESCE(NULLIF(ce.cogs_quality,   0), NULLIF(sp.cogs_quality,   0), 0))::numeric AS cogs_quality,
          SUM(aol.quantity * COALESCE(NULLIF(ce.cogs_other,     0), NULLIF(sp.cogs_other,     0), 0))::numeric AS cogs_other
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
        LEFT JOIN LATERAL (
          -- Convert itemized COGS from cogs_entries.cogs_currency to GBP at the exchange rate
          -- on the order date, so it lines up with GBP-denominated revenue below. No-op for GBP.
          SELECT
            ce0.cogs_standard  * COALESCE(fx.rate, 1) AS cogs_standard,
            ce0.cogs_freight   * COALESCE(fx.rate, 1) AS cogs_freight,
            ce0.cogs_demurrage * COALESCE(fx.rate, 1) AS cogs_demurrage,
            ce0.cogs_quality   * COALESCE(fx.rate, 1) AS cogs_quality,
            ce0.cogs_other     * COALESCE(fx.rate, 1) AS cogs_other,
            ce0.unit_cogs      * COALESCE(fx.rate, 1) AS unit_cogs
          FROM cogs_entries ce0
          LEFT JOIN LATERAL (
            SELECT rate FROM exchange_rates
            WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
              AND date <= ao.order_date::date
            ORDER BY date DESC LIMIT 1
          ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
          WHERE ce0.sku = aol.sku AND ce0.effective_from <= ao.order_date::date
            AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
          ORDER BY ce0.effective_from DESC LIMIT 1
        ) ce ON true
        WHERE aol.sku = $1 AND ao.order_date::date BETWEEN $2 AND $3 AND ao.status != 'Canceled' ${countryFilter}
      `, [sku, dateFrom, dateTo]);
      if (r.rows[0]) cogsRows.push(r.rows[0]);
    }
    if (includeShopify) {
      const r = await pool.query(`
        SELECT
          SUM(sol.quantity * COALESCE(
            NULLIF(ce.cogs_standard, 0), NULLIF(sp.cogs_standard, 0),
            CASE WHEN COALESCE(ce.cogs_standard,0)+COALESCE(ce.cogs_freight,0)+COALESCE(ce.cogs_demurrage,0)+COALESCE(ce.cogs_quality,0)+COALESCE(ce.cogs_other,0) = 0
              AND COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
              THEN COALESCE(ce.unit_cogs, sp.unit_cogs, 0) ELSE 0 END, 0))::numeric AS cogs_standard,
          SUM(sol.quantity * COALESCE(NULLIF(ce.cogs_freight,   0), NULLIF(sp.cogs_freight,   0), 0))::numeric AS cogs_freight,
          SUM(sol.quantity * COALESCE(NULLIF(ce.cogs_demurrage, 0), NULLIF(sp.cogs_demurrage, 0), 0))::numeric AS cogs_demurrage,
          SUM(sol.quantity * COALESCE(NULLIF(ce.cogs_quality,   0), NULLIF(sp.cogs_quality,   0), 0))::numeric AS cogs_quality,
          SUM(sol.quantity * COALESCE(NULLIF(ce.cogs_other,     0), NULLIF(sp.cogs_other,     0), 0))::numeric AS cogs_other
        FROM shopify_order_lines sol
        JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
        LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
        LEFT JOIN LATERAL (
          SELECT
            ce0.cogs_standard  * COALESCE(fx.rate, 1) AS cogs_standard,
            ce0.cogs_freight   * COALESCE(fx.rate, 1) AS cogs_freight,
            ce0.cogs_demurrage * COALESCE(fx.rate, 1) AS cogs_demurrage,
            ce0.cogs_quality   * COALESCE(fx.rate, 1) AS cogs_quality,
            ce0.cogs_other     * COALESCE(fx.rate, 1) AS cogs_other,
            ce0.unit_cogs      * COALESCE(fx.rate, 1) AS unit_cogs
          FROM cogs_entries ce0
          LEFT JOIN LATERAL (
            SELECT rate FROM exchange_rates
            WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
              AND date <= sol.order_date::date
            ORDER BY date DESC LIMIT 1
          ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
          WHERE ce0.sku = sol.sku AND ce0.effective_from <= sol.order_date::date
            AND (ce0.effective_to IS NULL OR ce0.effective_to >= sol.order_date::date)
          ORDER BY ce0.effective_from DESC LIMIT 1
        ) ce ON true
        WHERE sol.sku = $1 AND sol.order_date::date BETWEEN $2 AND $3 ${countryFilterShopify}
      `, [sku, dateFrom, dateTo]);
      if (r.rows[0]) cogsRows.push(r.rows[0]);
    }
    const cogsResult = { rows: cogsRows };

    // COGS credit-back for genuine physical returns only (amazon_customer_returns), not every
    // refund — attributed to the matching refund's date (nearest-in-time refund event on the
    // same order/sku), priced at the COGS rate active on the original order date. See the
    // equivalent query in /api/pnl for the full rationale.
    const returnsCogsResult = includeAmazon ? await pool.query(`
      SELECT COALESCE(SUM(acr.quantity * (
        COALESCE(
          NULLIF(ce.cogs_standard, 0), NULLIF(sp.cogs_standard, 0),
          CASE WHEN COALESCE(ce.cogs_standard,0)+COALESCE(ce.cogs_freight,0)+COALESCE(ce.cogs_demurrage,0)+COALESCE(ce.cogs_quality,0)+COALESCE(ce.cogs_other,0) = 0
            AND COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
            THEN COALESCE(ce.unit_cogs, sp.unit_cogs, 0) ELSE 0 END, 0)
        + COALESCE(NULLIF(ce.cogs_freight,   0), NULLIF(sp.cogs_freight,   0), 0)
        + COALESCE(NULLIF(ce.cogs_demurrage, 0), NULLIF(sp.cogs_demurrage, 0), 0)
        + COALESCE(NULLIF(ce.cogs_quality,   0), NULLIF(sp.cogs_quality,   0), 0)
        + COALESCE(NULLIF(ce.cogs_other,     0), NULLIF(sp.cogs_other,     0), 0)
      )), 0)::numeric AS total_cogs_returned
      FROM amazon_customer_returns acr
      JOIN amazon_orders ao ON ao.amazon_order_id = acr.amazon_order_id
      LEFT JOIN sku_parameters sp ON sp.sku = acr.sku
      LEFT JOIN LATERAL (
        SELECT olr.refund_date FROM amazon_order_line_refunds olr
        WHERE olr.amazon_order_id = acr.amazon_order_id AND olr.sku = acr.sku
        ORDER BY ABS(EXTRACT(EPOCH FROM (olr.refund_date - acr.return_date::timestamptz))) ASC
        LIMIT 1
      ) rf ON true
      LEFT JOIN LATERAL (
        SELECT
          ce0.cogs_standard  * COALESCE(fx.rate, 1) AS cogs_standard,
          ce0.cogs_freight   * COALESCE(fx.rate, 1) AS cogs_freight,
          ce0.cogs_demurrage * COALESCE(fx.rate, 1) AS cogs_demurrage,
          ce0.cogs_quality   * COALESCE(fx.rate, 1) AS cogs_quality,
          ce0.cogs_other     * COALESCE(fx.rate, 1) AS cogs_other,
          ce0.unit_cogs      * COALESCE(fx.rate, 1) AS unit_cogs
        FROM cogs_entries ce0
        LEFT JOIN LATERAL (
          SELECT rate FROM exchange_rates
          WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
            AND date <= ao.order_date::date
          ORDER BY date DESC LIMIT 1
        ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
        WHERE ce0.sku = acr.sku AND ce0.effective_from <= ao.order_date::date
          AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
        ORDER BY ce0.effective_from DESC LIMIT 1
      ) ce ON true
      WHERE acr.sku = $1 AND COALESCE(rf.refund_date::date, acr.return_date) BETWEEN $2 AND $3
    `, [sku, dateFrom, dateTo]) : { rows: [{ total_cogs_returned: 0 }] };

    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const sym = { GBP: '£', USD: '$', EUR: '€' }[reportingCurrency] || '£';
    const fx = (n) => ((parseFloat(n) || 0) * fxRate);

    const amz = amzResult.rows[0] || {};
    const shp = shpResult.rows[0] || {};
    const totalRefunded = fx(refundResult.rows[0]?.total_refunded || 0);
    const netUnits = parseInt(amz.units_sold || 0) + parseInt(shp.units_sold || 0);

    const grossSales = fx(amz.gross_sales || 0) + fx(shp.gross_sales || 0);
    const discounts  = fx(amz.discounts || 0) + fx(shp.discounts || 0);
    const netRevenue = grossSales - discounts - totalRefunded;

    const feeCommission      = fx(amz.fee_commission || 0);
    const feeFBA             = fx(amz.fee_fba_fulfillment || 0);
    const feeFixedClosing    = fx(amz.fee_fixed_closing || 0);
    const feeVariableClosing = fx(amz.fee_variable_closing || 0);
    const feeDigitalServices = fx(amz.fee_digital_services || 0);
    const feeGiftwrap        = fx(amz.fee_giftwrap || 0);
    const feeShipping        = fx(amz.fee_shipping_chargeback || 0);
    const feeMCF             = fx(shp.mcf_fees || 0);
    // Refund-date-scoped, unlike the fee sums above which are order-date-scoped — same
    // reasoning as totalRefunded vs. gross_sales. commissionRefunded is a credit (reduces
    // total cost); refundAdminFee is Amazon's ~20% cut of that reversal (adds to total cost).
    const commissionRefunded = fx(refundFeesResult.rows[0]?.fee_commission_refunded || 0);
    const refundAdminFee     = fx(refundFeesResult.rows[0]?.fee_refund_admin || 0);
    const digitalServicesRefunded = fx(refundFeesResult.rows[0]?.fee_digital_services_refunded || 0);
    const totalFees = feeCommission + feeFBA + feeFixedClosing + feeVariableClosing + feeDigitalServices + feeGiftwrap + feeShipping + feeMCF - commissionRefunded + refundAdminFee - digitalServicesRefunded;
    // True when any Amazon fee for this SKU/period is still an estimate (from /estimate-fees,
    // pending settlement via the Finances API) rather than a confirmed final amount.
    const hasEstimatedFees = amz.has_estimated_fees === true || refundFeesResult.rows[0]?.has_estimated === true;

    // Sum COGS components across both channels
    const cogsSt  = cogsResult.rows.reduce((s, r) => s + fx(r.cogs_standard  || 0), 0);
    const cogsFr  = cogsResult.rows.reduce((s, r) => s + fx(r.cogs_freight   || 0), 0);
    const cogsDem = cogsResult.rows.reduce((s, r) => s + fx(r.cogs_demurrage || 0), 0);
    const cogsQty = cogsResult.rows.reduce((s, r) => s + fx(r.cogs_quality   || 0), 0);
    const cogsOth = cogsResult.rows.reduce((s, r) => s + fx(r.cogs_other     || 0), 0);
    // Credit-back for genuine physical returns only, not every refund — see returnsCogsResult above.
    const cogsReturned = fx(returnsCogsResult.rows[0]?.total_cogs_returned || 0);
    const totalCogs = cogsSt + cogsFr + cogsDem + cogsQty + cogsOth - cogsReturned;

    // Gross Margin = Net Sales − Fees − COGS (before PPC).
    // Product Contribution = Gross Margin − PPC spend — the true bottom line once ad cost is included.
    const grossMargin = netRevenue - totalFees - totalCogs;
    const f = (n) => n.toFixed(2);

    const ppcCost = fx(ppcResult.rows[0]?.ppc_cost || 0);
    const productContribution = grossMargin - ppcCost;

    res.json({
      currency_symbol: sym,
      units: netUnits,
      revenue: {
        gross_sales: f(grossSales), discounts: f(-discounts),
        refunds: f(-totalRefunded), net_revenue: f(netRevenue),
      },
      fees: {
        commission:          f(-feeCommission),
        commission_refunded: f(commissionRefunded), // positive: a credit
        fba_fulfillment:     f(-feeFBA),
        fixed_closing:       f(-feeFixedClosing),
        variable_closing:    f(-feeVariableClosing),
        digital_services:    f(-feeDigitalServices + digitalServicesRefunded),
        giftwrap:            f(-feeGiftwrap),
        shipping_chargeback: f(-feeShipping),
        refund_admin_fee:    f(-refundAdminFee),
        mcf_fulfillment:     f(-feeMCF),
        total:               f(-totalFees),
        has_estimated:       hasEstimatedFees,
      },
      cogs: {
        standard:  f(-cogsSt),
        freight:   f(-cogsFr),
        demurrage: f(-cogsDem),
        quality:   f(-cogsQty),
        other:     f(-cogsOth),
        returned:  f(cogsReturned), // positive: a credit
        total:     f(-totalCogs),
      },
      gross_margin: f(grossMargin),
      ppc: {
        spend: f(-ppcCost),
      },
      product_contribution: f(productContribution),
      has_cogs: totalCogs > 0 || cogsReturned > 0,
      // totalFees can net to <= 0 when a refund's commission credit outweighs the period's
      // other fees — check the components too so that case still shows the fee breakdown
      // instead of hiding a real commission_refunded/refund_admin_fee amount.
      has_fees: totalFees > 0 || commissionRefunded > 0 || refundAdminFee > 0,
      has_ppc: ppcCost > 0,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/product-breakdown/countries', async (req, res) => {
  const { sku, from, to, channel = 'all' } = req.query;
  if (!sku) return res.status(400).json({ error: 'sku required' });
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  try {
    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const fx = (n) => ((parseFloat(n) || 0) * fxRate);

    let result;
    if (channel === 'shopify') {
      result = await pool.query(`
        SELECT
          COALESCE(so.shipping_country, 'Unknown') AS country,
          'shopify' AS channel,
          SUM(sol.quantity)::int AS units_sold,
          SUM((sol.unit_price * sol.quantity) / vat_divisor(so.shipping_country))::numeric(12,2) AS gross_sales,
          SUM(((sol.unit_price - sol.discount_per_unit) * sol.quantity) / vat_divisor(so.shipping_country))::numeric(12,2) AS net_revenue,
          0::numeric AS total_fees,
          SUM(sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0))::numeric(12,2) AS total_cogs
        FROM shopify_order_lines sol
        JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
        LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
        LEFT JOIN LATERAL (
          SELECT ce0.unit_cogs * COALESCE(fx.rate, 1) AS unit_cogs
          FROM cogs_entries ce0
          LEFT JOIN LATERAL (
            SELECT rate FROM exchange_rates
            WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
              AND date <= sol.order_date::date
            ORDER BY date DESC LIMIT 1
          ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
          WHERE ce0.sku = sol.sku AND ce0.effective_from <= sol.order_date::date
            AND (ce0.effective_to IS NULL OR ce0.effective_to >= sol.order_date::date)
          ORDER BY ce0.effective_from DESC LIMIT 1
        ) ce ON true
        WHERE sol.sku = $1 AND sol.order_date::date BETWEEN $2 AND $3
        GROUP BY 1 ORDER BY gross_sales DESC
      `, [sku, dateFrom, dateTo]);
    } else if (channel === 'amazon') {
      result = await pool.query(`
        SELECT
          COALESCE(ao.shipping_country, 'Unknown') AS country,
          'amazon' AS channel,
          SUM(aol.quantity)::int AS units_sold,
          SUM(((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) / vat_divisor(ao.shipping_country))::numeric(12,2) AS gross_sales,
          SUM((((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) - COALESCE(aol.promotion_discount,0)) / vat_divisor(ao.shipping_country))::numeric(12,2) AS net_revenue,
          SUM((COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_commission,0) + COALESCE(aol.fee_digital_services,0) + COALESCE(aol.fee_fixed_closing,0)) / vat_divisor_seller())::numeric(12,2) AS total_fees,
          SUM(aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0))::numeric(12,2) AS total_cogs
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
        LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
        LEFT JOIN LATERAL (
          SELECT ce0.unit_cogs * COALESCE(fx.rate, 1) AS unit_cogs
          FROM cogs_entries ce0
          LEFT JOIN LATERAL (
            SELECT rate FROM exchange_rates
            WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
              AND date <= ao.order_date::date
            ORDER BY date DESC LIMIT 1
          ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
          WHERE ce0.sku = aol.sku AND ce0.effective_from <= ao.order_date::date
            AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
          ORDER BY ce0.effective_from DESC LIMIT 1
        ) ce ON true
        WHERE aol.sku = $1 AND ao.order_date::date BETWEEN $2 AND $3 AND ao.status != 'Canceled'
        GROUP BY 1 ORDER BY gross_sales DESC
      `, [sku, dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        SELECT country, channel,
          SUM(units_sold)::int AS units_sold,
          SUM(gross_sales)::numeric(12,2) AS gross_sales,
          SUM(net_revenue)::numeric(12,2) AS net_revenue,
          SUM(total_fees)::numeric(12,2) AS total_fees,
          SUM(total_cogs)::numeric(12,2) AS total_cogs
        FROM (
          SELECT COALESCE(so.shipping_country, 'Unknown') AS country, 'shopify' AS channel,
            sol.quantity AS units_sold, (sol.unit_price * sol.quantity) / vat_divisor(so.shipping_country) AS gross_sales,
            ((sol.unit_price - sol.discount_per_unit) * sol.quantity) / vat_divisor(so.shipping_country) AS net_revenue,
            0 AS total_fees,
            (sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)) AS total_cogs
          FROM shopify_order_lines sol
          JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
          LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
          LEFT JOIN LATERAL (
            SELECT ce0.unit_cogs * COALESCE(fx.rate, 1) AS unit_cogs
            FROM cogs_entries ce0
            LEFT JOIN LATERAL (
              SELECT rate FROM exchange_rates
              WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
                AND date <= sol.order_date::date
              ORDER BY date DESC LIMIT 1
            ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
            WHERE ce0.sku = sol.sku AND ce0.effective_from <= sol.order_date::date
              AND (ce0.effective_to IS NULL OR ce0.effective_to >= sol.order_date::date)
            ORDER BY ce0.effective_from DESC LIMIT 1
          ) ce ON true
          WHERE sol.sku = $1 AND sol.order_date::date BETWEEN $2 AND $3
          UNION ALL
          SELECT COALESCE(ao.shipping_country, 'Unknown') AS country, 'amazon' AS channel,
            aol.quantity AS units_sold,
            ((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) / vat_divisor(ao.shipping_country) AS gross_sales,
            (((COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) + COALESCE(aol.shipping_price,0)) - COALESCE(aol.promotion_discount,0)) / vat_divisor(ao.shipping_country) AS net_revenue,
            (COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_commission,0) + COALESCE(aol.fee_digital_services,0) + COALESCE(aol.fee_fixed_closing,0)) / vat_divisor_seller() AS total_fees,
            (aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)) AS total_cogs
          FROM amazon_order_lines aol
          JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
          LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
          LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
          LEFT JOIN LATERAL (
            SELECT ce0.unit_cogs * COALESCE(fx.rate, 1) AS unit_cogs
            FROM cogs_entries ce0
            LEFT JOIN LATERAL (
              SELECT rate FROM exchange_rates
              WHERE base_currency = ce0.cogs_currency AND target_currency = 'GBP'
                AND date <= ao.order_date::date
              ORDER BY date DESC LIMIT 1
            ) fx ON ce0.cogs_currency IS DISTINCT FROM 'GBP'
            WHERE ce0.sku = aol.sku AND ce0.effective_from <= ao.order_date::date
              AND (ce0.effective_to IS NULL OR ce0.effective_to >= ao.order_date::date)
            ORDER BY ce0.effective_from DESC LIMIT 1
          ) ce ON true
          WHERE aol.sku = $1 AND ao.order_date::date BETWEEN $2 AND $3 AND ao.status != 'Canceled'
        ) combined
        GROUP BY country, channel ORDER BY gross_sales DESC
      `, [sku, dateFrom, dateTo]);
    }

    const rows = result.rows.map(r => {
      const netRev  = fx(r.net_revenue);
      const fees    = fx(r.total_fees);
      const cogs    = fx(r.total_cogs);
      const profit  = netRev - fees - cogs;
      const marginPct = netRev > 0 ? (profit / netRev * 100) : 0;
      return {
        country:      r.country,
        channel:      r.channel,
        units_sold:   r.units_sold,
        gross_sales:  fx(r.gross_sales).toFixed(2),
        net_revenue:  netRev.toFixed(2),
        total_fees:   fees.toFixed(2),
        total_cogs:   cogs.toFixed(2),
        gross_profit: profit.toFixed(2),
        gross_margin_pct: marginPct.toFixed(1),
        profit_pct:   marginPct.toFixed(1), // same until PPC wired
        has_cogs:     cogs > 0,
      };
    });
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Product Breakdown — individual orders and refunds for a single SKU, for the "Orders" panel.
// Amazon lines carry their own item_tax as reported by SP-API, so that's used directly rather
// than the vat_divisor() estimate the rest of the dashboard relies on; Amazon refunds and all
// Shopify figures have no per-line tax stored, so those fall back to vat_divisor() same as
// everywhere else. Total is the tax-inclusive amount actually charged/refunded; Net = Total - Tax.
app.get('/api/product-breakdown/orders', async (req, res) => {
  const { sku, from, to, channel = 'all', limit } = req.query;
  if (!sku) return res.status(400).json({ error: 'sku required' });
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const rowLimit = Math.min(parseInt(limit, 10) || 200, 500);
  try {
    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const fx = (n) => ((parseFloat(n) || 0) * fxRate);

    const includeAmazon = channel !== 'shopify';
    const includeShopify = channel !== 'amazon';

    const ordersParts = [];
    const refundsParts = [];
    if (includeAmazon) {
      ordersParts.push(`
        SELECT 'amazon' AS channel, ao.order_date, ao.shipping_country AS marketplace,
          ao.amazon_order_id AS order_id, ao.status, ao.fulfillment_channel,
          aol.quantity,
          (COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity + COALESCE(aol.shipping_price,0) - COALESCE(aol.promotion_discount,0))::numeric AS total,
          (COALESCE(aol.item_tax,0) + COALESCE(aol.shipping_tax,0))::numeric AS tax
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
        WHERE aol.sku = $1 AND ao.order_date::date BETWEEN $2 AND $3 AND ao.status != 'Canceled'
      `);
      refundsParts.push(`
        SELECT 'amazon' AS channel, olr.refund_date AS order_date, ao.shipping_country AS marketplace,
          olr.amazon_order_id AS order_id, 'Refunded'::text AS status, ao.fulfillment_channel,
          olr.quantity_refunded AS quantity,
          olr.amount_refunded::numeric AS total,
          (olr.amount_refunded * (1 - 1/vat_divisor(ao.shipping_country)))::numeric AS tax
        FROM amazon_order_line_refunds olr
        LEFT JOIN amazon_orders ao ON ao.amazon_order_id = olr.amazon_order_id
        WHERE olr.sku = $1 AND olr.refund_date::date BETWEEN $2 AND $3
      `);
    }
    if (includeShopify) {
      ordersParts.push(`
        SELECT 'shopify' AS channel, sol.order_date, so.shipping_country AS marketplace,
          so.shopify_order_number::text AS order_id, so.financial_status AS status, so.fulfillment_status AS fulfillment_channel,
          sol.quantity,
          ((sol.unit_price - sol.discount_per_unit) * sol.quantity)::numeric AS total,
          (((sol.unit_price - sol.discount_per_unit) * sol.quantity) * (1 - 1/vat_divisor(so.shipping_country)))::numeric AS tax
        FROM shopify_order_lines sol
        JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
        WHERE sol.sku = $1 AND sol.order_date::date BETWEEN $2 AND $3 AND so.financial_status != 'voided'
      `);
      refundsParts.push(`
        SELECT 'shopify' AS channel, st.transaction_date AS order_date, so.shipping_country AS marketplace,
          so.shopify_order_number::text AS order_id, 'Refunded'::text AS status, so.fulfillment_status AS fulfillment_channel,
          NULL::int AS quantity,
          (st.amount * (sol.line_gross / NULLIF(ot.order_gross,0)))::numeric AS total,
          ((st.amount * (sol.line_gross / NULLIF(ot.order_gross,0))) * (1 - 1/vat_divisor(so.shipping_country)))::numeric AS tax
        FROM shopify_transactions st
        JOIN shopify_order_lines sol ON sol.shopify_order_id = st.shopify_order_id AND sol.sku = $1
        LEFT JOIN shopify_orders so ON so.shopify_order_id = st.shopify_order_id
        JOIN (SELECT shopify_order_id, SUM(line_gross) AS order_gross FROM shopify_order_lines GROUP BY shopify_order_id) ot
          ON ot.shopify_order_id = st.shopify_order_id
        WHERE st.kind = 'refund' AND st.status = 'success' AND st.transaction_date::date BETWEEN $2 AND $3
      `);
    }

    const [ordersResult, refundsResult] = await Promise.all([
      pool.query(`${ordersParts.join(' UNION ALL ')} ORDER BY order_date DESC LIMIT $4`, [sku, dateFrom, dateTo, rowLimit]),
      pool.query(`${refundsParts.join(' UNION ALL ')} ORDER BY order_date DESC LIMIT $4`, [sku, dateFrom, dateTo, rowLimit]),
    ]);

    const mapRow = (r) => {
      const total = fx(r.total);
      const tax = fx(r.tax);
      return {
        channel: r.channel,
        order_date: r.order_date,
        marketplace: r.marketplace,
        order_id: r.order_id,
        status: r.status,
        fulfillment: r.fulfillment_channel === 'AFN' ? 'FBA' : r.fulfillment_channel === 'MFN' ? 'FBM' : (r.fulfillment_channel || null),
        quantity: r.quantity,
        net: (total - tax).toFixed(2),
        tax: tax.toFixed(2),
        total: total.toFixed(2),
      };
    };

    res.json({
      currency_symbol: currencySymbol(reportingCurrency),
      orders: ordersResult.rows.map(mapRow),
      refunds: refundsResult.rows.map(mapRow),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Settings — COGS: get all SKUs with current COGS and entry count
app.get('/api/settings/cogs', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        all_skus.sku,
        COALESCE(sp.product_name, aol.title, sol.product_title) AS product_name,
        sp.asin,
        sp.image_url,
        sp.brand,
        sp.parent_asin,
        COALESCE(sp.unit_cogs, 0) AS unit_cogs,
        ce.cogs_standard,
        ce.cogs_freight,
        ce.cogs_demurrage,
        ce.cogs_quality,
        ce.cogs_other,
        COALESCE(ce.cogs_currency, 'GBP') AS cogs_currency,
        ce.effective_from,
        ce.effective_to,
        ce.notes,
        COALESCE(entry_count.cnt, 0)::int AS entry_count
      FROM (
        SELECT DISTINCT sku FROM (
          SELECT sku FROM amazon_order_lines WHERE sku IS NOT NULL
          UNION
          SELECT sku FROM shopify_order_lines WHERE sku IS NOT NULL
        ) s
      ) all_skus
      LEFT JOIN sku_parameters sp ON sp.sku = all_skus.sku
      LEFT JOIN LATERAL (
        SELECT title FROM amazon_order_lines WHERE sku = all_skus.sku LIMIT 1
      ) aol ON true
      LEFT JOIN LATERAL (
        SELECT product_title FROM shopify_order_lines WHERE sku = all_skus.sku LIMIT 1
      ) sol ON true
      LEFT JOIN LATERAL (
        SELECT * FROM cogs_entries
        WHERE sku = all_skus.sku AND effective_to IS NULL
        ORDER BY effective_from DESC LIMIT 1
      ) ce ON true
      LEFT JOIN (
        SELECT sku, COUNT(*) AS cnt FROM cogs_entries GROUP BY sku
      ) entry_count ON entry_count.sku = all_skus.sku
      ORDER BY COALESCE(sp.product_name, aol.title, sol.product_title)
    `);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// CSV helpers for the COGS bulk export/import round-trip below.
function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip, \n handles the line break */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// Settings — COGS: export all SKUs (with full entry history, one row per entry; SKUs with
// no entries yet get a single blank template row) as CSV, for bulk editing in Excel.
// NOTE: registered before the /:sku-parameterized routes below — otherwise Express would
// match "export"/"import" as a :sku value on those routes and this would be unreachable.
app.get('/api/settings/cogs/export', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        all_skus.sku,
        COALESCE(sp.product_name, aol.title, sol.product_title) AS product_name,
        ce.id, ce.effective_from, ce.effective_to,
        ce.cogs_standard, ce.cogs_freight, ce.cogs_demurrage, ce.cogs_quality, ce.cogs_other,
        COALESCE(ce.cogs_currency, 'GBP') AS cogs_currency,
        ce.notes
      FROM (
        SELECT DISTINCT sku FROM (
          SELECT sku FROM amazon_order_lines WHERE sku IS NOT NULL
          UNION
          SELECT sku FROM shopify_order_lines WHERE sku IS NOT NULL
        ) s
      ) all_skus
      LEFT JOIN sku_parameters sp ON sp.sku = all_skus.sku
      LEFT JOIN LATERAL (SELECT title FROM amazon_order_lines WHERE sku = all_skus.sku LIMIT 1) aol ON true
      LEFT JOIN LATERAL (SELECT product_title FROM shopify_order_lines WHERE sku = all_skus.sku LIMIT 1) sol ON true
      LEFT JOIN cogs_entries ce ON ce.sku = all_skus.sku
      ORDER BY COALESCE(sp.product_name, aol.title, sol.product_title), all_skus.sku, ce.effective_from DESC NULLS LAST
    `);

    const header = ['id', 'sku', 'product_name', 'effective_from', 'effective_to', 'cogs_standard', 'cogs_freight', 'cogs_demurrage', 'cogs_quality', 'cogs_other', 'cogs_currency', 'notes'];
    const toDate = (d) => d ? new Date(d).toISOString().split('T')[0] : '';
    const lines = [header.join(',')];
    for (const r of result.rows) {
      lines.push([
        r.id ?? '', csvEscape(r.sku), csvEscape(r.product_name || ''),
        toDate(r.effective_from), toDate(r.effective_to),
        r.cogs_standard ?? '', r.cogs_freight ?? '', r.cogs_demurrage ?? '', r.cogs_quality ?? '', r.cogs_other ?? '',
        r.cogs_currency || 'GBP', csvEscape(r.notes || ''),
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cogs_export_${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Settings — COGS: bulk import from the CSV produced by /export. Rows with an `id` update
// that entry in place; rows without one insert a new entry (auto-closing the previous open
// entry for that SKU, same as the single-entry POST). Blank template rows (no effective_from
// and no id) are skipped. Each row succeeds/fails independently so one bad row in a large
// sheet doesn't roll back the rest of the import.
app.post('/api/settings/cogs/import', async (req, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) return res.status(400).json({ error: 'Empty CSV body' });
  const rows = parseCsv(text);
  if (!rows.length) return res.status(400).json({ error: 'No rows found' });
  const header = rows[0].map(h => h.trim().toLowerCase());
  if (!header.includes('sku')) return res.status(400).json({ error: 'Missing required column: sku' });
  const col = (cols, name) => { const i = header.indexOf(name); return i === -1 ? '' : (cols[i] || '').trim(); };
  const toNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

  const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const sku = col(cols, 'sku');
    const idVal = col(cols, 'id');
    const effective_from = col(cols, 'effective_from') || null;
    const effective_to = col(cols, 'effective_to') || null;
    if (!sku || (!idVal && !effective_from)) { results.skipped++; continue; }

    const cogs_standard = toNum(col(cols, 'cogs_standard'));
    const cogs_freight = toNum(col(cols, 'cogs_freight'));
    const cogs_demurrage = toNum(col(cols, 'cogs_demurrage'));
    const cogs_quality = toNum(col(cols, 'cogs_quality'));
    const cogs_other = toNum(col(cols, 'cogs_other'));
    const cogs_currency = col(cols, 'cogs_currency') || 'GBP';
    const notes = col(cols, 'notes') || null;
    const unit_cogs = cogs_standard + cogs_freight + cogs_demurrage + cogs_quality + cogs_other;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (idVal) {
        const r = await client.query(`
          UPDATE cogs_entries SET
            effective_from = COALESCE($1::date, effective_from), effective_to = $2::date,
            cogs_standard = $3, cogs_freight = $4, cogs_demurrage = $5,
            cogs_quality = $6, cogs_other = $7, cogs_currency = $8,
            unit_cogs = $9, notes = $10, updated_at = NOW()
          WHERE id = $11 RETURNING sku, effective_to IS NULL AS is_current
        `, [effective_from, effective_to, cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, cogs_currency, unit_cogs, notes, idVal]);
        if (!r.rows.length) { await client.query('ROLLBACK'); results.errors.push({ row: i + 1, sku, error: `Entry id ${idVal} not found` }); continue; }
        if (r.rows[0].is_current) {
          await client.query(`UPDATE sku_parameters SET unit_cogs = $1, updated_at = NOW() WHERE sku = $2`, [unit_cogs, r.rows[0].sku]);
        }
        await client.query('COMMIT');
        results.updated++;
      } else {
        await client.query(`
          UPDATE cogs_entries SET effective_to = $1::date - INTERVAL '1 day', updated_at = NOW()
          WHERE sku = $2 AND effective_to IS NULL AND effective_from < $1::date
        `, [effective_from, sku]);
        await client.query(`
          INSERT INTO cogs_entries (sku, effective_from, effective_to, cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, cogs_currency, unit_cogs, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [sku, effective_from, effective_to, cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, cogs_currency, unit_cogs, notes]);
        if (!effective_to) {
          await client.query(`
            INSERT INTO sku_parameters (sku, unit_cogs, is_active, updated_at)
            VALUES ($1, $2, true, NOW())
            ON CONFLICT (sku) DO UPDATE SET unit_cogs = $2, updated_at = NOW()
          `, [sku, unit_cogs]);
        }
        await client.query('COMMIT');
        results.inserted++;
      }
    } catch (e) {
      await client.query('ROLLBACK');
      results.errors.push({ row: i + 1, sku, error: e.message });
    } finally { client.release(); }
  }
  res.json({ ok: true, ...results });
});

// Settings — COGS: get history for a single SKU
app.get('/api/settings/cogs/:sku/history', async (req, res) => {
  const { sku } = req.params;
  try {
    const result = await pool.query(`
      SELECT id, sku, effective_from, effective_to,
        cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other,
        cogs_currency, unit_cogs, notes, created_at, updated_at
      FROM cogs_entries WHERE sku = $1
      ORDER BY effective_from DESC
    `, [sku]);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Settings — COGS: add new entry (auto-closes previous open entry)
app.post('/api/settings/cogs/:sku', async (req, res) => {
  const { sku } = req.params;
  const { effective_from, cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, cogs_currency = 'GBP', notes = null } = req.body;
  if (!effective_from) return res.status(400).json({ error: 'effective_from is required' });
  const toNum = (v) => parseFloat(v || 0) || 0;
  const unit_cogs = [cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other].reduce((s, v) => s + toNum(v), 0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Close previous open entry (set effective_to = effective_from - 1 day)
    await client.query(`
      UPDATE cogs_entries SET effective_to = $1::date - INTERVAL '1 day', updated_at = NOW()
      WHERE sku = $2 AND effective_to IS NULL AND effective_from < $1::date
    `, [effective_from, sku]);
    // Insert new entry
    const result = await client.query(`
      INSERT INTO cogs_entries (sku, effective_from, cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, cogs_currency, unit_cogs, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [sku, effective_from, toNum(cogs_standard), toNum(cogs_freight), toNum(cogs_demurrage), toNum(cogs_quality), toNum(cogs_other), cogs_currency, unit_cogs, notes]);
    // Update sku_parameters.unit_cogs with latest value
    await client.query(`
      INSERT INTO sku_parameters (sku, unit_cogs, is_active, updated_at)
      VALUES ($1, $2, true, NOW())
      ON CONFLICT (sku) DO UPDATE SET unit_cogs = $2, updated_at = NOW()
    `, [sku, unit_cogs]);
    await client.query('COMMIT');
    res.json({ ok: true, entry: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Settings — COGS: update an existing entry (inline edit)
app.put('/api/settings/cogs/entry/:id', async (req, res) => {
  const { id } = req.params;
  const { effective_from, effective_to, cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, cogs_currency = 'GBP', notes = null } = req.body;
  // Coerce empty strings to 0 to avoid numeric cast errors
  const toNum = (v) => parseFloat(v || 0) || 0;
  const std = toNum(cogs_standard), frt = toNum(cogs_freight), dem = toNum(cogs_demurrage), qty = toNum(cogs_quality), oth = toNum(cogs_other);
  const unit_cogs = std + frt + dem + qty + oth;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      UPDATE cogs_entries SET
        effective_from = $1, effective_to = $2,
        cogs_standard = $3, cogs_freight = $4, cogs_demurrage = $5,
        cogs_quality = $6, cogs_other = $7, cogs_currency = $8,
        unit_cogs = $9, notes = $10, updated_at = NOW()
      WHERE id = $11 RETURNING *, effective_to IS NULL AS is_current
    `, [effective_from, effective_to || null, std, frt, dem, qty, oth, cogs_currency, unit_cogs, notes, id]);
    if (!result.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Entry not found' }); }
    const entry = result.rows[0];
    // If this is the current (open) entry, update sku_parameters.unit_cogs too
    if (!entry.effective_to) {
      await client.query(`
        UPDATE sku_parameters SET unit_cogs = $1, updated_at = NOW() WHERE sku = $2
      `, [unit_cogs, entry.sku]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, entry });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// FX Rates — sync all pairs between GBP, USD, EUR from Frankfurter API (ECB data).
// Extracted from the route handler so it can also be called on a schedule (see bottom of
// this file) — Settings.js has always told users this syncs "automatically", but until now
// nothing actually called this endpoint on its own, so exchange_rates could sit empty/stale
// and every getPeriodRate() lookup silently fell back to a rate of 1 (no visible conversion).
async function syncFxRates(daysBack = 3) {
  // Fetch GBP→USD and GBP→EUR from Frankfurter, then derive all 6 pairs
  const basePairs = [['GBP', 'USD'], ['GBP', 'EUR']];
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];

  // Collect raw rates keyed by date
  const rawRates = {}; // { '2024-01-15': { 'GBP_USD': 1.27, 'GBP_EUR': 1.17 } }
  for (const [base, target] of basePairs) {
    const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=${base}&to=${target}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.rates) continue;
    for (const [date, rates] of Object.entries(data.rates)) {
      if (!rawRates[date]) rawRates[date] = {};
      rawRates[date][`${base}_${target}`] = parseFloat(rates[target]);
    }
  }

  let synced = 0;
  for (const [date, rates] of Object.entries(rawRates)) {
    const gbpUsd = rates['GBP_USD'];
    const gbpEur = rates['GBP_EUR'];
    if (!gbpUsd || !gbpEur) continue;

    // Derive all 6 pairs
    const pairs = [
      ['GBP', 'USD', gbpUsd],
      ['GBP', 'EUR', gbpEur],
      ['USD', 'GBP', 1 / gbpUsd],
      ['EUR', 'GBP', 1 / gbpEur],
      ['USD', 'EUR', gbpEur / gbpUsd],
      ['EUR', 'USD', gbpUsd / gbpEur],
    ];

    for (const [base, target, rate] of pairs) {
      await pool.query(`
        INSERT INTO exchange_rates (date, base_currency, target_currency, rate, source, created_at)
        VALUES ($1, $2, $3, $4, 'frankfurter', NOW())
        ON CONFLICT (date, base_currency, target_currency) DO UPDATE SET rate = EXCLUDED.rate
      `, [date, base, target, rate]);
      synced++;
    }
  }
  return { synced, days: Object.keys(rawRates).length };
}

app.post('/api/sync-fx', async (req, res) => {
  const { daysBack = 3 } = req.body || {};
  try {
    const result = await syncFxRates(daysBack);
    res.json({ ok: true, ...result });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Client config — get reporting currency + timezone + company details (for report headers/exports)
app.get('/api/settings/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT reporting_currency, timezone, client_name, company_address, company_id, vat_number, company_country FROM client_config LIMIT 1');
    const row = result.rows[0] || { reporting_currency: 'GBP', timezone: 'UTC' };
    // vat_registered is derived, not stored - presence of a VAT number IS the registration
    // signal (see vat_divisor() in the migration above). Exposed here read-only so Settings can
    // show status without a separate toggle that could drift out of sync with the VAT number.
    row.vat_registered = !!(row.vat_number && row.vat_number.trim());
    res.json(row);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Client config — update reporting currency, timezone, and/or company details. Each field is
// optional - only the ones present in the request body are changed (COALESCE keeps the rest
// as-is), so the currency selector, timezone selector, and company info form on the Settings
// page can save independently.
app.put('/api/settings/config', async (req, res) => {
  const { reporting_currency, timezone, client_name, company_address, company_id, vat_number, company_country } = req.body;
  if (reporting_currency !== undefined && !['GBP', 'USD', 'EUR'].includes(reporting_currency)) {
    return res.status(400).json({ error: 'Invalid currency' });
  }
  // Matches the IANA_TZ_PATTERN used for the pooled-connection SET TIME ZONE near the top of
  // this file - keep these in sync.
  if (timezone !== undefined && !/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/.test(timezone)) {
    return res.status(400).json({ error: 'Invalid timezone' });
  }
  if (company_country !== undefined && company_country !== null && company_country !== '' && !/^[A-Z]{2}$/.test(company_country)) {
    return res.status(400).json({ error: 'company_country must be a 2-letter ISO code' });
  }
  try {
    const result = await pool.query(`
      UPDATE client_config SET
        reporting_currency = COALESCE($1, reporting_currency),
        timezone = COALESCE($2, timezone),
        client_name = COALESCE($3, client_name),
        company_address = COALESCE($4, company_address),
        company_id = COALESCE($5, company_id),
        vat_number = COALESCE($6, vat_number),
        company_country = COALESCE(NULLIF($7, ''), company_country),
        updated_at = NOW()
      RETURNING reporting_currency, timezone, client_name, company_address, company_id, vat_number, company_country
    `, [reporting_currency ?? null, timezone ?? null, client_name ?? null, company_address ?? null, company_id ?? null, vat_number ?? null, company_country ?? null]);
    const row = result.rows[0] || {};
    row.vat_registered = !!(row.vat_number && row.vat_number.trim());
    res.json({ ok: true, ...row });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// VAT rates — list/add/update/remove per-country standard rates. Used by vat_divisor()/
// vat_divisor_seller() (see migration above) to strip VAT from sales/fees for VAT-registered
// accounts; editable here since rates do change and new countries come up as a business expands.
app.get('/api/settings/vat-rates', async (req, res) => {
  try {
    const result = await pool.query('SELECT country_code, country_name, standard_rate FROM vat_rates ORDER BY country_name');
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.put('/api/settings/vat-rates/:code', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const { country_name, standard_rate } = req.body;
  if (!/^[A-Z]{2}$/.test(code)) return res.status(400).json({ error: 'country_code must be a 2-letter ISO code' });
  const rate = parseFloat(standard_rate);
  if (!country_name || isNaN(rate) || rate < 0 || rate > 100) {
    return res.status(400).json({ error: 'country_name and a standard_rate between 0 and 100 are required' });
  }
  try {
    await pool.query(`
      INSERT INTO vat_rates (country_code, country_name, standard_rate, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (country_code) DO UPDATE SET country_name = EXCLUDED.country_name, standard_rate = EXCLUDED.standard_rate, updated_at = NOW()
    `, [code, country_name, rate]);
    res.json({ ok: true, country_code: code, country_name, standard_rate: rate });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/settings/vat-rates/:code', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  try {
    await pool.query('DELETE FROM vat_rates WHERE country_code = $1', [code]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Brands and parent ASINs — for filter dropdowns
app.get('/api/brands', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT brand FROM sku_parameters WHERE brand IS NOT NULL ORDER BY brand
    `);
    const parentResult = await pool.query(`
      SELECT DISTINCT parent_asin FROM sku_parameters WHERE parent_asin IS NOT NULL ORDER BY parent_asin
    `);
    res.json({
      brands: result.rows.map(r => r.brand),
      parent_asins: parentResult.rows.map(r => r.parent_asin),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Inventory — latest FBA stock snapshot per SKU
app.get('/api/inventory', async (req, res) => {
  try {
    // Sales velocity windows for the "days of inventory left" estimate below - a seasonal
    // PY-based forecast rather than a flat trailing average, so a SKU about to enter its high
    // season (e.g. a Christmas item) doesn't read as having ample runway just because the last
    // 90 days were quiet. Base velocity comes from PY's units in the calendar-equivalent NEXT
    // 90 days (i.e. what happened a year ago in the period that seasonally corresponds to
    // what's coming up), then scaled by this SKU's own YoY growth rate (this year's trailing
    // 90D vs PY's same trailing 90D) so a growing or shrinking SKU still gets an accurate
    // forecast, not just last year's raw shape.
    const velocityNow = new Date();
    const fmtDate = (d) => d.toISOString().split('T')[0];
    const cyTrailingEnd = new Date(velocityNow);
    const cyTrailingStart = new Date(velocityNow); cyTrailingStart.setDate(cyTrailingStart.getDate() - 89);
    const pyAnchor = new Date(velocityNow); pyAnchor.setFullYear(pyAnchor.getFullYear() - 1);
    const pyTrailingEnd = new Date(pyAnchor);
    const pyTrailingStart = new Date(pyAnchor); pyTrailingStart.setDate(pyTrailingStart.getDate() - 89);
    const pyForwardStart = new Date(pyAnchor);
    const pyForwardEnd = new Date(pyAnchor); pyForwardEnd.setDate(pyForwardEnd.getDate() + 89);

    const result = await pool.query(`
      WITH sales_velocity AS (
        SELECT aol.sku,
          SUM(CASE WHEN ao.order_date::date BETWEEN $1 AND $2 THEN aol.quantity ELSE 0 END)::int AS cy_trailing_units,
          SUM(CASE WHEN ao.order_date::date BETWEEN $3 AND $4 THEN aol.quantity ELSE 0 END)::int AS py_trailing_units,
          SUM(CASE WHEN ao.order_date::date BETWEEN $5 AND $6 THEN aol.quantity ELSE 0 END)::int AS py_forward_units
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        WHERE ao.status != 'Canceled' AND ao.order_date::date BETWEEN $3 AND $2
        GROUP BY aol.sku
      ),
      latest AS (
        SELECT DISTINCT ON (sku)
          sku, asin, fulfillable_quantity, inbound_working_quantity, inbound_shipped_quantity,
          inbound_receiving_quantity, reserved_quantity, unfulfillable_quantity,
          researching_quantity, total_quantity, snapshot_date
        FROM amazon_inventory_snapshots
        ORDER BY sku, snapshot_date DESC
      ),
      latest_aging AS (
        SELECT DISTINCT ON (sku) sku, age_0_90, age_91_180, age_181_270, age_271_365, age_365_plus
        FROM amazon_inventory_aging
        ORDER BY sku, snapshot_date DESC
      ),
      -- Real £-per-unit MONTHLY surcharge rate, from the most recent LTSF billing cycle only
      -- (not blended across all of history - the per-unit-volume rate drifts over time, and
      -- this is meant to answer "what does this cost every month it stays unsold", i.e. the
      -- current rate, not a stale average from charges months/years ago). LTSF bills monthly,
      -- so every unit still sitting in the 271+/365+ buckets repeats this charge each cycle.
      latest_ltsf_month AS (
        SELECT sku, MAX(snapshot_date) AS latest_date FROM amazon_ltsf_charges GROUP BY sku
      ),
      ltsf_by_sku AS (
        SELECT c.sku,
          SUM(-c.amount)::numeric(12,4) AS total_surcharge_gbp,
          SUM(NULLIF(c.raw_json->>'qty-charged', '')::numeric) AS total_qty_charged
        FROM amazon_ltsf_charges c
        JOIN latest_ltsf_month m ON m.sku = c.sku AND c.snapshot_date = m.latest_date
        GROUP BY c.sku
      ),
      global_rate AS (
        -- Latest global billing cycle's blended rate, for SKUs with no charge history of
        -- their own yet.
        SELECT (SUM(-amount) / NULLIF(SUM(NULLIF(raw_json->>'qty-charged', '')::numeric), 0))::numeric(12,4) AS rate_per_unit
        FROM amazon_ltsf_charges
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM amazon_ltsf_charges)
      ),
      -- sku_parameters.product_name is never populated on this account - fall back to the
      -- real Amazon listing title captured per order line, which is populated for every SKU
      -- that's ever sold.
      order_title AS (
        SELECT DISTINCT ON (sku) sku, title
        FROM amazon_order_lines
        WHERE title IS NOT NULL
        ORDER BY sku, synced_at DESC
      )
      SELECT
        l.sku,
        COALESCE(l.asin, sp.asin) AS asin,
        sp.image_url,
        COALESCE(sp.product_name, ot.title) AS product_title,
        l.fulfillable_quantity::int AS sellable,
        (l.inbound_working_quantity + l.inbound_shipped_quantity + l.inbound_receiving_quantity)::int AS inbound,
        l.unfulfillable_quantity::int AS damaged,
        (l.reserved_quantity + l.researching_quantity)::int AS other,
        l.total_quantity::int AS total,
        l.snapshot_date,
        COALESCE(la.age_0_90, 0)::int AS age_0_90,
        COALESCE(la.age_91_180, 0)::int AS age_91_180,
        COALESCE(la.age_181_270, 0)::int AS age_181_270,
        COALESCE(la.age_271_365, 0)::int AS age_271_365,
        COALESCE(la.age_365_plus, 0)::int AS age_365_plus,
        COALESCE(
          ltsf.total_surcharge_gbp / NULLIF(ltsf.total_qty_charged, 0),
          (SELECT rate_per_unit FROM global_rate),
          0
        )::numeric(12,4) AS rate_per_unit_gbp,
        COALESCE(sv.cy_trailing_units, 0)::int AS cy_trailing_units,
        COALESCE(sv.py_trailing_units, 0)::int AS py_trailing_units,
        COALESCE(sv.py_forward_units, 0)::int AS py_forward_units
      FROM latest l
      LEFT JOIN sku_parameters sp ON sp.sku = l.sku
      LEFT JOIN latest_aging la ON la.sku = l.sku
      LEFT JOIN ltsf_by_sku ltsf ON ltsf.sku = l.sku
      LEFT JOIN order_title ot ON ot.sku = l.sku
      LEFT JOIN sales_velocity sv ON sv.sku = l.sku
      ORDER BY l.total_quantity DESC
    `, [fmtDate(cyTrailingStart), fmtDate(cyTrailingEnd), fmtDate(pyTrailingStart), fmtDate(pyTrailingEnd), fmtDate(pyForwardStart), fmtDate(pyForwardEnd)]);

    const reportingCurrency = await getReportingCurrency();
    const today = new Date().toISOString().split('T')[0];
    const fxRate = await getFxRate('GBP', reportingCurrency, today);
    const sym = { GBP: '£', USD: '$', EUR: '€' }[reportingCurrency] || '£';

    // Reconcile the age-bucket breakdown (from the separate Inventory Planning report) to sum
    // to `sellable` (from the live Inventory API) rather than showing two Amazon sources that
    // were fetched independently and won't line up. Inbound units are excluded on purpose -
    // they aren't in a fulfillment center yet, so "age" doesn't apply to them. The bucket
    // *shape* (relative proportions) comes from Amazon's real aging report; only the total is
    // re-anchored to the trusted sellable count.
    const AGE_KEYS = ['age_0_90', 'age_91_180', 'age_181_270', 'age_271_365', 'age_365_plus'];
    const rows = result.rows.map(r => {
      const sellable = parseInt(r.sellable || 0);
      const rawBuckets = AGE_KEYS.map(k => parseInt(r[k] || 0));
      const rawTotal = rawBuckets.reduce((s, v) => s + v, 0);
      let buckets = rawBuckets;
      if (rawTotal > 0 && sellable > 0) {
        buckets = rawBuckets.map(v => Math.round((v / rawTotal) * sellable));
        // Rounding can leave the scaled buckets a unit or two off `sellable` - correct the
        // largest bucket so the row's own numbers always sum exactly.
        const scaledTotal = buckets.reduce((s, v) => s + v, 0);
        const diff = sellable - scaledTotal;
        if (diff !== 0) {
          const maxIdx = buckets.indexOf(Math.max(...buckets));
          buckets[maxIdx] += diff;
        }
      } else if (rawTotal === 0) {
        buckets = AGE_KEYS.map(() => 0); // no aging data synced yet - nothing to distribute
      }
      // Accumulated units already old enough to be billed the long-term storage surcharge
      // (271-365 + 365+) - LTSF is a recurring MONTHLY charge, so every one of these units
      // repeats this cost again next cycle for as long as it stays unsold.
      const agedUnits = buckets[3] + buckets[4];
      const monthlySurcharge = agedUnits * parseFloat(r.rate_per_unit_gbp || 0) * fxRate;

      // Days of inventory left = sellable units / projected daily sales velocity. Velocity is a
      // seasonal PY forecast, not a flat trailing average: base = PY's units in the
      // calendar-equivalent NEXT 90 days (what happened a year ago in the period that
      // seasonally corresponds to what's coming), scaled by this SKU's own YoY growth rate
      // (this year's trailing 90D vs PY's same trailing 90D). Falls back to a flat trailing-90D
      // rate for SKUs with no comparable PY window (e.g. launched within the last year).
      const cyTrailingUnits = parseInt(r.cy_trailing_units || 0, 10);
      const pyTrailingUnits = parseInt(r.py_trailing_units || 0, 10);
      const pyForwardUnits = parseInt(r.py_forward_units || 0, 10);
      let dailyVelocity;
      if (pyForwardUnits > 0) {
        const growthPct = pyTrailingUnits > 0 ? (cyTrailingUnits - pyTrailingUnits) / pyTrailingUnits : 0;
        dailyVelocity = Math.max(0, (pyForwardUnits / 90) * (1 + growthPct));
      } else if (cyTrailingUnits > 0) {
        dailyVelocity = cyTrailingUnits / 90;
      } else {
        dailyVelocity = 0;
      }
      const daysOfInventory = dailyVelocity > 0 ? sellable / dailyVelocity : null;

      const out = {
        ...r,
        surcharge_monthly: monthlySurcharge.toFixed(2),
        daily_velocity: dailyVelocity.toFixed(2),
        days_of_inventory: daysOfInventory === null ? null : Math.round(daysOfInventory),
      };
      AGE_KEYS.forEach((k, i) => { out[k] = buckets[i]; });
      delete out.rate_per_unit_gbp;
      delete out.cy_trailing_units;
      delete out.py_trailing_units;
      delete out.py_forward_units;
      return out;
    });

    res.json({ currency_symbol: sym, rows });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Inventory units + £ value over time, optionally filtered to a single SKU.
// Value uses each SKU's current COGS rate (itemized, falling back to flat unit_cogs) applied
// uniformly across history - not date-matched to historical cogs_entries like the P&L pages,
// since this is a present-day valuation of past stock levels, not a historical revenue figure.
app.get('/api/inventory/history', async (req, res) => {
  const { sku } = req.query;
  try {
    const result = await pool.query(`
      SELECT
        s.snapshot_date,
        SUM(s.total_quantity)::int AS units,
        SUM(s.fulfillable_quantity)::int AS sellable_units,
        SUM(s.total_quantity * (
          COALESCE(
          NULLIF(sp.cogs_standard, 0),
          CASE WHEN COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
            THEN COALESCE(sp.unit_cogs, 0) ELSE 0 END, 0)
          + COALESCE(NULLIF(sp.cogs_freight,   0), 0)
          + COALESCE(NULLIF(sp.cogs_demurrage, 0), 0)
          + COALESCE(NULLIF(sp.cogs_quality,   0), 0)
          + COALESCE(NULLIF(sp.cogs_other,     0), 0)
        ))::numeric(12,2) AS value_gbp,
        SUM(s.fulfillable_quantity * (
          COALESCE(
          NULLIF(sp.cogs_standard, 0),
          CASE WHEN COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
            THEN COALESCE(sp.unit_cogs, 0) ELSE 0 END, 0)
          + COALESCE(NULLIF(sp.cogs_freight,   0), 0)
          + COALESCE(NULLIF(sp.cogs_demurrage, 0), 0)
          + COALESCE(NULLIF(sp.cogs_quality,   0), 0)
          + COALESCE(NULLIF(sp.cogs_other,     0), 0)
        ))::numeric(12,2) AS sellable_value_gbp
      FROM amazon_inventory_snapshots s
      LEFT JOIN sku_parameters sp ON sp.sku = s.sku
      WHERE $1::text IS NULL OR s.sku = $1
      GROUP BY s.snapshot_date
      ORDER BY s.snapshot_date
    `, [sku || null]);

    const reportingCurrency = await getReportingCurrency();
    const today = new Date().toISOString().split('T')[0];
    const fxRate = await getFxRate('GBP', reportingCurrency, today);
    const sym = { GBP: '£', USD: '$', EUR: '€' }[reportingCurrency] || '£';

    res.json({
      currency_symbol: sym,
      rows: result.rows.map(r => ({
        snapshot_date: r.snapshot_date,
        units: r.units,
        sellable_units: r.sellable_units,
        value: (parseFloat(r.value_gbp || 0) * fxRate).toFixed(2),
        sellable_value: (parseFloat(r.sellable_value_gbp || 0) * fxRate).toFixed(2),
      })),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Sell-through rate per month: units sold that month / units on hand that month (as a %).
// Built entirely from data already synced (orders + inventory snapshots) - no new Amazon
// report needed, unlike the aging endpoint below.
app.get('/api/inventory/sell-through', async (req, res) => {
  const { sku } = req.query;
  try {
    const result = await pool.query(`
      WITH monthly_sales AS (
        SELECT date_trunc('month', ao.order_date)::date AS month, aol.sku, SUM(aol.quantity) AS qty
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        WHERE ao.status != 'Canceled' AND ($1::text IS NULL OR aol.sku = $1)
        GROUP BY 1, 2
        UNION ALL
        SELECT date_trunc('month', sol.order_date)::date AS month, sol.sku, SUM(sol.quantity) AS qty
        FROM shopify_order_lines sol
        WHERE $1::text IS NULL OR sol.sku = $1
        GROUP BY 1, 2
      ),
      sales_by_month AS (
        SELECT month, SUM(qty)::int AS units_sold FROM monthly_sales GROUP BY month
      ),
      latest_snapshot_per_month AS (
        SELECT date_trunc('month', snapshot_date)::date AS month, MAX(snapshot_date) AS latest_date
        FROM amazon_inventory_snapshots
        WHERE $1::text IS NULL OR sku = $1
        GROUP BY 1
      ),
      inventory_by_month AS (
        SELECT l.month, SUM(s.total_quantity)::int AS units_on_hand
        FROM latest_snapshot_per_month l
        JOIN amazon_inventory_snapshots s ON s.snapshot_date = l.latest_date
        WHERE $1::text IS NULL OR s.sku = $1
        GROUP BY l.month
      )
      SELECT
        i.month AS snapshot_date,
        i.units_on_hand,
        COALESCE(s.units_sold, 0) AS units_sold,
        CASE WHEN i.units_on_hand > 0 THEN ROUND(COALESCE(s.units_sold,0)::numeric / i.units_on_hand * 100, 1) ELSE 0 END AS sell_through_pct
      FROM inventory_by_month i
      LEFT JOIN sales_by_month s ON s.month = i.month
      ORDER BY i.month
    `, [sku || null]);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Cash reconciliation — Amazon-only, one row per settled bi-weekly payout period, comparing
// what Amazon actually reported for that settlement (from amazon_payouts, straight from their
// FinancialEventGroupList) against what our own synced data says happened over the same window.
// Deliberately narrow in scope per the actual ask: no COGS, no Shopify, no reserve/carry-over
// balance bridging (beginning_balance/net_transfer) - just "is our number close to Amazon's
// number for this settlement period," using only settled fees (is_estimated_fee = false) and
// non-cancelled orders, so a real data gap isn't masked by orders/fees that haven't settled yet.
// Deliberately RAW/VAT-inclusive on both sides (no vat_divisor/vat_divisor_seller applied) -
// this compares against literal cash Amazon moved, not the VAT-exclusive figures the rest of
// the app may show a VAT-registered client for reporting purposes.
app.get('/api/cash-reconciliation', async (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query(`
      WITH periods AS (
        SELECT
          financial_event_group_id,
          ledger_close_date::date AS period_end,
          fund_transfer_date::date AS fund_transfer_date,
          total_sales AS amz_sales,
          total_refunds AS amz_refunds,
          total_fees AS amz_fees,
          total_other AS amz_other,
          LAG(ledger_close_date::date) OVER (ORDER BY ledger_close_date) AS period_start
        FROM amazon_payouts
        WHERE fund_transfer_date IS NOT NULL AND ledger_close_date IS NOT NULL
      ),
      bounded_periods AS (
        -- Drops the very first settlement period on record - it has no prior period to bound
        -- its start date, so we can't know which orders/fees belong to it without guessing.
        SELECT * FROM periods
        WHERE period_start IS NOT NULL AND period_end BETWEEN $1 AND $2
      ),
      our_refunds AS (
        SELECT financial_event_group_id, SUM(amount_refunded) AS refunds
        FROM amazon_order_line_refunds
        GROUP BY 1
      ),
      our_account_fees AS (
        -- Unlike the P&L page, FBALongTermStorageFee is NOT excluded here - this is a cash-basis
        -- reconciliation, so the settlement-dated fee from Financial Events (what actually got
        -- deducted this period) is the right number, not the accrual-dated snapshot report P&L uses.
        SELECT financial_event_group_id, SUM(amount) AS fees
        FROM amazon_account_fees
        WHERE fee_type NOT IN ('ReserveDebit', 'ReserveCredit') AND event_source != 'Adjustment'
        GROUP BY 1
      )
      SELECT
        bp.financial_event_group_id, bp.period_start, bp.period_end, bp.fund_transfer_date,
        bp.amz_sales, bp.amz_refunds, bp.amz_fees, bp.amz_other,
        COALESCE(orl.our_sales, 0) AS our_sales,
        COALESCE(orl.our_line_fees, 0) AS our_line_fees,
        COALESCE(orl.has_unsettled, false) AS has_unsettled_fees,
        COALESCE(rf.refunds, 0) AS our_refunds,
        COALESCE(af.fees, 0) AS our_account_fees
      FROM bounded_periods bp
      LEFT JOIN LATERAL (
        SELECT
          SUM(aol.unit_price * aol.quantity + COALESCE(aol.shipping_price,0)) AS our_sales,
          SUM(COALESCE(aol.fee_commission,0) + COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_fixed_closing,0) +
              COALESCE(aol.fee_variable_closing,0) + COALESCE(aol.fee_digital_services,0) + COALESCE(aol.fee_giftwrap_chargeback,0) +
              COALESCE(aol.fee_shipping_chargeback,0)) FILTER (WHERE COALESCE(aol.is_estimated_fee, false) = false) AS our_line_fees,
          BOOL_OR(COALESCE(aol.is_estimated_fee, false)) AS has_unsettled
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        WHERE ao.order_date::date > bp.period_start AND ao.order_date::date <= bp.period_end
          AND ao.status != 'Canceled'
      ) orl ON true
      LEFT JOIN our_refunds rf ON rf.financial_event_group_id = bp.financial_event_group_id
      LEFT JOIN our_account_fees af ON af.financial_event_group_id = bp.financial_event_group_id
      ORDER BY bp.period_end DESC
    `, [dateFrom, dateTo]);

    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const fx = (n) => (parseFloat(n) || 0) * fxRate;

    const rows = result.rows.map(r => {
      const amazonNet = fx(r.amz_sales) - fx(r.amz_refunds) - fx(r.amz_fees) + fx(r.amz_other);
      // our_line_fees (from amazon_order_lines columns) is a POSITIVE magnitude; our_account_fees
      // (from amazon_account_fees.amount) is NEGATIVE-signed for costs - opposite conventions.
      // Total fee cost as a positive magnitude (matching amz_fees) is our_line_fees minus the
      // (already-negative) account fees, i.e. our_line_fees - our_account_fees, not their sum -
      // summing them was silently netting a charge against a cost instead of adding both costs.
      const ourAccountFeesMagnitude = -fx(r.our_account_fees); // sign-flip to a positive cost, matching our_line_fees
      const ourFeesTotal = fx(r.our_line_fees) + ourAccountFeesMagnitude;
      const ourNet = fx(r.our_sales) - fx(r.our_refunds) - ourFeesTotal;
      const gap = ourNet - amazonNet;
      const gapPct = amazonNet !== 0 ? (gap / Math.abs(amazonNet)) * 100 : null;
      return {
        financial_event_group_id: r.financial_event_group_id,
        period_start: r.period_start,
        period_end: r.period_end,
        fund_transfer_date: r.fund_transfer_date,
        has_unsettled_fees: r.has_unsettled_fees,
        amazon: {
          sales: fx(r.amz_sales).toFixed(2),
          refunds: fx(r.amz_refunds).toFixed(2),
          fees: fx(r.amz_fees).toFixed(2),
          other: fx(r.amz_other).toFixed(2),
          net: amazonNet.toFixed(2),
        },
        ours: {
          sales: fx(r.our_sales).toFixed(2),
          refunds: fx(r.our_refunds).toFixed(2),
          fees: ourFeesTotal.toFixed(2),
          // account_fees_only is the one genuinely precise fee sub-total (exact join via
          // financial_event_group_id, unlike line_fees which - like Sales - is only date-range
          // approximated since amazon_order_lines carries no settlement-group link). Exposed
          // separately so the UI doesn't present the whole (partly-approximate) Fees figure as
          // if it were as trustworthy as Refunds.
          account_fees_only: ourAccountFeesMagnitude.toFixed(2),
          line_fees_only: fx(r.our_line_fees).toFixed(2),
          net: ourNet.toFixed(2),
        },
        gap: gap.toFixed(2),
        gap_pct: gapPct === null ? null : gapPct.toFixed(2),
      };
    });

    // Cumulative summary across all returned periods — Sales specifically is only date-range
    // approximated per period (amazon_order_lines has no financial_event_group_id to join
    // exactly, unlike refunds/account fees), so an individual period's Sales gap can look noisy
    // (orders near a period boundary shifting between periods depending on shipment lag) even
    // when the underlying data is fine. That noise mostly cancels out in aggregate, so the
    // summed total across the selected range is the more trustworthy "is there a real gap" signal
    // than any single period row.
    const sum = (key) => rows.reduce((s, r) => s + parseFloat(r[key] || 0), 0);
    const sumPath = (obj, key) => rows.reduce((s, r) => s + parseFloat(obj(r)[key] || 0), 0);
    const summary = {
      periods: rows.length,
      amazon: {
        sales: sumPath(r => r.amazon, 'sales').toFixed(2),
        refunds: sumPath(r => r.amazon, 'refunds').toFixed(2),
        fees: sumPath(r => r.amazon, 'fees').toFixed(2),
        net: sumPath(r => r.amazon, 'net').toFixed(2),
      },
      ours: {
        sales: sumPath(r => r.ours, 'sales').toFixed(2),
        refunds: sumPath(r => r.ours, 'refunds').toFixed(2),
        fees: sumPath(r => r.ours, 'fees').toFixed(2),
        net: sumPath(r => r.ours, 'net').toFixed(2),
      },
      gap: sum('gap').toFixed(2),
    };
    const summaryAmazonNet = parseFloat(summary.amazon.net);
    summary.gap_pct = summaryAmazonNet !== 0 ? ((parseFloat(summary.gap) / Math.abs(summaryAmazonNet)) * 100).toFixed(2) : null;

    res.json({ rows, summary, currency_symbol: currencySymbol(reportingCurrency) });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Sync status
app.get('/api/sync-status', async (req, res) => {
  try {
    const result = await pool.query('SELECT source, status, last_synced_at, records_synced, last_error FROM sync_state ORDER BY source');
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/build/index.html')));

// ─── FEE ESTIMATE SYNC ────────────────────────────────────────────
// Finds Amazon order lines < 14 days old with no settled fees,
// calls SP-API proxy /estimate-fees, writes estimates with is_estimated_fee=TRUE.
// Real settled fees from Finances API always overwrite estimates.
// ──────────────────────────────────────────────────────────────────────────
const SPAPI_PROXY_URL = process.env.SPAPI_PROXY_URL || 'https://amazon-spapi-proxy-production.up.railway.app';
const SPAPI_PROXY_KEY = process.env.SPAPI_PROXY_KEY;

app.post('/api/sync-fee-estimates', async (req, res) => {
  try {
    const linesResult = await pool.query(`
      SELECT aol.order_item_id, aol.amazon_order_id, aol.sku, aol.asin,
        aol.quantity,
        COALESCE(NULLIF(aol.unit_price, 0), lp.last_price) AS unit_price,
        aol.unit_price_currency
      FROM amazon_order_lines aol
      JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
      LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
      WHERE ao.order_date::date >= CURRENT_DATE - 14
        AND ao.status != 'Canceled'
        AND (aol.fee_fba_fulfillment IS NULL OR aol.fee_fba_fulfillment = 0)
        AND (aol.is_estimated_fee IS NULL OR aol.is_estimated_fee = FALSE)
        AND aol.asin IS NOT NULL
        AND COALESCE(NULLIF(aol.unit_price, 0), lp.last_price) > 0
      ORDER BY ao.order_date DESC
    `);
    if (!linesResult.rows.length) {
      return res.json({ ok: true, message: 'No unsettled lines need fee estimates', estimated: 0 });
    }
    // Deduplicate by ASIN+price
    const asinPriceMap = new Map();
    for (const line of linesResult.rows) {
      const key = `${line.asin}::${line.unit_price}`;
      if (!asinPriceMap.has(key)) {
        asinPriceMap.set(key, { asin: line.asin, sku: line.sku, price: line.unit_price, currency: line.unit_price_currency || 'GBP' });
      }
    }
    const uniqueItems = [...asinPriceMap.values()];
    const proxyResp = await fetch(`${SPAPI_PROXY_URL}/estimate-fees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(SPAPI_PROXY_KEY ? { 'x-api-key': SPAPI_PROXY_KEY } : {}) },
      body: JSON.stringify(uniqueItems),
    });
    if (!proxyResp.ok) {
      const err = await proxyResp.json().catch(() => ({}));
      return res.status(502).json({ ok: false, error: 'Proxy error', details: err });
    }
    const proxyData = await proxyResp.json();
    if (!proxyData.ok) return res.status(502).json({ ok: false, error: proxyData.error });
    const feeMap = new Map();
    for (const r of proxyData.results || []) {
      if (r.status === 'Success') feeMap.set(`${r.asin}::${r.price}`, r);
    }
    let estimated = 0;
    for (const line of linesResult.rows) {
      const key = `${line.asin}::${line.unit_price}`;
      const fees = feeMap.get(key);
      if (!fees) continue;
      const qty = parseInt(line.quantity || 1);
      await pool.query(`
        UPDATE amazon_order_lines SET
          fee_fba_fulfillment  = $1,
          fee_commission       = $2,
          fee_digital_services = $3,
          fee_fixed_closing    = $4,
          is_estimated_fee     = TRUE,
          synced_at            = NOW()
        WHERE order_item_id = $5
          AND (fee_fba_fulfillment IS NULL OR fee_fba_fulfillment = 0)
      `, [
        (fees.fbaFee * qty).toFixed(2),
        (fees.referralFee * qty).toFixed(2),
        (fees.digitalServicesFee * qty).toFixed(2),
        ((fees.closingFee || 0) * qty).toFixed(2),
        line.order_item_id,
      ]);
      estimated++;
    }
    res.json({ ok: true, estimated, uniqueAsins: uniqueItems.length, total: linesResult.rows.length });
  } catch (err) {
    console.error('[fee-estimates]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
