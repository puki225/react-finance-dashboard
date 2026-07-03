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
          SUM(sol.unit_price * sol.quantity)::numeric(12,2) AS gross_sales,
          SUM((sol.unit_price - sol.discount_per_unit) * sol.quantity)::numeric(12,2) AS net_revenue,
          0::numeric AS total_fees,
          SUM(sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0))::numeric(12,2) AS total_cogs
        FROM shopify_order_lines sol
        JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
        LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
        LEFT JOIN LATERAL (
          SELECT unit_cogs FROM cogs_entries WHERE sku = sol.sku
            AND effective_from <= sol.order_date::date
            AND (effective_to IS NULL OR effective_to >= sol.order_date::date)
          ORDER BY effective_from DESC LIMIT 1
        ) ce ON true
        WHERE sol.order_date::date BETWEEN $1 AND $2
        GROUP BY 1
      `, [dateFrom, dateTo]);
    } else if (channel === 'amazon') {
      result = await pool.query(`
        SELECT
          COALESCE(ao.shipping_country, 'Unknown') AS country,
          SUM(aol.quantity)::int AS units_sold,
          SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity)::numeric(12,2) AS gross_sales,
          SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity - COALESCE(aol.promotion_discount,0))::numeric(12,2) AS net_revenue,
          SUM(COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_commission,0) + COALESCE(aol.fee_digital_services,0) + COALESCE(aol.fee_fixed_closing,0))::numeric(12,2) AS total_fees,
          SUM(aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0))::numeric(12,2) AS total_cogs
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
        LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
        LEFT JOIN LATERAL (
          SELECT unit_cogs FROM cogs_entries WHERE sku = aol.sku
            AND effective_from <= ao.order_date::date
            AND (effective_to IS NULL OR effective_to >= ao.order_date::date)
          ORDER BY effective_from DESC LIMIT 1
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
            (sol.unit_price * sol.quantity) AS gross_sales,
            ((sol.unit_price - sol.discount_per_unit) * sol.quantity) AS net_revenue,
            0 AS total_fees,
            (sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)) AS total_cogs
          FROM shopify_order_lines sol
          JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
          LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
          LEFT JOIN LATERAL (
            SELECT unit_cogs FROM cogs_entries WHERE sku = sol.sku
              AND effective_from <= sol.order_date::date
              AND (effective_to IS NULL OR effective_to >= sol.order_date::date)
            ORDER BY effective_from DESC LIMIT 1
          ) ce ON true
          WHERE sol.order_date::date BETWEEN $1 AND $2
          UNION ALL
          SELECT COALESCE(ao.shipping_country, 'Unknown') AS country,
            aol.quantity AS units_sold,
            (COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) AS gross_sales,
            (COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity - COALESCE(aol.promotion_discount,0)) AS net_revenue,
            (COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_commission,0) + COALESCE(aol.fee_digital_services,0) + COALESCE(aol.fee_fixed_closing,0)) AS total_fees,
            (aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)) AS total_cogs
          FROM amazon_order_lines aol
          JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
          LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
          LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
          LEFT JOIN LATERAL (
            SELECT unit_cogs FROM cogs_entries WHERE sku = aol.sku
              AND effective_from <= ao.order_date::date
              AND (effective_to IS NULL OR effective_to >= ao.order_date::date)
            ORDER BY effective_from DESC LIMIT 1
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
        SELECT COALESCE(ao.shipping_country, 'Unknown') AS country, SUM(v.amount_refunded)::numeric AS total_refunded
        FROM v_refunds_by_date v JOIN amazon_orders ao ON ao.amazon_order_id = v.order_id
        WHERE v.channel = 'amazon' AND v.refund_date::date BETWEEN $1 AND $2
        GROUP BY 1
      ` : `
        SELECT COALESCE(so.shipping_country, 'Unknown') AS country, SUM(v.amount_refunded)::numeric AS total_refunded
        FROM v_refunds_by_date v JOIN shopify_orders so ON so.shopify_order_id::text = v.order_id
        WHERE v.channel = 'shopify' AND v.refund_date::date BETWEEN $1 AND $2
        GROUP BY 1
      `, [dateFrom, dateTo]);
    } else {
      refundResult = await pool.query(`
        SELECT country, SUM(total_refunded)::numeric AS total_refunded FROM (
          SELECT COALESCE(ao.shipping_country, 'Unknown') AS country, v.amount_refunded AS total_refunded
          FROM v_refunds_by_date v JOIN amazon_orders ao ON ao.amazon_order_id = v.order_id
          WHERE v.channel = 'amazon' AND v.refund_date::date BETWEEN $1 AND $2
          UNION ALL
          SELECT COALESCE(so.shipping_country, 'Unknown') AS country, v.amount_refunded AS total_refunded
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
      COALESCE(r.gross_sales, o.gross_revenue) AS gross_revenue,
      COALESCE(r.net_revenue, o.net_revenue) AS net_revenue
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
        SELECT COUNT(*)::int AS orders, SUM(gross_revenue)::numeric AS gross_revenue, SUM(net_revenue)::numeric AS net_revenue
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
  const { from, to, group = 'month', brand, parent_asin, search, fulfillment, order_type } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const trunc = ['day', 'week', 'month', 'year'].includes(group) ? group : 'month';

  const esc = (s) => s.replace(/'/g, "''");
  const brandFilter = brand ? `AND sp.brand = '${esc(brand)}'` : '';
  const parentFilter = parent_asin ? `AND sp.parent_asin = '${esc(parent_asin)}'` : '';
  const searchFilter = search ? `AND (aol.sku ILIKE '%${esc(search)}%' OR aol.asin ILIKE '%${esc(search)}%' OR ao.amazon_order_id ILIKE '%${esc(search)}%')` : '';
  const fulfillmentFilter = fulfillment === 'FBA' ? `AND ao.fulfillment_channel = 'AFN'` : fulfillment === 'FBM' ? `AND ao.fulfillment_channel = 'MFN'` : '';
  const orderTypeFilter = order_type === 'B2B' ? `AND ao.is_business_order = true` : order_type === 'B2C' ? `AND ao.is_business_order = false` : '';

  try {
    // Order-line level: units, gross sales, discounts, itemized COGS, order-line fees — grouped by period.
    // COGS formula matches the P&L breakdown panel exactly (itemized standard/freight/demurrage/quality/other
    // with cogs_entries -> sku_parameters -> flat unit_cogs fallback), not the flat shortcut used elsewhere.
    const linesResult = await pool.query(`
      SELECT
        DATE_TRUNC('${trunc}', ao.order_date)::date AS period,
        SUM(aol.quantity)::int AS units_sold,
        SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity)::numeric(12,2) AS gross_sales,
        SUM(COALESCE(aol.promotion_discount,0))::numeric(12,2) AS total_discounts,
        SUM(aol.quantity * COALESCE(
          NULLIF(ce.cogs_standard, 0), NULLIF(sp.cogs_standard, 0),
          CASE WHEN COALESCE(ce.cogs_standard,0)+COALESCE(ce.cogs_freight,0)+COALESCE(ce.cogs_demurrage,0)+COALESCE(ce.cogs_quality,0)+COALESCE(ce.cogs_other,0) = 0
            AND COALESCE(sp.cogs_standard,0)+COALESCE(sp.cogs_freight,0)+COALESCE(sp.cogs_demurrage,0)+COALESCE(sp.cogs_quality,0)+COALESCE(sp.cogs_other,0) = 0
            THEN COALESCE(ce.unit_cogs, sp.unit_cogs, 0) ELSE 0 END, 0)
        )::numeric(12,2) AS cogs_standard,
        SUM(aol.quantity * COALESCE(NULLIF(ce.cogs_freight,   0), NULLIF(sp.cogs_freight,   0), 0))::numeric(12,2) AS cogs_freight,
        SUM(aol.quantity * COALESCE(NULLIF(ce.cogs_demurrage, 0), NULLIF(sp.cogs_demurrage, 0), 0))::numeric(12,2) AS cogs_demurrage,
        SUM(aol.quantity * COALESCE(NULLIF(ce.cogs_quality,   0), NULLIF(sp.cogs_quality,   0), 0))::numeric(12,2) AS cogs_quality,
        SUM(aol.quantity * COALESCE(NULLIF(ce.cogs_other,     0), NULLIF(sp.cogs_other,     0), 0))::numeric(12,2) AS cogs_other,
        SUM(COALESCE(aol.fee_commission,0))::numeric(12,2) AS fee_commission,
        SUM(COALESCE(aol.fee_fba_fulfillment,0))::numeric(12,2) AS fee_fba_fulfillment,
        SUM(COALESCE(aol.fee_fixed_closing,0))::numeric(12,2) AS fee_fixed_closing,
        SUM(COALESCE(aol.fee_variable_closing,0))::numeric(12,2) AS fee_variable_closing,
        SUM(COALESCE(aol.fee_digital_services,0))::numeric(12,2) AS fee_digital_services,
        SUM(COALESCE(aol.fee_giftwrap_chargeback,0))::numeric(12,2) AS fee_giftwrap,
        SUM(COALESCE(aol.fee_shipping_chargeback,0))::numeric(12,2) AS fee_shipping_chargeback
      FROM amazon_order_lines aol
      JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
      LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
      LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
      LEFT JOIN LATERAL (
        SELECT cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, unit_cogs FROM cogs_entries
        WHERE sku = aol.sku AND effective_from <= ao.order_date::date
          AND (effective_to IS NULL OR effective_to >= ao.order_date::date)
        ORDER BY effective_from DESC LIMIT 1
      ) ce ON true
      WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
        ${brandFilter} ${parentFilter} ${searchFilter} ${fulfillmentFilter} ${orderTypeFilter}
      GROUP BY 1 ORDER BY 1
    `, [dateFrom, dateTo]);

    // Refunds, attributed by refund_date (independent of the order population above)
    const refundsResult = await pool.query(`
      SELECT DATE_TRUNC('${trunc}', refund_date)::date AS period, SUM(amount_refunded)::numeric AS total_refunded
      FROM v_refunds_by_date WHERE channel = 'amazon' AND refund_date::date BETWEEN $1 AND $2
      GROUP BY 1
    `, [dateFrom, dateTo]);

    // PPC spend, Amazon Ads only
    const ppcResult = await pool.query(`
      SELECT DATE_TRUNC('${trunc}', report_date)::date AS period, SUM(cost)::numeric AS ppc_cost
      FROM amazon_ppc_product_performance WHERE report_date BETWEEN $1 AND $2
      GROUP BY 1
    `, [dateFrom, dateTo]);

    // Account-level fees (subscription, storage, coupons, etc.) — itemized by whatever fee_type
    // Amazon actually reports, rather than a hardcoded row list, since these categories are only
    // as good as what's been synced via amazon-spapi-proxy's finances job. Adjustment-type events
    // (inventory reimbursements/disposals) are kept in their own bucket, matching the reference
    // P&L's separate "Adjustments" line rather than being folded into "Fees".
    const accountFeesResult = await pool.query(`
      SELECT DATE_TRUNC('${trunc}', posted_date)::date AS period, event_source, fee_type, SUM(amount)::numeric AS amount
      FROM amazon_account_fees WHERE posted_date::date BETWEEN $1 AND $2
      GROUP BY 1, 2, 3
    `, [dateFrom, dateTo]);

    // MCF (Multi-Channel Fulfillment) fees — Amazon charges the account to fulfil a Shopify
    // order out of FBA inventory. The fee itself comes from Amazon's Financial Events (same
    // sync as the other account-level fees), so it's a product-attributable Amazon cost even
    // though the underlying order is a Shopify order — shown as its own line under Fees,
    // grouped independently of the Amazon order-line filters above (fulfillment/order_type/
    // search/brand don't apply to a Shopify-side order).
    const mcfResult = await pool.query(`
      SELECT DATE_TRUNC('${trunc}', fee_date)::date AS period, SUM(fee_amount)::numeric AS mcf_fees
      FROM amazon_mcf_fees WHERE fee_date::date BETWEEN $1 AND $2
      GROUP BY 1
    `, [dateFrom, dateTo]);

    const reportingCurrency = await getReportingCurrency();
    const fxRate = await getPeriodRate('GBP', reportingCurrency, dateFrom, dateTo);
    const fx = (n) => (parseFloat(n || 0) * fxRate);

    // Index refunds/PPC/MCF by period key for merging
    const refundsByPeriod = {};
    for (const r of refundsResult.rows) refundsByPeriod[r.period.toISOString().split('T')[0]] = parseFloat(r.total_refunded || 0);
    const ppcByPeriod = {};
    for (const r of ppcResult.rows) ppcByPeriod[r.period.toISOString().split('T')[0]] = parseFloat(r.ppc_cost || 0);
    const mcfByPeriod = {};
    for (const r of mcfResult.rows) mcfByPeriod[r.period.toISOString().split('T')[0]] = parseFloat(r.mcf_fees || 0);

    // Account fees: group by period, split into (a) named fee_type rows for display and
    // (b) an Adjustments total, per period. Also track fee_type totals across the whole
    // range so the UI can list only the categories that actually have data.
    const accountFeesByPeriod = {}; // { period: { [feeType]: amount } }
    const adjustmentsByPeriod = {}; // { period: amount }
    const feeTypeTotals = {}; // { feeType: totalAbsAmount } — for sorting which rows to show
    for (const r of accountFeesResult.rows) {
      const key = r.period.toISOString().split('T')[0];
      const amt = parseFloat(r.amount || 0);
      if (r.event_source === 'Adjustment') {
        adjustmentsByPeriod[key] = (adjustmentsByPeriod[key] || 0) + amt;
      } else {
        if (!accountFeesByPeriod[key]) accountFeesByPeriod[key] = {};
        accountFeesByPeriod[key][r.fee_type] = (accountFeesByPeriod[key][r.fee_type] || 0) + amt;
        feeTypeTotals[r.fee_type] = (feeTypeTotals[r.fee_type] || 0) + Math.abs(amt);
      }
    }
    const accountFeeTypes = Object.keys(feeTypeTotals).sort((a, b) => feeTypeTotals[b] - feeTypeTotals[a]);

    function buildPeriodRow(periodKey, r) {
      const unitsSold = parseInt(r?.units_sold || 0, 10);
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
      };
      cogs.total = cogs.standard + cogs.freight + cogs.demurrage + cogs.quality + cogs.other;
      const lineFees = {
        commission: -fx(r?.fee_commission || 0),
        fba_fulfillment: -fx(r?.fee_fba_fulfillment || 0),
        fixed_closing: -fx(r?.fee_fixed_closing || 0),
        variable_closing: -fx(r?.fee_variable_closing || 0),
        digital_services: -fx(r?.fee_digital_services || 0),
        giftwrap: -fx(r?.fee_giftwrap || 0),
        shipping_chargeback: -fx(r?.fee_shipping_chargeback || 0),
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
          total: cogs.total.toFixed(2),
        },
        fees: {
          commission: lineFees.commission.toFixed(2),
          fba_fulfillment: lineFees.fba_fulfillment.toFixed(2),
          fixed_closing: lineFees.fixed_closing.toFixed(2),
          variable_closing: lineFees.variable_closing.toFixed(2),
          digital_services: lineFees.digital_services.toFixed(2),
          giftwrap: lineFees.giftwrap.toFixed(2),
          shipping_chargeback: lineFees.shipping_chargeback.toFixed(2),
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
        // plus inventory Adjustments.
        opex: {
          headcount: { total: headcountTotal.toFixed(2) },
          fixed_costs: { total: fixedCostsTotal.toFixed(2) },
          other_fees: {
            account_fees: Object.fromEntries(Object.entries(accountFees).map(([k, v]) => [k, v.toFixed(2)])),
            account_fees_total: accountFeesTotal.toFixed(2),
            adjustments: adjustments.toFixed(2),
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
    refundsByPeriod['__total__'] = sumMap(refundsByPeriod);
    ppcByPeriod['__total__'] = sumMap(ppcByPeriod);
    adjustmentsByPeriod['__total__'] = sumMap(adjustmentsByPeriod);
    mcfByPeriod['__total__'] = sumMap(mcfByPeriod);
    accountFeesByPeriod['__total__'] = {};
    for (const ft of accountFeeTypes) {
      accountFeesByPeriod['__total__'][ft] = perPeriodAccountFees.reduce((s, m) => s + (m[ft] || 0), 0);
    }
    const totals = buildPeriodRow('__total__', totalRaw);

    res.json({
      periods,
      totals,
      account_fee_types: accountFeeTypes,
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
          SUM(COALESCE(aol.fee_fba_fulfillment, 0) + COALESCE(aol.fee_commission, 0) +
              COALESCE(aol.fee_fixed_closing, 0) + COALESCE(aol.fee_variable_closing, 0) +
              COALESCE(aol.fee_digital_services, 0) + COALESCE(aol.fee_giftwrap_chargeback, 0) +
              COALESCE(aol.fee_shipping_chargeback, 0))::numeric AS total_fees
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
        LEFT JOIN LATERAL (
          SELECT cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, unit_cogs FROM cogs_entries
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
            mcf.fee_amount * (sol.line_gross / NULLIF(order_totals.order_gross, 0))
          ), 0)::numeric AS total_fees
        FROM shopify_order_lines sol
        LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
        LEFT JOIN LATERAL (
          SELECT cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, unit_cogs FROM cogs_entries
          WHERE sku = sol.sku
            AND effective_from <= sol.order_date::date
            AND (effective_to IS NULL OR effective_to >= sol.order_date::date)
          ORDER BY effective_from DESC LIMIT 1
        ) ce ON true
        LEFT JOIN amazon_mcf_fees mcf ON mcf.shopify_order_id = sol.shopify_order_id
        LEFT JOIN (
          SELECT shopify_order_id, SUM(line_gross) AS order_gross
          FROM shopify_order_lines GROUP BY shopify_order_id
        ) order_totals ON order_totals.shopify_order_id = sol.shopify_order_id
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
      ),
      shopify_cogs_only AS (
        SELECT sku, total_cogs_sold, total_fees FROM shopify_cogs
      ),
      amazon_cogs_only AS (
        SELECT sku, total_cogs_sold, total_fees FROM amazon_cogs
      ),
      -- PPC spend/sales per SKU (Amazon Ads only) — pre-aggregated so the join below
      -- can't fan out the surrounding SUMs (see MCF fee bug for why this matters).
      ppc_by_sku AS (
        SELECT sku,
          SUM(cost)::numeric AS ppc_cost,
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
        LEFT JOIN shopify_cogs_only cogs ON cogs.sku = sol.sku
        WHERE sol.order_date::date BETWEEN $1 AND $2 ${brandFilter} ${parentFilter}
        GROUP BY sol.sku, sp.image_url, sp.brand, sp.parent_asin
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
            SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity)::numeric(12,2) AS gross_sales,
            SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity - COALESCE(aol.promotion_discount,0))::numeric(12,2) AS net_before_refunds,
            SUM(COALESCE(aol.promotion_discount,0))::numeric(12,2) AS total_discounts
          FROM amazon_order_lines aol
          JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
          LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
          WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
          GROUP BY aol.sku
        )
        SELECT
          COALESCE(o.sku, ppc.sku) AS sku,
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
          COALESCE(cogs.total_fees, 0)::numeric(12,2) AS total_fees,
          COALESCE(ppc.ppc_cost, 0)::numeric(12,2) AS ppc_cost,
          COALESCE(ppc.ppc_sales, 0)::numeric(12,2) AS ppc_sales,
          COALESCE(ppc.ppc_units, 0)::int AS ppc_units
        FROM amazon_order_agg o
        FULL OUTER JOIN ppc_by_sku ppc ON ppc.sku = o.sku
        LEFT JOIN refunds_by_sku r ON r.sku = COALESCE(o.sku, ppc.sku)
        LEFT JOIN sku_parameters sp ON sp.sku = COALESCE(o.sku, ppc.sku)
        LEFT JOIN amazon_cogs_only cogs ON cogs.sku = COALESCE(o.sku, ppc.sku)
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
          COALESCE(s.sku, a.sku, ppc.sku) AS sku,
          COALESCE(a.product_title, s.product_title, sp.product_name) AS product_title,
          COALESCE(a.asin, sp.asin) AS asin,
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
          COALESCE(cogs.total_fees, 0)::numeric(12,2) AS total_fees,
          COALESCE(ppc.ppc_cost, 0)::numeric(12,2) AS ppc_cost,
          COALESCE(ppc.ppc_sales, 0)::numeric(12,2) AS ppc_sales,
          COALESCE(ppc.ppc_units, 0)::int AS ppc_units
        FROM shopify_skus s
        FULL OUTER JOIN amazon_skus a ON a.sku = s.sku
        -- FULL OUTER so a SKU with ad spend but zero orders anywhere (no Shopify, no
        -- Amazon sale) still surfaces as its own row instead of disappearing entirely.
        FULL OUTER JOIN ppc_by_sku ppc ON ppc.sku = COALESCE(s.sku, a.sku)
        LEFT JOIN all_refunds_by_sku r ON r.sku = COALESCE(s.sku, a.sku, ppc.sku)
        LEFT JOIN sku_parameters sp ON sp.sku = COALESCE(s.sku, a.sku, ppc.sku)
        LEFT JOIN cogs_by_sku cogs ON cogs.sku = COALESCE(s.sku, a.sku, ppc.sku)
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
        SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity)::numeric AS gross_sales,
        SUM(COALESCE(aol.promotion_discount, 0))::numeric AS discounts,
        SUM(COALESCE(aol.fee_commission, 0))::numeric AS fee_commission,
        SUM(COALESCE(aol.fee_fba_fulfillment, 0))::numeric AS fee_fba_fulfillment,
        SUM(COALESCE(aol.fee_fixed_closing, 0))::numeric AS fee_fixed_closing,
        SUM(COALESCE(aol.fee_variable_closing, 0))::numeric AS fee_variable_closing,
        SUM(COALESCE(aol.fee_digital_services, 0))::numeric AS fee_digital_services,
        SUM(COALESCE(aol.fee_giftwrap_chargeback, 0))::numeric AS fee_giftwrap,
        SUM(COALESCE(aol.fee_shipping_chargeback, 0))::numeric AS fee_shipping_chargeback,
        SUM(aol.quantity)::int AS units_sold
      FROM amazon_order_lines aol
      JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
      LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
      WHERE aol.sku = $1 AND ao.order_date::date BETWEEN $2 AND $3 AND ao.status != 'Canceled' ${countryFilter}
    `, [sku, dateFrom, dateTo]) : { rows: [{}] };

    const shpResult = includeShopify ? await pool.query(`
      SELECT
        SUM(sol.unit_price * sol.quantity)::numeric AS gross_sales,
        SUM(sol.discount_per_unit * sol.quantity)::numeric AS discounts,
        SUM(sol.quantity)::int AS units_sold,
        -- MCF fees proportionally allocated by revenue share
        COALESCE(SUM(
          mcf.fee_amount * (sol.line_gross / NULLIF(order_totals.order_gross, 0))
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
      SELECT COALESCE(SUM(amount_refunded), 0)::numeric AS total_refunded
      FROM v_refunds_by_date
      WHERE sku = $1 AND refund_date::date BETWEEN $2 AND $3
        ${!includeAmazon ? `AND channel != 'amazon'` : ''}
        ${!includeShopify ? `AND channel != 'shopify'` : ''}
    `, [sku, dateFrom, dateTo]);

    // PPC spend/sales for this SKU — Amazon Ads only, single-table aggregate (no join fanout risk)
    const ppcResult = includeAmazon ? await pool.query(`
      SELECT COALESCE(SUM(cost), 0)::numeric AS ppc_cost, COALESCE(SUM(sales_14d), 0)::numeric AS ppc_sales
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
          SELECT cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, unit_cogs
          FROM cogs_entries WHERE sku = aol.sku AND effective_from <= ao.order_date::date
            AND (effective_to IS NULL OR effective_to >= ao.order_date::date)
          ORDER BY effective_from DESC LIMIT 1
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
          SELECT cogs_standard, cogs_freight, cogs_demurrage, cogs_quality, cogs_other, unit_cogs
          FROM cogs_entries WHERE sku = sol.sku AND effective_from <= sol.order_date::date
            AND (effective_to IS NULL OR effective_to >= sol.order_date::date)
          ORDER BY effective_from DESC LIMIT 1
        ) ce ON true
        WHERE sol.sku = $1 AND sol.order_date::date BETWEEN $2 AND $3 ${countryFilterShopify}
      `, [sku, dateFrom, dateTo]);
      if (r.rows[0]) cogsRows.push(r.rows[0]);
    }
    const cogsResult = { rows: cogsRows };

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
    const totalFees = feeCommission + feeFBA + feeFixedClosing + feeVariableClosing + feeDigitalServices + feeGiftwrap + feeShipping + feeMCF;

    // Sum COGS components across both channels
    const cogsSt  = cogsResult.rows.reduce((s, r) => s + fx(r.cogs_standard  || 0), 0);
    const cogsFr  = cogsResult.rows.reduce((s, r) => s + fx(r.cogs_freight   || 0), 0);
    const cogsDem = cogsResult.rows.reduce((s, r) => s + fx(r.cogs_demurrage || 0), 0);
    const cogsQty = cogsResult.rows.reduce((s, r) => s + fx(r.cogs_quality   || 0), 0);
    const cogsOth = cogsResult.rows.reduce((s, r) => s + fx(r.cogs_other     || 0), 0);
    const totalCogs = cogsSt + cogsFr + cogsDem + cogsQty + cogsOth;

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
        fba_fulfillment:     f(-feeFBA),
        fixed_closing:       f(-feeFixedClosing),
        variable_closing:    f(-feeVariableClosing),
        digital_services:    f(-feeDigitalServices),
        giftwrap:            f(-feeGiftwrap),
        shipping_chargeback: f(-feeShipping),
        mcf_fulfillment:     f(-feeMCF),
        total:               f(-totalFees),
      },
      cogs: {
        standard:  f(-cogsSt),
        freight:   f(-cogsFr),
        demurrage: f(-cogsDem),
        quality:   f(-cogsQty),
        other:     f(-cogsOth),
        total:     f(-totalCogs),
      },
      gross_margin: f(grossMargin),
      ppc: {
        spend: f(-ppcCost),
      },
      product_contribution: f(productContribution),
      has_cogs: totalCogs > 0,
      has_fees: totalFees > 0,
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
          SUM(sol.unit_price * sol.quantity)::numeric(12,2) AS gross_sales,
          SUM((sol.unit_price - sol.discount_per_unit) * sol.quantity)::numeric(12,2) AS net_revenue,
          0::numeric AS total_fees,
          SUM(sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0))::numeric(12,2) AS total_cogs
        FROM shopify_order_lines sol
        JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
        LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
        LEFT JOIN LATERAL (
          SELECT unit_cogs FROM cogs_entries WHERE sku = sol.sku
            AND effective_from <= sol.order_date::date
            AND (effective_to IS NULL OR effective_to >= sol.order_date::date)
          ORDER BY effective_from DESC LIMIT 1
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
          SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity)::numeric(12,2) AS gross_sales,
          SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity - COALESCE(aol.promotion_discount,0))::numeric(12,2) AS net_revenue,
          SUM(COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_commission,0) + COALESCE(aol.fee_digital_services,0) + COALESCE(aol.fee_fixed_closing,0))::numeric(12,2) AS total_fees,
          SUM(aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0))::numeric(12,2) AS total_cogs
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
        LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
        LEFT JOIN LATERAL (
          SELECT unit_cogs FROM cogs_entries WHERE sku = aol.sku
            AND effective_from <= ao.order_date::date
            AND (effective_to IS NULL OR effective_to >= ao.order_date::date)
          ORDER BY effective_from DESC LIMIT 1
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
            sol.quantity AS units_sold, (sol.unit_price * sol.quantity) AS gross_sales,
            ((sol.unit_price - sol.discount_per_unit) * sol.quantity) AS net_revenue,
            0 AS total_fees,
            (sol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)) AS total_cogs
          FROM shopify_order_lines sol
          JOIN shopify_orders so ON so.shopify_order_id = sol.shopify_order_id
          LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
          LEFT JOIN LATERAL (
            SELECT unit_cogs FROM cogs_entries WHERE sku = sol.sku
              AND effective_from <= sol.order_date::date
              AND (effective_to IS NULL OR effective_to >= sol.order_date::date)
            ORDER BY effective_from DESC LIMIT 1
          ) ce ON true
          WHERE sol.sku = $1 AND sol.order_date::date BETWEEN $2 AND $3
          UNION ALL
          SELECT COALESCE(ao.shipping_country, 'Unknown') AS country, 'amazon' AS channel,
            aol.quantity AS units_sold,
            (COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity) AS gross_sales,
            (COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity - COALESCE(aol.promotion_discount,0)) AS net_revenue,
            (COALESCE(aol.fee_fba_fulfillment,0) + COALESCE(aol.fee_commission,0) + COALESCE(aol.fee_digital_services,0) + COALESCE(aol.fee_fixed_closing,0)) AS total_fees,
            (aol.quantity * COALESCE(ce.unit_cogs, sp.unit_cogs, 0)) AS total_cogs
          FROM amazon_order_lines aol
          JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
          LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
          LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
          LEFT JOIN LATERAL (
            SELECT unit_cogs FROM cogs_entries WHERE sku = aol.sku
              AND effective_from <= ao.order_date::date
              AND (effective_to IS NULL OR effective_to >= ao.order_date::date)
            ORDER BY effective_from DESC LIMIT 1
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

// ─── FEE ESTIMATE SYNC ────────────────────────────────────────────────────────
// Finds Amazon order lines < 14 days old with no settled fees,
// calls SP-API proxy /estimate-fees, writes estimates with is_estimated_fee=TRUE.
// Real settled fees from Finances API always overwrite estimates.
// ─────────────────────────────────────────────────────────────────────────────
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
