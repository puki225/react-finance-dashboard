import 'dotenv/config';
import express from "express";
import aws4 from "aws4";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import pg from "pg";
const { Pool } = pg;
const app = express();
app.use(express.json({ limit: "2mb" }));
const VERSION_STAMP = "mcf-proxy-001";
const {
  LWA_CLIENT_ID, LWA_CLIENT_SECRET, SPAPI_REFRESH_TOKEN,
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
  SPAPI_ROLE_ARN, SPAPI_ROLE_EXTERNAL_ID = "sp-api",
  SPAPI_REGION = "eu-west-1", SPAPI_HOST = "sellingpartnerapi-eu.amazon.com",
  PROXY_API_KEY,
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD,
  PORT = "3000",
} = process.env;

const pool = new Pool({
  host: DB_HOST, port: DB_PORT || 5432, database: DB_NAME,
  user: DB_USER, password: DB_PASSWORD, ssl: { rejectUnauthorized: false },
});

const jobs = new Map();
let jobCounter = 0;

function requireApiKey(req, res, next) {
  if (!PROXY_API_KEY) return next();
  if (req.headers["x-api-key"] !== PROXY_API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  return next();
}

function assertEnv() {
  const required = { LWA_CLIENT_ID, LWA_CLIENT_SECRET, SPAPI_REFRESH_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SPAPI_ROLE_ARN };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

function safeJsonParse(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

let cachedLwa = { token: null, expiresAt: 0 };
async function getLwaAccessToken() {
  const now = Date.now();
  if (cachedLwa.token && now < cachedLwa.expiresAt - 60_000) return cachedLwa.token;
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: SPAPI_REFRESH_TOKEN, client_id: LWA_CLIENT_ID, client_secret: LWA_CLIENT_SECRET });
  const resp = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body });
  const text = await resp.text();
  const json = safeJsonParse(text);
  if (!resp.ok) { const e = new Error(`LWA error ${resp.status}`); e.status = resp.status; e.details = json; throw e; }
  cachedLwa = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return cachedLwa.token;
}

