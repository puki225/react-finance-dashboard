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

// Serve React build
app.use(express.static(path.join(__dirname, '../client/build')));

// ─── API ROUTES ───────────────────────────────────────────────

// KPI Summary
app.get('/api/summary', async (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int                          AS total_orders,
        SUM(gross_revenue)::numeric            AS gross_revenue,
        SUM(net_revenue)::numeric              AS net_revenue,
        SUM(discount_amount)::numeric          AS total_discounts,
        SUM(total_refunded)::numeric           AS total_refunded,
        AVG(net_revenue)::numeric              AS avg_order_value,
        COUNT(*) FILTER (WHERE total_refunded > 0)::int AS refund_count
      FROM shopify_orders
      WHERE order_date::date BETWEEN $1 AND $2
        AND financial_status != 'voided'
    `, [dateFrom, dateTo]);

    const row = result.rows[0];
    const refundRate = row.total_orders > 0
      ? ((row.refund_count / row.total_orders) * 100).toFixed(1)
      : 0;

    res.json({ ...row, refund_rate: refundRate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Revenue over time
app.get('/api/revenue-trend', async (req, res) => {
  const { from, to, period } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const trunc = period === 'week' ? 'week' : period === 'month' ? 'month' : 'day';

  try {
    const result = await pool.query(`
      SELECT
        DATE_TRUNC($1, order_date)::date AS period,
        SUM(gross_revenue)::numeric      AS gross_revenue,
        SUM(net_revenue)::numeric        AS net_revenue,
        COUNT(*)::int                    AS orders
      FROM shopify_orders
      WHERE order_date::date BETWEEN $2 AND $3
        AND financial_status != 'voided'
      GROUP BY 1
      ORDER BY 1
    `, [trunc, dateFrom, dateTo]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Gateway split (totals for legend)
app.get('/api/gateway-split', async (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(`
      SELECT
        gateway,
        COUNT(*)::int          AS orders,
        SUM(net_revenue)::numeric AS revenue
      FROM shopify_orders
      WHERE order_date::date BETWEEN $1 AND $2
        AND financial_status != 'voided'
      GROUP BY gateway
      ORDER BY revenue DESC
    `, [dateFrom, dateTo]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Gateway split over time (for stacked bar chart)
app.get('/api/gateway-trend', async (req, res) => {
  const { from, to, period } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const trunc = period === 'week' ? 'week' : period === 'month' ? 'month' : 'day';

  try {
    const result = await pool.query(`
      SELECT
        DATE_TRUNC($1, order_date)::date AS period,
        gateway,
        SUM(net_revenue)::numeric AS revenue
      FROM shopify_orders
      WHERE order_date::date BETWEEN $2 AND $3
        AND financial_status != 'voided'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `, [trunc, dateFrom, dateTo]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Shopify fees from payouts
app.get('/api/fees', async (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(`
      SELECT
        SUM(fees)::numeric        AS total_fees,
        SUM(charges_gross)::numeric AS gross_sales,
        SUM(refunds)::numeric     AS total_refunds,
        SUM(amount)::numeric      AS net_payouts
      FROM shopify_payouts
      WHERE payout_date BETWEEN $1 AND $2
        AND status = 'paid'
    `, [dateFrom, dateTo]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Recent orders
app.get('/api/recent-orders', async (req, res) => {
  const { limit } = req.query;

  try {
    const result = await pool.query(`
      SELECT
        shopify_order_number,
        order_date,
        financial_status,
        fulfillment_status,
        gross_revenue,
        net_revenue,
        total_refunded,
        gateway,
        shipping_country
      FROM shopify_orders
      WHERE financial_status != 'voided'
      ORDER BY order_date DESC
      LIMIT $1
    `, [limit || 10]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Sync status
app.get('/api/sync-status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT source, status, last_synced_at, records_synced, last_error
      FROM sync_state
      ORDER BY source
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Catch-all → React
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build/index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
