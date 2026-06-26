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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/build')));

// ─── FX HELPERS ───────────────────────────────────────────────

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
    return result.rows[0]?.avg_rate ? parseFloat(result.rows[0].avg_rate) : 1;
  } catch { return 1; }
}

// Currency symbol helper
function currencySymbol(currency) {
  return { GBP: '£', USD: '$', EUR: '€' }[currency] || currency;
}

// ─── API ROUTES ───────────────────────────────────────────────

// KPI Summary
app.get('/api/summary', async (req, res) => {
  const { from, to, channel = 'all' } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  // Amazon orders enriched with v_sku_revenue rollup (gross/net incl. list-price fallback for Pending orders)
  const amazonEnriched = `
    SELECT o.amazon_order_id, o.order_date, o.status, o.promotion_discount,
      COALESCE(r.gross_sales, o.gross_revenue) AS gross_revenue,
      COALESCE(r.net_revenue, o.net_revenue) AS net_revenue
    FROM amazon_orders o
    LEFT JOIN (
      SELECT order_id, SUM(gross_sales)::numeric(12,2) AS gross_sales, SUM(net_revenue)::numeric(12,2) AS net_revenue
      FROM v_sku_revenue WHERE channel = 'amazon' GROUP BY order_id
    ) r ON r.order_id = o.amazon_order_id
  `;
  // Shopify orders enriched with v_sku_revenue rollup (list price gross, post-discount net)
  const shopifyEnriched = `
    SELECT o.shopify_order_id, o.order_date, o.financial_status, o.discount_amount,
      COALESCE(r.gross_sales, o.gross_revenue) AS gross_revenue,
      COALESCE(r.net_revenue, o.net_revenue) AS net_revenue
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
        SELECT COALESCE(SUM(amount_refunded), 0)::numeric AS total_refunded, COUNT(*)::int AS refund_count
        FROM v_refunds_by_date WHERE channel = $1 AND refund_date::date BETWEEN $2 AND $3
      `, [channel, dateFrom, dateTo]);
    } else {
      refundResult = await pool.query(`
        SELECT COALESCE(SUM(amount_refunded), 0)::numeric AS total_refunded, COUNT(*)::int AS refund_count
        FROM v_refunds_by_date WHERE refund_date::date BETWEEN $1 AND $2
      `, [dateFrom, dateTo]);
    }
    const refundRow = refundResult.rows[0];

    // COGS for the period — sum all orders' COGS using date-matched cogs_entries
    const cogsResult = await pool.query(`
      SELECT
        COALESCE(SUM(aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)), 0)::numeric AS total_cogs,
        COALESCE(SUM(COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_commission,0) +
          COALESCE(aol.fee_fixed_closing,0) + COALESCE(aol.fee_variable_closing,0) +
          COALESCE(aol.fee_digital_services,0)), 0)::numeric AS total_fees
      FROM amazon_order_lines aol
      JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
      LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
      LEFT JOIN LATERAL (
        SELECT unit_cogs FROM cogs_entries
        WHERE sku = aol.sku AND effective_from <= ao.order_date::date
          AND (effective_to IS NULL OR effective_to >= ao.order_date::date)
        ORDER BY effective_from DESC LIMIT 1
      ) ce ON true
      WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
      UNION ALL
      SELECT
        COALESCE(SUM(sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)), 0)::numeric AS total_cogs,
        0::numeric AS total_fees
      FROM shopify_order_lines sol
      LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
      LEFT JOIN LATERAL (
        SELECT unit_cogs FROM cogs_entries
        WHERE sku = sol.sku AND effective_from <= sol.order_date::date
          AND (effective_to IS NULL OR effective_to >= sol.order_date::date)
        ORDER BY effective_from DESC LIMIT 1
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
      COALESCE(r.gross_sales, o.gross_revenue) AS gross_revenue,
      COALESCE(r.net_revenue, o.net_revenue) AS net_revenue,
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
        SELECT DATE_TRUNC($1, order_date)::date AS period, SUM(gross_revenue)::numeric AS gross_revenue,
          SUM(net_revenue)::numeric AS net_revenue, COUNT(*)::int AS orders
        FROM (
          SELECT order_date, gross_revenue, net_revenue FROM shopify_orders
          WHERE order_date::date BETWEEN $2 AND $3 AND financial_status != 'voided'
          UNION ALL
          SELECT order_date, gross_revenue, net_revenue FROM (${amazonEnriched}) a
          WHERE order_date::date BETWEEN $2 AND $3 AND status != 'Canceled'
        ) combined GROUP BY 1 ORDER BY 1
      `, [trunc, dateFrom, dateTo]);
    } else if (channel === 'amazon') {
      result = await pool.query(`
        SELECT DATE_TRUNC($1, order_date)::date AS period, SUM(gross_revenue)::numeric AS gross_revenue,
          SUM(net_revenue)::numeric AS net_revenue, COUNT(*)::int AS orders
        FROM (${amazonEnriched}) a WHERE order_date::date BETWEEN $2 AND $3 AND status != 'Canceled'
        GROUP BY 1 ORDER BY 1
      `, [trunc, dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        SELECT DATE_TRUNC($1, order_date)::date AS period, SUM(gross_revenue)::numeric AS gross_revenue,
          SUM(net_revenue)::numeric AS net_revenue, COUNT(*)::int AS orders
        FROM shopify_orders WHERE order_date::date BETWEEN $2 AND $3 AND financial_status != 'voided'
        GROUP BY 1 ORDER BY 1
      `, [trunc, dateFrom, dateTo]);
    }

    // Refunds attributed by refund_date, grouped to the same period granularity,
    // subtracted from net_revenue (same logic as /api/summary).
    let refundResult;
    if (channel === 'amazon' || channel === 'shopify') {
      refundResult = await pool.query(`
        SELECT DATE_TRUNC($1, refund_date)::date AS period, COALESCE(SUM(amount_refunded), 0)::numeric AS total_refunded
        FROM v_refunds_by_date WHERE channel = $2 AND refund_date::date BETWEEN $3 AND $4
        GROUP BY 1
      `, [trunc, channel, dateFrom, dateTo]);
    } else {
      refundResult = await pool.query(`
        SELECT DATE_TRUNC($1, refund_date)::date AS period, COALESCE(SUM(amount_refunded), 0)::numeric AS total_refunded
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
          SELECT gateway, COUNT(*)::int AS orders, SUM(net_revenue)::numeric AS revenue
          FROM shopify_orders WHERE order_date::date BETWEEN $1 AND $2 AND financial_status != 'voided'
          GROUP BY gateway
          UNION ALL
          SELECT 'Amazon Payout' AS gateway, COUNT(*)::int AS orders, SUM(net_transfer)::numeric AS revenue
          FROM amazon_payouts
          WHERE fund_transfer_date::date BETWEEN $1 AND $2
          AND net_transfer != 0
        ) combined GROUP BY gateway ORDER BY revenue DESC
      `, [dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        SELECT gateway, COUNT(*)::int AS orders, SUM(net_revenue)::numeric AS revenue
        FROM shopify_orders WHERE order_date::date BETWEEN $1 AND $2 AND financial_status != 'voided'
        GROUP BY gateway ORDER BY revenue DESC
      `, [dateFrom, dateTo]);
    }
    res.json(result.rows);
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
        SELECT DATE_TRUNC($1, fund_transfer_date)::date AS period, 'Amazon Payout' AS gateway, SUM(net_transfer)::numeric AS revenue
        FROM amazon_payouts
        WHERE fund_transfer_date::date BETWEEN $2 AND $3 AND net_transfer != 0
        GROUP BY 1 ORDER BY 1
      `, [trunc, dateFrom, dateTo]);
    } else if (channel === 'all') {
      result = await pool.query(`
        SELECT period, gateway, SUM(revenue)::numeric AS revenue FROM (
          SELECT DATE_TRUNC($1, order_date)::date AS period, gateway, net_revenue AS revenue FROM shopify_orders
          WHERE order_date::date BETWEEN $2 AND $3 AND financial_status != 'voided'
          UNION ALL
          SELECT DATE_TRUNC($1, fund_transfer_date)::date AS period, 'Amazon Payout' AS gateway, net_transfer AS revenue
          FROM amazon_payouts
          WHERE fund_transfer_date::date BETWEEN $2 AND $3 AND net_transfer != 0
        ) combined GROUP BY 1, 2 ORDER BY 1, 2
      `, [trunc, dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        SELECT DATE_TRUNC($1, order_date)::date AS period, gateway, SUM(net_revenue)::numeric AS revenue
        FROM shopify_orders WHERE order_date::date BETWEEN $2 AND $3 AND financial_status != 'voided'
        GROUP BY 1, 2 ORDER BY 1, 2
      `, [trunc, dateFrom, dateTo]);
    }
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Shopify fees
app.get('/api/fees', async (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query(`
      SELECT SUM(fees)::numeric AS total_fees, SUM(charges_gross)::numeric AS gross_sales,
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
          o.fulfillment_channel AS fulfillment_status, COALESCE(r.gross_sales, o.gross_revenue) AS gross_revenue,
          COALESCE(r.net_revenue, o.net_revenue) AS net_revenue, COALESCE(o.total_refunded, 0) AS total_refunded,
          'Amazon' AS gateway, o.shipping_country, 'amazon' AS channel, COALESCE(r.is_estimated_price, false) AS is_estimated_price
        FROM amazon_orders o
        LEFT JOIN (${amazonRevenueRollup}) r ON r.order_id = o.amazon_order_id
        WHERE o.status != 'Canceled' ORDER BY o.order_date DESC LIMIT $1
      `, [limit || 10]);
    } else if (channel === 'all') {
      result = await pool.query(`
        SELECT * FROM (
          SELECT shopify_order_number::text AS shopify_order_number, order_date, financial_status, fulfillment_status,
            gross_revenue, net_revenue, total_refunded, gateway, shipping_country, 'shopify' AS channel, false AS is_estimated_price
          FROM shopify_orders WHERE financial_status != 'voided'
          UNION ALL
          SELECT o.amazon_order_id, o.order_date, o.status AS financial_status, o.fulfillment_channel AS fulfillment_status,
            COALESCE(r.gross_sales, o.gross_revenue) AS gross_revenue, COALESCE(r.net_revenue, o.net_revenue) AS net_revenue,
            COALESCE(o.total_refunded, 0) AS total_refunded, 'Amazon' AS gateway, o.shipping_country, 'amazon' AS channel,
            COALESCE(r.is_estimated_price, false) AS is_estimated_price
          FROM amazon_orders o
          LEFT JOIN (${amazonRevenueRollup}) r ON r.order_id = o.amazon_order_id
          WHERE o.status != 'Canceled'
        ) combined ORDER BY order_date DESC LIMIT $1
      `, [limit || 10]);
    } else {
      result = await pool.query(`
        SELECT shopify_order_number, order_date, financial_status, fulfillment_status,
          gross_revenue, net_revenue, total_refunded, gateway, shipping_country, 'shopify' AS channel, false AS is_estimated_price
        FROM shopify_orders WHERE financial_status != 'voided' ORDER BY order_date DESC LIMIT $1
      `, [limit || 10]);
    }
    res.json(result.rows);
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
        SELECT channel, order_id, sku, refund_date, amount_refunded, quantity_refunded
        FROM v_refunds_by_date
        WHERE channel = $1 AND refund_date::date BETWEEN $2 AND $3
        ORDER BY refund_date DESC LIMIT $4
      `, [channel, dateFrom, dateTo, limit || 20]);
    } else {
      result = await pool.query(`
        SELECT channel, order_id, sku, refund_date, amount_refunded, quantity_refunded
        FROM v_refunds_by_date
        WHERE refund_date::date BETWEEN $1 AND $2
        ORDER BY refund_date DESC LIMIT $3
      `, [dateFrom, dateTo, limit || 20]);
    }
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});


// Product Breakdown — per SKU, both channels, date filtered
app.get('/api/product-breakdown', async (req, res) => {
  const { from, to, channel = 'all', sort = 'gross_sales', dir = 'desc', brand, parent_asin } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const validSorts = ['gross_sales', 'net_revenue', 'units_sold', 'total_refunded', 'units_refunded', 'total_discounts', 'gross_profit', 'gross_margin_pct'];
  const sortCol = validSorts.includes(sort) ? sort : 'gross_sales';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';

  // Optional brand/parent_asin filter — restricts which SKUs are included
  const brandFilter = brand ? `AND sp.brand = '${brand.replace(/'/g, "''")}'` : '';
  const parentFilter = parent_asin ? `AND sp.parent_asin = '${parent_asin.replace(/'/g, "''")}'` : '';
  try {
    // Refunds by SKU, attributed by refund_date within selected range
    const refundCte = `
      refunds_by_sku AS (
        SELECT sku, SUM(amount_refunded)::numeric AS total_refunded, SUM(COALESCE(quantity_refunded,0))::int AS units_refunded
        FROM amazon_order_line_refunds
        WHERE sku IS NOT NULL AND refund_date::date BETWEEN $1 AND $2
        GROUP BY sku
      ),
      shopify_refunds_by_sku AS (
        SELECT
          sol.sku,
          SUM(
            st.amount * (sol.line_gross / NULLIF(order_totals.order_gross, 0))
          )::numeric AS total_refunded,
          COUNT(DISTINCT st.shopify_transaction_id)::int AS units_refunded
        FROM shopify_transactions st
        JOIN shopify_order_lines sol ON sol.shopify_order_id = st.shopify_order_id
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
      -- COGS per SKU: weighted by quantity at the COGS rate active on each order date
      -- For refunded units, COGS is credited back (net units = sold - refunded)
      amazon_cogs AS (
        SELECT
          aol.sku,
          SUM(aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0))::numeric AS total_cogs_sold,
          SUM(aol.quantity)::int AS cogs_units,
          SUM(COALESCE(aol.fee_fba_fulfillment, 0) + COALESCE(aol.fee_commission, 0) +
              COALESCE(aol.fee_fixed_closing, 0) + COALESCE(aol.fee_variable_closing, 0) +
              COALESCE(aol.fee_digital_services, 0))::numeric AS total_fees
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
        LEFT JOIN LATERAL (
          SELECT unit_cogs FROM cogs_entries
          WHERE sku = aol.sku
            AND effective_from <= ao.order_date::date
            AND (effective_to IS NULL OR effective_to >= ao.order_date::date)
          ORDER BY effective_from DESC LIMIT 1
        ) ce ON true
        WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
        GROUP BY aol.sku
      ),
      shopify_cogs AS (
        SELECT
          sol.sku,
          SUM(sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0))::numeric AS total_cogs_sold,
          SUM(sol.quantity)::int AS cogs_units,
          0::numeric AS total_fees
        FROM shopify_order_lines sol
        LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
        LEFT JOIN LATERAL (
          SELECT unit_cogs FROM cogs_entries
          WHERE sku = sol.sku
            AND effective_from <= sol.order_date::date
            AND (effective_to IS NULL OR effective_to >= sol.order_date::date)
          ORDER BY effective_from DESC LIMIT 1
        ) ce ON true
        WHERE sol.order_date::date BETWEEN $1 AND $2
        GROUP BY sol.sku
      ),
      cogs_by_sku AS (
        SELECT sku,
          SUM(total_cogs_sold)::numeric AS total_cogs_sold,
          SUM(total_fees)::numeric AS total_fees
        FROM (
          SELECT sku, total_cogs_sold, total_fees FROM amazon_cogs
          UNION ALL
          SELECT sku, total_cogs_sold, total_fees FROM shopify_cogs
        ) combined GROUP BY sku
      )
    `;

    let result;
    if (channel === 'shopify') {
      result = await pool.query(`
        WITH ${refundCte}
        SELECT
          sol.sku,
          MAX(sol.product_title) AS product_title,
          NULL AS asin,
          sp.image_url,
          sp.brand,
          sp.parent_asin,
          'shopify' AS channels,
          SUM(sol.quantity)::int AS units_sold,
          COALESCE(MAX(r.units_refunded), 0)::int AS units_refunded,
          SUM(sol.unit_price * sol.quantity)::numeric(12,2) AS gross_sales,
          (SUM(sol.unit_price * sol.quantity - sol.discount_per_unit * sol.quantity) - COALESCE(MAX(r.total_refunded), 0))::numeric(12,2) AS net_revenue,
          SUM(sol.discount_per_unit * sol.quantity)::numeric(12,2) AS total_discounts,
          COALESCE(MAX(r.total_refunded), 0)::numeric(12,2) AS total_refunded,
          COALESCE(MAX(cogs.total_cogs_sold), 0)::numeric(12,2) AS total_cogs,
          COALESCE(MAX(cogs.total_fees), 0)::numeric(12,2) AS total_fees
        FROM shopify_order_lines sol
        LEFT JOIN shopify_refunds_by_sku r ON r.sku = sol.sku
        LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
        LEFT JOIN cogs_by_sku cogs ON cogs.sku = sol.sku
        WHERE sol.order_date::date BETWEEN $1 AND $2 ${brandFilter} ${parentFilter}
        GROUP BY sol.sku, sp.image_url, sp.brand, sp.parent_asin
        ORDER BY ${sortCol} ${sortDir}
      `, [dateFrom, dateTo]);
    } else if (channel === 'amazon') {
      result = await pool.query(`
        WITH ${refundCte}
        SELECT
          aol.sku,
          MAX(aol.title) AS product_title,
          MAX(aol.asin) AS asin,
          sp.image_url,
          sp.brand,
          sp.parent_asin,
          'amazon' AS channels,
          SUM(aol.quantity)::int AS units_sold,
          COALESCE(MAX(r.units_refunded), 0)::int AS units_refunded,
          SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity)::numeric(12,2) AS gross_sales,
          (SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity - COALESCE(aol.promotion_discount,0)) - COALESCE(MAX(r.total_refunded), 0))::numeric(12,2) AS net_revenue,
          SUM(COALESCE(aol.promotion_discount,0))::numeric(12,2) AS total_discounts,
          COALESCE(MAX(r.total_refunded), 0)::numeric(12,2) AS total_refunded,
          COALESCE(MAX(cogs.total_cogs_sold), 0)::numeric(12,2) AS total_cogs,
          COALESCE(MAX(cogs.total_fees), 0)::numeric(12,2) AS total_fees
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
        LEFT JOIN refunds_by_sku r ON r.sku = aol.sku
        LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
        LEFT JOIN cogs_by_sku cogs ON cogs.sku = aol.sku
        WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled' ${brandFilter} ${parentFilter}
        GROUP BY aol.sku, sp.image_url, sp.brand, sp.parent_asin
        ORDER BY ${sortCol} ${sortDir}
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
            SUM(sol.unit_price * sol.quantity)::numeric(12,2) AS gross_sales,
            SUM(sol.unit_price * sol.quantity - sol.discount_per_unit * sol.quantity)::numeric(12,2) AS net_revenue,
            SUM(sol.discount_per_unit * sol.quantity)::numeric(12,2) AS total_discounts
          FROM shopify_order_lines sol
          WHERE sol.order_date::date BETWEEN $1 AND $2
          GROUP BY sol.sku
        ),
        amazon_skus AS (
          SELECT
            aol.sku,
            MAX(aol.title) AS product_title,
            MAX(aol.asin) AS asin,
            SUM(aol.quantity)::int AS units_sold,
            SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity)::numeric(12,2) AS gross_sales,
            SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity - COALESCE(aol.promotion_discount,0))::numeric(12,2) AS net_revenue,
            SUM(COALESCE(aol.promotion_discount,0))::numeric(12,2) AS total_discounts
          FROM amazon_order_lines aol
          JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
          LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
          WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
          GROUP BY aol.sku
        )
        SELECT
          COALESCE(s.sku, a.sku) AS sku,
          COALESCE(a.product_title, s.product_title) AS product_title,
          a.asin,
          sp.image_url,
          sp.brand,
          sp.parent_asin,
          CASE WHEN s.sku IS NOT NULL AND a.sku IS NOT NULL THEN 'both'
               WHEN s.sku IS NOT NULL THEN 'shopify'
               ELSE 'amazon' END AS channels,
          (COALESCE(s.units_sold, 0) + COALESCE(a.units_sold, 0))::int AS units_sold,
          COALESCE(r.units_refunded, 0)::int AS units_refunded,
          (COALESCE(s.gross_sales, 0) + COALESCE(a.gross_sales, 0))::numeric(12,2) AS gross_sales,
          (COALESCE(s.net_revenue, 0) + COALESCE(a.net_revenue, 0) - COALESCE(r.total_refunded, 0))::numeric(12,2) AS net_revenue,
          (COALESCE(s.total_discounts, 0) + COALESCE(a.total_discounts, 0))::numeric(12,2) AS total_discounts,
          COALESCE(r.total_refunded, 0)::numeric(12,2) AS total_refunded,
          COALESCE(cogs.total_cogs_sold, 0)::numeric(12,2) AS total_cogs,
          COALESCE(cogs.total_fees, 0)::numeric(12,2) AS total_fees
        FROM shopify_skus s
        FULL OUTER JOIN amazon_skus a ON a.sku = s.sku
        LEFT JOIN all_refunds_by_sku r ON r.sku = COALESCE(s.sku, a.sku)
        LEFT JOIN sku_parameters sp ON sp.sku = COALESCE(s.sku, a.sku)
        LEFT JOIN cogs_by_sku cogs ON cogs.sku = COALESCE(s.sku, a.sku)
        WHERE 1=1 ${brandFilter} ${parentFilter}
        ORDER BY ${sortCol} ${sortDir}
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
      const totalFees      = parseFloat(r.total_fees      || 0) * fxRate;
      // Gross Profit = Net Revenue − COGS − FBA fulfillment − listing fees
      const grossProfit    = netRevenue - totalCogs - totalFees;
      const grossMarginPct = netRevenue > 0 ? (grossProfit / netRevenue * 100) : 0;
      // Profit % = same as gross margin % until PPC/storage costs are available
      const profitPct      = grossMarginPct;
      return {
        ...r,
        gross_sales:      grossSales.toFixed(2),
        net_revenue:      netRevenue.toFixed(2),
        total_discounts:  totalDiscounts.toFixed(2),
        total_refunded:   totalRefunded.toFixed(2),
        total_cogs:       totalCogs.toFixed(2),
        total_fees:       totalFees.toFixed(2),
        gross_profit:     grossProfit.toFixed(2),
        gross_margin_pct: grossMarginPct.toFixed(1),
        profit_pct:       profitPct.toFixed(1),
      };
    });
    res.json(fxRows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
// Product Breakdown — P&L breakdown for a single SKU
app.get('/api/product-breakdown/pnl/:sku', async (req, res) => {
  const { sku } = req.params;
  const { from, to } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  try {
    const amzResult = await pool.query(`
      SELECT
        SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity)::numeric AS gross_sales,
        SUM(COALESCE(aol.promotion_discount, 0))::numeric AS discounts,
        SUM(COALESCE(aol.fee_commission, 0))::numeric AS fee_commission,
        SUM(COALESCE(aol.fee_fba_fulfillment, 0))::numeric AS fee_fba_fulfillment,
        SUM(COALESCE(aol.fee_fixed_closing, 0) + COALESCE(aol.fee_variable_closing, 0) + COALESCE(aol.fee_digital_services, 0) + COALESCE(aol.fee_giftwrap_chargeback, 0))::numeric AS fee_other,
        SUM(aol.quantity)::int AS units_sold,
        COALESCE(MAX(sp.cogs_standard), 0)::numeric AS cogs_standard,
        COALESCE(MAX(sp.cogs_freight), 0)::numeric AS cogs_freight,
        COALESCE(MAX(sp.cogs_demurrage), 0)::numeric AS cogs_demurrage,
        COALESCE(MAX(sp.cogs_quality), 0)::numeric AS cogs_quality,
        COALESCE(MAX(sp.cogs_other), 0)::numeric AS cogs_other
      FROM amazon_order_lines aol
      JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
      LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
      LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
      WHERE aol.sku = $1 AND ao.order_date::date BETWEEN $2 AND $3 AND ao.status != 'Canceled'
    `, [sku, dateFrom, dateTo]);

    const shpResult = await pool.query(`
      SELECT
        SUM(sol.unit_price * sol.quantity)::numeric AS gross_sales,
        SUM(sol.discount_per_unit * sol.quantity)::numeric AS discounts,
        SUM(sol.quantity)::int AS units_sold,
        COALESCE(MAX(sp.cogs_standard), 0)::numeric AS cogs_standard,
        COALESCE(MAX(sp.cogs_freight), 0)::numeric AS cogs_freight,
        COALESCE(MAX(sp.cogs_demurrage), 0)::numeric AS cogs_demurrage,
        COALESCE(MAX(sp.cogs_quality), 0)::numeric AS cogs_quality,
        COALESCE(MAX(sp.cogs_other), 0)::numeric AS cogs_other
      FROM shopify_order_lines sol
      LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
      WHERE sol.sku = $1 AND sol.order_date::date BETWEEN $2 AND $3
    `, [sku, dateFrom, dateTo]);

    const refundResult = await pool.query(`
      SELECT COALESCE(SUM(amount_refunded), 0)::numeric AS total_refunded
      FROM v_refunds_by_date WHERE sku = $1 AND refund_date::date BETWEEN $2 AND $3
    `, [sku, dateFrom, dateTo]);

    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const sym = { GBP: '£', USD: '$', EUR: '€' }[reportingCurrency] || '£';
    const fx = (n) => ((parseFloat(n) || 0) * fxRate);

    const amz = amzResult.rows[0] || {};
    const shp = shpResult.rows[0] || {};
    const totalRefunded = fx(refundResult.rows[0]?.total_refunded || 0);

    const grossSales  = fx(amz.gross_sales || 0) + fx(shp.gross_sales || 0);
    const discounts   = fx(amz.discounts || 0) + fx(shp.discounts || 0);
    const netRevenue  = grossSales - discounts - totalRefunded;

    const feeCommission = fx(amz.fee_commission || 0);
    const feeFBA        = fx(amz.fee_fba_fulfillment || 0);
    const feeOther      = fx(amz.fee_other || 0);
    const totalFees     = feeCommission + feeFBA + feeOther;

    // COGS: use per-unit component rates from sku_parameters × net units sold
    const netUnits = parseInt(amz.units_sold || 0) + parseInt(shp.units_sold || 0);
    const cogsPerUnit = {
      standard:  parseFloat(amz.cogs_standard || shp.cogs_standard || 0),
      freight:   parseFloat(amz.cogs_freight  || shp.cogs_freight  || 0),
      demurrage: parseFloat(amz.cogs_demurrage|| shp.cogs_demurrage|| 0),
      quality:   parseFloat(amz.cogs_quality  || shp.cogs_quality  || 0),
      other:     parseFloat(amz.cogs_other    || shp.cogs_other    || 0),
    };
    const cogs = {
      standard:  fx(cogsPerUnit.standard  * netUnits),
      freight:   fx(cogsPerUnit.freight   * netUnits),
      demurrage: fx(cogsPerUnit.demurrage * netUnits),
      quality:   fx(cogsPerUnit.quality   * netUnits),
      other:     fx(cogsPerUnit.other     * netUnits),
    };
    const totalCogs = Object.values(cogs).reduce((s, v) => s + v, 0);
    const grossProfit = netRevenue - totalFees - totalCogs;

    const f = (n) => (n).toFixed(2);
    res.json({
      currency_symbol: sym,
      units: netUnits,
      revenue: { gross_sales: f(grossSales), discounts: f(-discounts), refunds: f(-totalRefunded), net_revenue: f(netRevenue) },
      fees: { commission: f(-feeCommission), fba_fulfillment: f(-feeFBA), other: f(-feeOther), total: f(-totalFees) },
      cogs: { standard: f(-cogs.standard), freight: f(-cogs.freight), demurrage: f(-cogs.demurrage), quality: f(-cogs.quality), other: f(-cogs.other), total: f(-totalCogs) },
      gross_profit: f(grossProfit),
      has_cogs: totalCogs > 0,
      has_fees: totalFees > 0,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/product-breakdown/countries', async (req, res) => {
  const { sku, from, to, channel = 'all' } = req.query;
  if (!sku) return res.status(400).json({ error: 'sku required' });
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  try {
    let result;
    if (channel === 'shopify') {
      result = await pool.query(`
        SELECT COALESCE(so.shipping_country, 'Unknown') AS country, 'shopify' AS channel,
          SUM(sol.quantity)::int AS units_sold,
          SUM(sol.unit_price * sol.quantity)::numeric(12,2) AS gross_sales
        FROM shopify_order_lines sol
        JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
        WHERE sol.sku = $1 AND sol.order_date::date BETWEEN $2 AND $3
        GROUP BY 1 ORDER BY gross_sales DESC
      `, [sku, dateFrom, dateTo]);
    } else if (channel === 'amazon') {
      result = await pool.query(`
        SELECT COALESCE(ao.shipping_country, 'Unknown') AS country, 'amazon' AS channel,
          SUM(aol.quantity)::int AS units_sold,
          SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity)::numeric(12,2) AS gross_sales
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
        WHERE aol.sku = $1 AND ao.order_date::date BETWEEN $2 AND $3 AND ao.status != 'Canceled'
        GROUP BY 1 ORDER BY gross_sales DESC
      `, [sku, dateFrom, dateTo]);
    } else {
      result = await pool.query(`
        SELECT country, channel, SUM(units_sold)::int AS units_sold, SUM(gross_sales)::numeric(12,2) AS gross_sales FROM (
          SELECT COALESCE(so.shipping_country, 'Unknown') AS country, 'shopify' AS channel,
            sol.quantity AS units_sold, (sol.unit_price * sol.quantity) AS gross_sales
          FROM shopify_order_lines sol
          JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
          WHERE sol.sku = $1 AND sol.order_date::date BETWEEN $2 AND $3
          UNION ALL
          SELECT COALESCE(ao.shipping_country, 'Unknown') AS country, 'amazon' AS channel,
            aol.quantity AS units_sold,
            (COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) AS gross_sales
          FROM amazon_order_lines aol
          JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
          LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
          WHERE aol.sku = $1 AND ao.order_date::date BETWEEN $2 AND $3 AND ao.status != 'Canceled'
        ) combined
        GROUP BY country, channel ORDER BY gross_sales DESC
      `, [sku, dateFrom, dateTo]);
    }
    res.json(result.rows);
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

// FX Rates — sync all pairs between GBP, USD, EUR from Frankfurter API (ECB data)
app.post('/api/sync-fx', async (req, res) => {
  const { daysBack = 3 } = req.body || {};
  try {
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
    res.json({ ok: true, synced, days: Object.keys(rawRates).length });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Client config — get reporting currency
app.get('/api/settings/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT reporting_currency FROM client_config LIMIT 1');
    res.json(result.rows[0] || { reporting_currency: 'GBP' });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Client config — update reporting currency
app.put('/api/settings/config', async (req, res) => {
  const { reporting_currency } = req.body;
  if (!['GBP', 'USD', 'EUR'].includes(reporting_currency)) return res.status(400).json({ error: 'Invalid currency' });
  try {
    await pool.query(`
      UPDATE client_config SET reporting_currency = $1, updated_at = NOW()
    `, [reporting_currency]);
    res.json({ ok: true, reporting_currency });
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

// Sync status
app.get('/api/sync-status', async (req, res) => {
  try {
    const result = await pool.query('SELECT source, status, last_synced_at, records_synced, last_error FROM sync_state ORDER BY source');
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/build/index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