let cachedSts = { creds: null, expiresAt: 0 };
async function getAssumedRoleCreds() {
  const now = Date.now();
  if (cachedSts.creds && now < cachedSts.expiresAt - 60_000) return cachedSts.creds;
  const sts = new STSClient({ region: SPAPI_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
  const { Credentials: c } = await sts.send(new AssumeRoleCommand({ RoleArn: SPAPI_ROLE_ARN, RoleSessionName: "spapi-session", ExternalId: SPAPI_ROLE_EXTERNAL_ID, DurationSeconds: 3600 }));
  cachedSts = { creds: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken }, expiresAt: new Date(c.Expiration).getTime() };
  return cachedSts.creds;
}

async function spapiRequest({ method = "GET", path, query = {}, body = null }) {
  assertEnv();
  const [lwaToken, awsCreds] = await Promise.all([getLwaAccessToken(), getAssumedRoleCreds()]);
  const qs = new URLSearchParams(query).toString();
  const fullPath = qs ? `${path}?${qs}` : path;
  const opts = { host: SPAPI_HOST, path: fullPath, method, headers: { "x-amz-access-token": lwaToken, "content-type": "application/json" }, service: "execute-api", region: SPAPI_REGION, ...(body ? { body: JSON.stringify(body) } : {}) };
  aws4.sign(opts, awsCreds);
  const resp = await fetch(`https://${SPAPI_HOST}${fullPath}`, { method, headers: opts.headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await resp.text();
  if (!resp.ok) { const e = new Error(`SP-API ${resp.status} ${path}`); e.status = resp.status; e.details = safeJsonParse(text); throw e; }
  return safeJsonParse(text);
}

// ─── ORDER SYNC ───────────────────────────────────────────────────────────────

async function runSyncAmazonOrders(jobId, { from, to, daysBack = 7, marketplaceId = "A1F83G8C2ARO7P" } = {}) {
  let createdAfter, createdBefore;
  if (from) {
    createdAfter = new Date(from).toISOString();
    createdBefore = to ? new Date(to).toISOString() : null;
  } else {
    createdAfter = new Date(Date.now() - daysBack * 86400000).toISOString();
    createdBefore = null; // omit for ongoing syncs — avoids SP-API 400
  }

  jobs.set(jobId, { status: "running", orders: 0, lines: 0, from: createdAfter, to: createdBefore, startedAt: new Date().toISOString() });
  await pool.query(`INSERT INTO sync_state (source, status, last_synced_at) VALUES ('amazon_orders', 'running', NOW()) ON CONFLICT (source) DO UPDATE SET status = 'running', last_synced_at = NOW()`);

  let ordersInserted = 0, linesInserted = 0, nextToken = null;
  try {
    do {
      const query = nextToken
        ? { NextToken: nextToken }
        : { MarketplaceIds: marketplaceId, CreatedAfter: createdAfter, ...(createdBefore ? { CreatedBefore: createdBefore } : {}), OrderStatuses: "Unshipped,PartiallyShipped,Shipped,Canceled" };
      const data = await spapiRequest({ path: "/orders/v0/orders", query });
      const orders = data?.payload?.Orders || [];
      nextToken = data?.payload?.NextToken || null;
      for (const order of orders) {
        const gross = parseFloat(order.OrderTotal?.Amount || 0);
        // net_revenue = gross until Finances API gives us real settlement net
        const net = gross;
        const promo = parseFloat(order.PromotionDiscount?.Amount || 0) + parseFloat(order.ShippingDiscount?.Amount || 0);
        await pool.query(
          `INSERT INTO amazon_orders (amazon_order_id,order_date,last_updated_date,status,fulfillment_channel,sales_channel,marketplace_id,currency,gross_revenue,net_revenue,promotion_discount,item_count,shipping_country,shipping_city,is_business_order,is_prime,payment_method,synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
           ON CONFLICT (amazon_order_id) DO UPDATE SET last_updated_date=EXCLUDED.last_updated_date,status=EXCLUDED.status,gross_revenue=EXCLUDED.gross_revenue,net_revenue=EXCLUDED.net_revenue,promotion_discount=EXCLUDED.promotion_discount,synced_at=NOW()`,
          [order.AmazonOrderId,order.PurchaseDate,order.LastUpdateDate,order.OrderStatus,order.FulfillmentChannel,order.SalesChannel,marketplaceId,order.OrderTotal?.CurrencyCode||"GBP",gross,net,promo,(order.NumberOfItemsShipped||0)+(order.NumberOfItemsUnshipped||0)||1,order.ShippingAddress?.CountryCode||null,order.ShippingAddress?.City||null,order.IsBusinessOrder||false,order.IsPrime||false,order.PaymentMethod||null]
        );
        ordersInserted++;
        await new Promise(r => setTimeout(r, 2000));
        try {
          const itemsData = await spapiRequest({ path: `/orders/v0/orders/${order.AmazonOrderId}/orderItems` });
          for (const item of itemsData?.payload?.OrderItems || []) {
            await pool.query(
              `INSERT INTO amazon_order_lines (amazon_order_id,order_item_id,asin,sku,title,quantity,unit_price,unit_price_currency,promotion_discount,item_tax,shipping_price,shipping_tax,condition_id,synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
               ON CONFLICT (order_item_id) DO UPDATE SET quantity=EXCLUDED.quantity,unit_price=EXCLUDED.unit_price,promotion_discount=EXCLUDED.promotion_discount,synced_at=NOW()`,
              [order.AmazonOrderId,item.OrderItemId,item.ASIN,item.SellerSKU,item.Title,item.QuantityOrdered||1,parseFloat(item.ItemPrice?.Amount||0),item.ItemPrice?.CurrencyCode||"GBP",parseFloat(item.PromotionDiscount?.Amount||0),parseFloat(item.ItemTax?.Amount||0),parseFloat(item.ShippingPrice?.Amount||0),parseFloat(item.ShippingTax?.Amount||0),item.ConditionId||null]
            );
            linesInserted++;
          }
        } catch (e) { console.warn(`Items fetch failed ${order.AmazonOrderId}:`, e.message); }
        jobs.set(jobId, { status: "running", orders: ordersInserted, lines: linesInserted, from: createdAfter, to: createdBefore, startedAt: jobs.get(jobId).startedAt });
      }
    } while (nextToken);
    jobs.set(jobId, { status: "done", orders: ordersInserted, lines: linesInserted, from: createdAfter, to: createdBefore, startedAt: jobs.get(jobId).startedAt, completedAt: new Date().toISOString() });
    await pool.query(`UPDATE sync_state SET status='success',records_synced=$1,last_error=NULL,last_synced_at=NOW() WHERE source='amazon_orders'`, [ordersInserted]);
  } catch (err) {
    jobs.set(jobId, { status: "error", error: err.message, orders: ordersInserted, lines: linesInserted, from: createdAfter, to: createdBefore, startedAt: jobs.get(jobId).startedAt });
    await pool.query(`UPDATE sync_state SET status='error',last_error=$1,last_synced_at=NOW() WHERE source='amazon_orders'`, [err.message]);
  }
}

// ─── FINANCES SYNC ────────────────────────────────────────────────────────────

function sumChargeList(list) {
  return (list || []).reduce((s, item) => {
    return s + (item.ChargeList || item.FeeList || []).reduce((ss, c) => ss + parseFloat(c.ChargeAmount?.Amount || c.FeeAmount?.Amount || 0), 0);
  }, 0);
}

function sumField(list, field) {
  return (list || []).reduce((s, item) => s + parseFloat(item[field]?.Amount || 0), 0);
}

async function runSyncFinances(jobId, { from, to, daysBack = 180, marketplaceId = "A1F83G8C2ARO7P" } = {}) {
  let postedAfter, postedBefore;
  if (from) {
    postedAfter = new Date(from).toISOString();
    postedBefore = to ? new Date(to).toISOString() : null;
  } else {
    postedAfter = new Date(Date.now() - daysBack * 86400000).toISOString();
    postedBefore = null;
  }

  jobs.set(jobId, { status: "running", groups: 0, refundsUpdated: 0, startedAt: new Date().toISOString() });
  await pool.query(`INSERT INTO sync_state (source, status, last_synced_at) VALUES ('amazon_finances', 'running', NOW()) ON CONFLICT (source) DO UPDATE SET status = 'running', last_synced_at = NOW()`);

  let groupsProcessed = 0, refundsUpdated = 0, nextToken = null;
  try {
    do {
      const query = nextToken
        ? { NextToken: nextToken }
        : { FinancialEventGroupStartedAfter: postedAfter, ...(postedBefore ? { FinancialEventGroupStartedBefore: postedBefore } : {}) };

      const data = await spapiRequest({ path: "/finances/v0/financialEventGroups", query });
      const groups = data?.payload?.FinancialEventGroupList || [];
      nextToken = data?.payload?.NextToken || null;

      for (const group of groups) {
        const groupId = group.FinancialEventGroupId;
        const netTransfer = parseFloat(group.OriginalTotal?.Amount || 0);
        const currency = group.OriginalTotal?.CurrencyCode || "GBP";
        const fundTransferDate = group.FundTransferDate || null;
        const ledgerCloseDate = group.FinancialEventGroupEnd || null;
        const accountTail = group.AccountTail || null;
        const beginningBalance = parseFloat(group.BeginningBalance?.Amount || 0);

        // Pull financial events for this group
        let eventsNextToken = null;
        let totalSales = 0, totalRefunds = 0, totalFees = 0, totalOther = 0;
        const refundsByOrder = {};

        do {
          const eventsQuery = eventsNextToken
            ? { NextToken: eventsNextToken }
            : { FinancialEventGroupId: groupId };
          const eventsData = await spapiRequest({ path: "/finances/v0/financialEvents", query: eventsQuery });
          const events = eventsData?.payload?.FinancialEvents || {};
          eventsNextToken = eventsData?.payload?.NextToken || null;

          // Sales from shipments
          for (const shipment of events.ShipmentEventList || []) {
            totalSales += sumChargeList(shipment.ShipmentItemList || []);
          }

          // Refunds — aggregate per order
          for (const refund of events.RefundEventList || []) {
            const orderId = refund.AmazonOrderId;
            const refundAmt = Math.abs(sumChargeList(refund.ShipmentItemAdjustmentList || []));
            totalRefunds += refundAmt;
            if (orderId) {
              refundsByOrder[orderId] = (refundsByOrder[orderId] || 0) + refundAmt;
            }
          }

          // Fees
          for (const fee of events.ServiceFeeEventList || []) {
            totalFees += Math.abs(sumField(fee.FeeList || [], "FeeAmount"));
          }

          // Other (ads, adjustments, etc.)
          totalOther += sumField(events.ProductAdsPaymentEventList || [], "transactionValue");

          await new Promise(r => setTimeout(r, 500));
        } while (eventsNextToken);

        // Upsert payout record
        await pool.query(
          `INSERT INTO amazon_payouts (financial_event_group_id, fund_transfer_date, ledger_close_date, account_tail, beginning_balance, total_sales, total_refunds, total_fees, total_other, net_transfer, currency, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
           ON CONFLICT (financial_event_group_id) DO UPDATE SET fund_transfer_date=EXCLUDED.fund_transfer_date, total_sales=EXCLUDED.total_sales, total_refunds=EXCLUDED.total_refunds, total_fees=EXCLUDED.total_fees, total_other=EXCLUDED.total_other, net_transfer=EXCLUDED.net_transfer, synced_at=NOW()`,
          [groupId, fundTransferDate, ledgerCloseDate, accountTail, beginningBalance, totalSales, totalRefunds, totalFees, totalOther, netTransfer, currency]
        );

        // Update total_refunded on amazon_orders
        for (const [orderId, refundAmt] of Object.entries(refundsByOrder)) {
          await pool.query(
            `UPDATE amazon_orders SET total_refunded = $1 WHERE amazon_order_id = $2`,
            [refundAmt, orderId]
          );
          refundsUpdated++;
        }

        groupsProcessed++;
        jobs.set(jobId, { status: "running", groups: groupsProcessed, refundsUpdated, startedAt: jobs.get(jobId).startedAt });
        await new Promise(r => setTimeout(r, 500));
      }
    } while (nextToken);

    jobs.set(jobId, { status: "done", groups: groupsProcessed, refundsUpdated, startedAt: jobs.get(jobId).startedAt, completedAt: new Date().toISOString() });
    await pool.query(`UPDATE sync_state SET status='success', records_synced=$1, last_error=NULL, last_synced_at=NOW() WHERE source='amazon_finances'`, [groupsProcessed]);
  } catch (err) {
    jobs.set(jobId, { status: "error", error: err.message, groups: groupsProcessed, refundsUpdated, startedAt: jobs.get(jobId).startedAt });
    await pool.query(`UPDATE sync_state SET status='error', last_error=$1, last_synced_at=NOW() WHERE source='amazon_finances'`, [err.message]);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({ ok: true, version: VERSION_STAMP }));

app.get("/oldest-order", requireApiKey, async (req, res) => {
  try {
    const marketplaceId = req.query.marketplaceId || "A1F83G8C2ARO7P";
    const data = await spapiRequest({ path: "/orders/v0/orders", query: { MarketplaceIds: marketplaceId, CreatedAfter: "2000-01-01T00:00:00Z", OrderStatuses: "Unshipped,PartiallyShipped,Shipped,Canceled", MaxResultsPerPage: 1, SortOrder: "ASC" } });
    const orders = data?.payload?.Orders || [];
    if (!orders.length) return res.json({ ok: true, oldestOrder: null });
    const oldest = orders[0];
    res.json({ ok: true, oldestOrder: { orderId: oldest.AmazonOrderId, date: oldest.PurchaseDate, status: oldest.OrderStatus } });
  } catch (err) { res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details }); }
});

app.post("/sync-orders", requireApiKey, (req, res) => {
  const { daysBack = 7, from, to, marketplaceId } = req.body || {};
  const jobId = String(++jobCounter);
  runSyncAmazonOrders(jobId, { daysBack, from, to, marketplaceId });
  res.json({ ok: true, status: "started", jobId });
});

app.post("/sync-finances", requireApiKey, (req, res) => {
  const { daysBack = 180, from, to, marketplaceId } = req.body || {};
  const jobId = String(++jobCounter);
  runSyncFinances(jobId, { daysBack, from, to, marketplaceId });
  res.json({ ok: true, status: "started", jobId });
});

app.get("/sync-status/:jobId", requireApiKey, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({ ok: true, ...job });
});

app.get("/sync-jobs", requireApiKey, (req, res) => {
  res.json({ ok: true, jobs: [...jobs.entries()].map(([id, j]) => ({ jobId: id, ...j })) });
});

app.post("/setup-db", requireApiKey, async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS amazon_orders (id SERIAL PRIMARY KEY, amazon_order_id TEXT NOT NULL UNIQUE, order_date TIMESTAMPTZ NOT NULL, last_updated_date TIMESTAMPTZ, status TEXT, fulfillment_channel TEXT, sales_channel TEXT, marketplace_id TEXT, currency TEXT DEFAULT 'GBP', gross_revenue NUMERIC(12,2) DEFAULT 0, net_revenue NUMERIC(12,2) DEFAULT 0, promotion_discount NUMERIC(12,2) DEFAULT 0, item_count INT DEFAULT 1, shipping_country TEXT, shipping_city TEXT, is_business_order BOOLEAN DEFAULT FALSE, is_prime BOOLEAN DEFAULT FALSE, payment_method TEXT, synced_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_amz_orders_date ON amazon_orders(order_date);
      CREATE TABLE IF NOT EXISTS amazon_order_lines (id SERIAL PRIMARY KEY, amazon_order_id TEXT NOT NULL REFERENCES amazon_orders(amazon_order_id) ON DELETE CASCADE, order_item_id TEXT NOT NULL UNIQUE, asin TEXT, sku TEXT, title TEXT, quantity INT DEFAULT 1, unit_price NUMERIC(12,2) DEFAULT 0, unit_price_currency TEXT DEFAULT 'GBP', promotion_discount NUMERIC(12,2) DEFAULT 0, item_tax NUMERIC(12,2) DEFAULT 0, shipping_price NUMERIC(12,2) DEFAULT 0, shipping_tax NUMERIC(12,2) DEFAULT 0, condition_id TEXT, synced_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_amz_lines_order ON amazon_order_lines(amazon_order_id);
      INSERT INTO sync_state (source, status) VALUES ('amazon_orders', 'idle') ON CONFLICT (source) DO NOTHING;
      INSERT INTO sync_state (source, status) VALUES ('amazon_finances', 'idle') ON CONFLICT (source) DO NOTHING;
    `);
    res.json({ ok: true, message: "Tables created" });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/mcf/fulfillment-orders", requireApiKey, async (req, res) => {
  try { res.json({ ok: true, data: await spapiRequest({ method: "POST", path: "/fba/outbound/2020-07-01/fulfillmentOrders", body: req.body }) }); }
  catch (err) { res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details }); }
});

app.get("/mcf/fulfillment-orders/:orderId", requireApiKey, async (req, res) => {
  try { res.json({ ok: true, data: await spapiRequest({ path: `/fba/outbound/2020-07-01/fulfillmentOrders/${req.params.orderId}` }) }); }
  catch (err) { res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details }); }
});

app.get("/mcf/tracking/:packageNumber", requireApiKey, async (req, res) => {
  try { res.json({ ok: true, data: await spapiRequest({ path: "/fba/outbound/2020-07-01/fulfillmentOrders/tracking", query: { packageNumber: req.params.packageNumber } }) }); }
  catch (err) { res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details }); }
});

app.listen(PORT, () => console.log(`SP-API proxy running on port ${PORT}`));
