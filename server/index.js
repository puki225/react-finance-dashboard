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

    const rows = result.rows.map(r => {
      const key = r.period.toISOString().split('T')[0];
      const refunds = refundsByPeriod[key] || 0;
      return { ...r, net_revenue: (parseFloat(r.net_revenue || 0) - refunds).toFixed(2), refunds: refunds.toFixed(2) };
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
  const { from, to, channel = 'all', sort = 'gross_sales', dir = 'desc' } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo = to || new Date().toISOString().split('T')[0];
  const validSorts = ['gross_sales', 'net_revenue', 'units_sold', 'total_refunded', 'units_refunded', 'total_discounts'];
  const sortCol = validSorts.includes(sort) ? sort : 'gross_sales';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
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
        SELECT sol.sku, SUM(sol.amount_refunded)::numeric AS total_refunded, SUM(sol.quantity_refunded)::int AS units_refunded
        FROM shopify_order_lines sol
        JOIN shopify_transactions st ON st.shopify_order_id = sol.shopify_order_id
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
          'shopify' AS channels,
          SUM(sol.quantity)::int AS units_sold,
          COALESCE(MAX(r.units_refunded), 0)::int AS units_refunded,
          SUM(sol.unit_price * sol.quantity)::numeric(12,2) AS gross_sales,
          SUM(sol.unit_price * sol.quantity - sol.discount_per_unit * sol.quantity)::numeric(12,2) AS net_revenue,
          SUM(sol.discount_per_unit * sol.quantity)::numeric(12,2) AS total_discounts,
          COALESCE(MAX(r.total_refunded), 0)::numeric(12,2) AS total_refunded
        FROM shopify_order_lines sol
        LEFT JOIN all_refunds_by_sku r ON r.sku = sol.sku
        LEFT JOIN sku_parameters sp ON sp.sku = sol.sku
        WHERE sol.order_date::date BETWEEN $1 AND $2
        GROUP BY sol.sku, sp.image_url
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
          'amazon' AS channels,
          SUM(aol.quantity)::int AS units_sold,
          COALESCE(MAX(r.units_refunded), 0)::int AS units_refunded,
          SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity)::numeric(12,2) AS gross_sales,
          SUM(COALESCE(NULLIF(aol.unit_price,0), lp.last_price, 0) * aol.quantity - COALESCE(aol.promotion_discount,0))::numeric(12,2) AS net_revenue,
          SUM(COALESCE(aol.promotion_discount,0))::numeric(12,2) AS total_discounts,
          COALESCE(MAX(r.total_refunded), 0)::numeric(12,2) AS total_refunded
        FROM amazon_order_lines aol
        JOIN amazon_orders ao ON ao.amazon_order_id = aol.amazon_order_id
        LEFT JOIN v_sku_last_price lp ON lp.sku = aol.sku
        LEFT JOIN all_refunds_by_sku r ON r.sku = aol.sku
        LEFT JOIN sku_parameters sp ON sp.sku = aol.sku
        WHERE ao.order_date::date BETWEEN $1 AND $2 AND ao.status != 'Canceled'
        GROUP BY aol.sku, sp.image_url
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
          CASE WHEN s.sku IS NOT NULL AND a.sku IS NOT NULL THEN 'both'
               WHEN s.sku IS NOT NULL THEN 'shopify'
               ELSE 'amazon' END AS channels,
          (COALESCE(s.units_sold, 0) + COALESCE(a.units_sold, 0))::int AS units_sold,
          COALESCE(r.units_refunded, 0)::int AS units_refunded,
          (COALESCE(s.gross_sales, 0) + COALESCE(a.gross_sales, 0))::numeric(12,2) AS gross_sales,
          (COALESCE(s.net_revenue, 0) + COALESCE(a.net_revenue, 0))::numeric(12,2) AS net_revenue,
          (COALESCE(s.total_discounts, 0) + COALESCE(a.total_discounts, 0))::numeric(12,2) AS total_discounts,
          COALESCE(r.total_refunded, 0)::numeric(12,2) AS total_refunded
        FROM shopify_skus s
        FULL OUTER JOIN amazon_skus a ON a.sku = s.sku
        LEFT JOIN all_refunds_by_sku r ON r.sku = COALESCE(s.sku, a.sku)
        LEFT JOIN sku_parameters sp ON sp.sku = COALESCE(s.sku, a.sku)
        ORDER BY ${sortCol} ${sortDir}
      `, [dateFrom, dateTo]);
    }
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Product Breakdown — country split for a single SKU
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

// Sync status
app.get('/api/sync-status', async (req, res) => {
  try {
    const result = await pool.query('SELECT source, status, last_synced_at, records_synced, last_error FROM sync_state ORDER BY source');
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/build/index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
