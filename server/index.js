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
  try {
    let result;
    if (channel === 'all') {
      result = await pool.query(`
        SELECT COUNT(*)::int AS total_orders, SUM(gross_revenue)::numeric AS gross_revenue, SUM(net_revenue)::numeric AS net_revenue,
          SUM(discount_amount)::numeric AS total_discounts,
          AVG(net_revenue)::numeric AS avg_order_value
        FROM (
          SELECT gross_revenue, net_revenue, discount_amount FROM shopify_orders
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
        FROM shopify_orders WHERE order_date::date BETWEEN $1 AND $2 AND financial_status != 'voided'
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

    res.json({
      ...row,
      net_revenue: (parseFloat(row.net_revenue || 0) - parseFloat(refundRow.total_refunded || 0)).toFixed(2),
      total_refunded: refundRow.total_refunded,
      refund_count: refundRow.refund_count,
      refund_rate: row.total_orders > 0 ? ((refundRow.refund_count / row.total_orders) * 100).toFixed(1) : 0,
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
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Gateway / Payout split
app.get('/api/gateway-split', async (req, res) => {
  const { from, to, channel = 'all' } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const amazonEnriched = `
    SELECT o.order_date, o.status, COALESCE(r.net_revenue, o.net_revenue) AS net_revenue
    FROM amazon_orders o
    LEFT JOIN (
      SELECT order_id, SUM(net_revenue)::numeric(12,2) AS net_revenue
      FROM v_sku_revenue WHERE channel = 'amazon' GROUP BY order_id
    ) r ON r.order_id = o.amazon_order_id
  `;
  try {
    let result;
    if (channel === 'amazon') {
      result = await pool.query(`
        SELECT 'Amazon' AS gateway, COUNT(*)::int AS orders, SUM(net_revenue)::numeric AS revenue
        FROM (${amazonEnriched}) a WHERE order_date::date BETWEEN $1 AND $2 AND status != 'Canceled'
      `, [dateFrom, dateTo]);
    } else if (channel === 'all') {
      result = await pool.query(`
        SELECT gateway, SUM(orders)::int AS orders, SUM(revenue)::numeric AS revenue FROM (
          SELECT gateway, COUNT(*)::int AS orders, SUM(net_revenue)::numeric AS revenue
          FROM shopify_orders WHERE order_date::date BETWEEN $1 AND $2 AND financial_status != 'voided'
          GROUP BY gateway
          UNION ALL
          SELECT 'Amazon' AS gateway, COUNT(*)::int AS orders, SUM(net_revenue)::numeric AS revenue
          FROM (${amazonEnriched}) a WHERE order_date::date BETWEEN $1 AND $2 AND status != 'Canceled'
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
  const amazonEnriched = `
    SELECT o.order_date, o.status, COALESCE(r.net_revenue, o.net_revenue) AS net_revenue
    FROM amazon_orders o
    LEFT JOIN (
      SELECT order_id, SUM(net_revenue)::numeric(12,2) AS net_revenue
      FROM v_sku_revenue WHERE channel = 'amazon' GROUP BY order_id
    ) r ON r.order_id = o.amazon_order_id
  `;
  try {
    let result;
    if (channel === 'amazon') {
      result = await pool.query(`
        SELECT DATE_TRUNC($1, order_date)::date AS period, 'Amazon' AS gateway, SUM(net_revenue)::numeric AS revenue
        FROM (${amazonEnriched}) a WHERE order_date::date BETWEEN $2 AND $3 AND status != 'Canceled'
        GROUP BY 1 ORDER BY 1
      `, [trunc, dateFrom, dateTo]);
    } else if (channel === 'all') {
      result = await pool.query(`
        SELECT period, gateway, SUM(revenue)::numeric AS revenue FROM (
          SELECT DATE_TRUNC($1, order_date)::date AS period, gateway, net_revenue AS revenue FROM shopify_orders
          WHERE order_date::date BETWEEN $2 AND $3 AND financial_status != 'voided'
          UNION ALL
          SELECT DATE_TRUNC($1, order_date)::date AS period, 'Amazon' AS gateway, net_revenue AS revenue FROM (${amazonEnriched}) a
          WHERE order_date::date BETWEEN $2 AND $3 AND status != 'Canceled'
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

// Sync status
app.get('/api/sync-status', async (req, res) => {
  try {
    const result = await pool.query('SELECT source, status, last_synced_at, records_synced, last_error FROM sync_state ORDER BY source');
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/build/index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
