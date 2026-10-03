// ─── AI ACTION BOARD ────────────────────────────────────────────────────────
// A daily, £-impact-ranked list of business problems - "stock breaks, high TACOS on a given
// product, high returns, warehouse fees, etc." (the brief that started this) - surfaced as
// Trello-style cards (To Do / Doing / Done). Every number comes from the dashboard's OWN
// existing API routes (same reuse pattern as chat.js's callInternalApi), never fresh SQL
// re-deriving VAT/FX/COGS/forecast logic that those routes already get right.
//
// Extensible by design: detectAllIssues() below is a flat list of independent checks, each
// emitting zero or more candidate issues with a real £ figure behind them. Adding a new area
// of the business to watch is adding one more check here, following the same shape - nothing
// else about the schema, scoring, or UI needs to know about it.
//
// How a card moves (runActionBoardEvaluation, run daily by the scheduler in index.js, or
// on-demand via POST /reevaluate):
//   - A candidate not currently tracked becomes a new card in 'todo', with its KPI value
//     frozen as `kpi_baseline` - the fixed starting point `pct_complete` is measured against.
//   - An existing, non-dismissed card has its KPI/impact refreshed and `pct_complete`
//     recomputed against its frozen baseline and the (possibly moving - e.g. a peer-median
//     benchmark) current target. The AI's own stage (`ai_stage`) advances todo -> doing as
//     pct_complete climbs, snaps to 'done' once the KPI reaches target, and reopens to 'todo'
//     if a previously-resolved issue comes back or a 'doing' one regresses.
//   - A candidate that stops being detected at all (truly cleared) resolves its card to 'done'.
//   - `stage` is what the board actually shows. It tracks `ai_stage` UNLESS a user has
//     overridden it (directly, or by arguing it out with the chatbot - see chat.js's
//     update_action_board_card / revert_action_board_card tools), in which case it holds
//     wherever the user put it until they explicitly revert (POST /:id/revert), which resets
//     the card - stage, dismissal, and any impact override - back to pure AI judgement.
const express = require('express');

const STAGES = ['todo', 'doing', 'done'];

// ─── Schema ─────────────────────────────────────────────────────────────────────────────
async function ensureActionBoardSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS action_board_cards (
      id SERIAL PRIMARY KEY,
      issue_type TEXT NOT NULL,
      -- Natural key alongside issue_type: the SKU for a per-product issue, '' for an
      -- account-level one. NOT NULL (not nullable) so the UNIQUE constraint below actually
      -- enforces one card per (issue_type, scope) - Postgres treats every NULL as distinct,
      -- which would let duplicate account-level cards slip in.
      scope_key TEXT NOT NULL DEFAULT '',
      sku TEXT,
      title TEXT NOT NULL,
      description TEXT,
      impact_amount NUMERIC NOT NULL DEFAULT 0,
      impact_amount_override NUMERIC,
      currency_symbol TEXT NOT NULL DEFAULT '£',
      kpi_name TEXT,
      kpi_value NUMERIC,
      kpi_target NUMERIC,
      kpi_baseline NUMERIC,
      kpi_unit TEXT,
      kpi_direction TEXT,
      pct_complete NUMERIC NOT NULL DEFAULT 0,
      ai_stage TEXT NOT NULL DEFAULT 'todo',
      stage TEXT NOT NULL DEFAULT 'todo',
      user_override BOOLEAN NOT NULL DEFAULT false,
      override_note TEXT,
      dismissed BOOLEAN NOT NULL DEFAULT false,
      first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (issue_type, scope_key)
    );
    CREATE TABLE IF NOT EXISTS action_board_card_events (
      id SERIAL PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES action_board_cards(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      from_value TEXT,
      to_value TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ─── Small helpers ──────────────────────────────────────────────────────────────────────
const fmt = (d) => d.toISOString().split('T')[0];
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Math.round(v * 100) / 100;
const round1 = (v) => Math.round(v * 10) / 10;
function median(nums) {
  const arr = nums.filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function makeCallInternalApi(baseUrl) {
  return async function callInternalApi(path, query = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, v);
    }
    const url = `${baseUrl}${path}${qs.toString() ? '?' + qs.toString() : ''}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `${path} returned ${resp.status}`);
    return data;
  };
}

// ─── Detectors ──────────────────────────────────────────────────────────────────────────
// Each candidate: { issue_type, scope_key, sku, title, description, impact_amount,
// currency_symbol, kpi_name, kpi_value, kpi_target, kpi_unit, kpi_direction }.
// Materiality floors (impact_amount thresholds below) exist so a card doesn't flicker in and
// out of existence over noise - every floor is a judgment call, not a measured fact, and is a
// reasonable first thing to loosen/tighten if the board feels too noisy or too quiet.
async function detectAllIssues({ callInternalApi }) {
  const [current, prior, peer, inventory, cashflow] = await Promise.all([
    callInternalApi('/api/product-breakdown', { from: fmt(daysAgo(29)), to: fmt(daysAgo(0)), channel: 'all' }),
    callInternalApi('/api/product-breakdown', { from: fmt(daysAgo(59)), to: fmt(daysAgo(30)), channel: 'all' }),
    callInternalApi('/api/product-breakdown', { from: fmt(daysAgo(89)), to: fmt(daysAgo(0)), channel: 'all' }),
    callInternalApi('/api/inventory', {}),
    callInternalApi('/api/cashflow', {}),
  ]);

  const currencySymbol = inventory.currency_symbol || cashflow.currency_symbol || '£';
  const priorBySku = new Map(prior.map(r => [r.sku, r]));
  const peerBySku = new Map(peer.map(r => [r.sku, r]));
  const candidates = [];

  // Peer benchmarks: medians across the wider, more stable 90-day window, each restricted to
  // SKUs where the metric is actually meaningful (e.g. only SKUs running ads for TACOS) so a
  // pile of zero-spend/zero-return SKUs doesn't drag the "normal" level down to nothing.
  const peerTacos = median(peer.filter(r => num(r.ppc_cost) > 0).map(r => num(r.tacos)));
  const peerReturnRate = median(peer.filter(r => num(r.units_sold) >= 5).map(r => num(r.units_refunded) / num(r.units_sold) * 100));
  const peerDiscountRate = median(peer.filter(r => num(r.gross_sales) > 0).map(r => num(r.total_discounts) / num(r.gross_sales) * 100));
  const peerMargin = median(peer.filter(r => num(r.net_revenue) >= 50).map(r => num(r.gross_margin_pct)));

  for (const row of current) {
    const sku = row.sku;
    if (!sku) continue;
    const title = row.product_title || sku;
    const netRevenue = num(row.net_revenue);
    const grossSales = num(row.gross_sales);
    const unitsSold = num(row.units_sold);
    const unitsRefunded = num(row.units_refunded);
    const ppcCost = num(row.ppc_cost);
    const tacos = num(row.tacos);
    const marginPct = num(row.gross_margin_pct);

    // TACOS blowout: ad spend materially above what peer SKUs achieve for a similar sales mix
    // (the user's own worked example: "TACOS on a given product is 40% and is costing me
    // £300/month overspend when I could have it at 10% with similar CTR and volume").
    if (ppcCost > 0 && peerTacos !== null && tacos > peerTacos) {
      const impact = (tacos - peerTacos) / 100 * netRevenue;
      if (impact >= 30) {
        candidates.push({
          issue_type: 'tacos_blowout', scope_key: sku, sku, title: `High TACOS on ${title}`,
          description: `TACOS is ${tacos.toFixed(1)}% vs a ${peerTacos.toFixed(1)}% peer benchmark across similar-selling SKUs (last 90 days) — ad spend here is outpacing what comparable products need.`,
          impact_amount: round2(impact), currency_symbol: currencySymbol,
          kpi_name: 'TACOS', kpi_value: round1(tacos), kpi_target: round1(peerTacos),
          kpi_unit: '%', kpi_direction: 'lower_better',
        });
      }
    }

    // High return rate vs peers - a quality/sizing/listing-accuracy signal.
    if (unitsSold >= 5 && unitsRefunded > 0 && peerReturnRate !== null) {
      const returnRate = unitsRefunded / unitsSold * 100;
      if (returnRate > peerReturnRate) {
        const avgRefundPerUnit = num(row.total_refunded) / unitsRefunded;
        const excessUnits = Math.max(0, (returnRate - peerReturnRate) / 100 * unitsSold);
        const impact = excessUnits * avgRefundPerUnit;
        if (impact >= 20) {
          candidates.push({
            issue_type: 'high_returns', scope_key: sku, sku, title: `High return rate on ${title}`,
            description: `${returnRate.toFixed(1)}% of units sold are coming back vs a ${peerReturnRate.toFixed(1)}% peer benchmark — worth checking for a quality, sizing, or listing-accuracy issue.`,
            impact_amount: round2(impact), currency_symbol: currencySymbol,
            kpi_name: 'Return rate', kpi_value: round1(returnRate), kpi_target: round1(peerReturnRate),
            kpi_unit: '%', kpi_direction: 'lower_better',
          });
        }
      }
    }

    // Discount leakage vs peers.
    if (grossSales > 0 && peerDiscountRate !== null) {
      const discountRate = num(row.total_discounts) / grossSales * 100;
      if (discountRate > peerDiscountRate) {
        const impact = (discountRate - peerDiscountRate) / 100 * grossSales;
        if (impact >= 20) {
          candidates.push({
            issue_type: 'discount_leakage', scope_key: sku, sku, title: `Heavy discounting on ${title}`,
            description: `${discountRate.toFixed(1)}% of gross sales is being discounted away vs a ${peerDiscountRate.toFixed(1)}% peer benchmark.`,
            impact_amount: round2(impact), currency_symbol: currencySymbol,
            kpi_name: 'Discount rate', kpi_value: round1(discountRate), kpi_target: round1(peerDiscountRate),
            kpi_unit: '%', kpi_direction: 'lower_better',
          });
        }
      }
    }

    // Thin/negative margin - a hard floor (margin under 5%), not a peer comparison, since a
    // SKU losing money is a problem regardless of what its peers do.
    if (netRevenue >= 50 && marginPct < 5) {
      const target = Math.max(10, peerMargin ?? 10);
      const impact = Math.max(0, (target - marginPct) / 100) * netRevenue;
      if (impact >= 20) {
        candidates.push({
          issue_type: 'negative_margin', scope_key: sku, sku, title: `Thin/negative margin on ${title}`,
          description: `Gross margin is ${marginPct.toFixed(1)}% over the last 30 days vs a ${target.toFixed(1)}% target — this SKU is barely covering, or losing, its own cost to sell.`,
          impact_amount: round2(impact), currency_symbol: currencySymbol,
          kpi_name: 'Gross margin', kpi_value: round1(marginPct), kpi_target: round1(target),
          kpi_unit: '%', kpi_direction: 'higher_better',
        });
      }
    }

    // Margin compression vs this SKU's OWN prior 30 days - catches rising cost, price
    // erosion, or promo pressure even on a SKU whose margin is still "fine" in absolute terms.
    const priorRow = priorBySku.get(sku);
    if (priorRow && netRevenue >= 50) {
      const priorMargin = num(priorRow.gross_margin_pct);
      const drop = priorMargin - marginPct;
      if (drop >= 8) {
        const impact = (drop / 100) * netRevenue;
        if (impact >= 20) {
          candidates.push({
            issue_type: 'margin_compression', scope_key: sku, sku, title: `Margin slipping on ${title}`,
            description: `Gross margin dropped from ${priorMargin.toFixed(1)}% to ${marginPct.toFixed(1)}% vs the 30 days before — rising cost, price erosion, or promo pressure is eating into profit here.`,
            impact_amount: round2(impact), currency_symbol: currencySymbol,
            kpi_name: 'Gross margin (vs prior period)', kpi_value: round1(marginPct), kpi_target: round1(priorMargin),
            kpi_unit: '%', kpi_direction: 'higher_better',
          });
        }
      }
    }
  }

  // Aged inventory / long-term storage surcharge, and stock-outs - both sourced from
  // /api/inventory, which already computes surcharge_monthly (real LTSF rate x aged units)
  // and daily_velocity/sellable (seasonal-forecast-aware).
  for (const row of inventory.rows || []) {
    const sku = row.sku;
    if (!sku) continue;
    const title = row.product_title || sku;

    const surcharge = num(row.surcharge_monthly);
    if (surcharge >= 15) {
      const agedUnits = num(row.age_271_365) + num(row.age_365_plus);
      candidates.push({
        issue_type: 'aged_inventory', scope_key: sku, sku, title: `Aged stock surcharge on ${title}`,
        description: `${agedUnits} units have been sitting 271+ days, triggering a recurring ${currencySymbol}${surcharge.toFixed(2)}/month long-term storage surcharge that repeats every cycle until the stock sells, gets discounted out, or is removed.`,
        impact_amount: round2(surcharge), currency_symbol: currencySymbol,
        kpi_name: 'Aged units (271+ days)', kpi_value: agedUnits, kpi_target: 0,
        kpi_unit: 'units', kpi_direction: 'lower_better',
      });
    }

    const sellable = num(row.sellable);
    const velocity = num(row.daily_velocity);
    if (sellable <= 0 && velocity > 0) {
      const peerRow = peerBySku.get(sku);
      const peerUnits = peerRow ? num(peerRow.units_sold) : 0;
      if (peerRow && peerUnits > 0) {
        // Per-unit gross margin inferred from the last time this SKU actually had sales to
        // measure a price/cost against - there's nothing to infer it from while it's at zero.
        const marginPerUnit = (num(peerRow.net_revenue) - num(peerRow.total_cogs) - num(peerRow.total_fees)) / peerUnits;
        if (marginPerUnit > 0) {
          const impact = velocity * 30 * marginPerUnit;
          if (impact >= 20) {
            const target = Math.max(1, Math.round(velocity * 30));
            candidates.push({
              issue_type: 'stock_out', scope_key: sku, sku, title: `Stock-out on ${title}`,
              description: `Out of sellable stock while still selling ~${velocity.toFixed(1)} units/day — an estimated ${currencySymbol}${impact.toFixed(2)}/month in lost gross profit for as long as it stays out of stock.`,
              impact_amount: round2(impact), currency_symbol: currencySymbol,
              kpi_name: 'Sellable units', kpi_value: sellable, kpi_target: target,
              kpi_unit: 'units', kpi_direction: 'higher_better',
            });
          }
        }
      }
    }
  }

  // Cash runway risk (account-level, not per-SKU) - reuses /api/cashflow's own projection
  // rather than re-simulating settlements/outflows here.
  if (cashflow.threshold_breach_date) {
    const breachDate = new Date(cashflow.threshold_breach_date);
    const daysUntil = Math.round((breachDate.getTime() - Date.now()) / 86400000);
    if (daysUntil <= 45) {
      const minBalance = num(cashflow.min_balance);
      const threshold = num(cashflow.assumptions?.minimum_cash_threshold);
      const shortfall = Math.max(0, threshold - minBalance);
      candidates.push({
        issue_type: 'cash_runway', scope_key: '', sku: null, title: 'Cash balance projected to breach minimum threshold',
        description: `Projected balance dips to ${currencySymbol}${minBalance.toFixed(2)} on ${cashflow.min_balance_date}, ${currencySymbol}${shortfall.toFixed(2)} below the ${currencySymbol}${threshold.toFixed(2)} minimum threshold, in ${daysUntil} day(s).`,
        impact_amount: round2(shortfall), currency_symbol: currencySymbol,
        kpi_name: 'Days until threshold breach', kpi_value: daysUntil, kpi_target: 60,
        kpi_unit: 'days', kpi_direction: 'higher_better',
      });
    }
  }

  return candidates;
}

// ─── Scoring: baseline-relative progress + AI stage transitions ───────────────────────────
function clampPct(baseline, target, current, direction) {
  if (baseline === null || target === null || current === null) return 0;
  const range = direction === 'lower_better' ? (baseline - target) : (target - baseline);
  if (range === 0) return current === target ? 100 : 0;
  const progressed = direction === 'lower_better' ? (baseline - current) : (current - baseline);
  return Math.max(0, Math.min(100, Math.round((progressed / range) * 100)));
}
function isResolved(kpiValue, target, direction) {
  if (kpiValue === null || target === null) return false;
  return direction === 'lower_better' ? kpiValue <= target : kpiValue >= target;
}

// ─── The daily (or on-demand) evaluation run ───────────────────────────────────────────────
async function runActionBoardEvaluation({ pool, baseUrl }) {
  const callInternalApi = makeCallInternalApi(baseUrl);
  const candidates = await detectAllIssues({ callInternalApi });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seenKeys = new Set();

    for (const c of candidates) {
      seenKeys.add(`${c.issue_type}::${c.scope_key}`);
      const existing = await client.query(
        `SELECT * FROM action_board_cards WHERE issue_type = $1 AND scope_key = $2`,
        [c.issue_type, c.scope_key]
      );

      if (!existing.rows.length) {
        // kpi_baseline intentionally reuses the kpi_value param ($9) below - the baseline IS
        // the value at the moment of first detection, by definition.
        const ins = await client.query(`
          INSERT INTO action_board_cards
            (issue_type, scope_key, sku, title, description, impact_amount, currency_symbol,
             kpi_name, kpi_value, kpi_target, kpi_baseline, kpi_unit, kpi_direction,
             pct_complete, ai_stage, stage)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$11,$12,0,'todo','todo')
          RETURNING id
        `, [c.issue_type, c.scope_key, c.sku, c.title, c.description, c.impact_amount, c.currency_symbol,
            c.kpi_name, c.kpi_value, c.kpi_target, c.kpi_unit, c.kpi_direction]);
        await client.query(
          `INSERT INTO action_board_card_events (card_id, event_type, to_value) VALUES ($1,'detected',$2)`,
          [ins.rows[0].id, String(c.kpi_value)]
        );
        continue;
      }

      const row = existing.rows[0];
      if (row.dismissed) {
        // Keep the underlying numbers fresh so a re-detected or revert()'d card isn't stale,
        // but never touch stage/ai_stage while dismissed.
        await client.query(`
          UPDATE action_board_cards
          SET title = $1, description = $2, impact_amount = $3, kpi_value = $4, kpi_target = $5,
              updated_at = NOW(), last_seen_at = NOW()
          WHERE id = $6
        `, [c.title, c.description, c.impact_amount, c.kpi_value, c.kpi_target, row.id]);
        continue;
      }

      const baseline = parseFloat(row.kpi_baseline);
      const target = c.kpi_target; // a peer benchmark or prior-period value, legitimately re-measured each run
      const pct = clampPct(baseline, target, c.kpi_value, c.kpi_direction);
      const resolved = isResolved(c.kpi_value, target, c.kpi_direction);
      const prevPct = parseFloat(row.pct_complete);

      let aiStage = row.ai_stage;
      if (resolved) aiStage = 'done';
      else if (row.ai_stage === 'done') aiStage = 'todo'; // was resolved, isn't any more - reopen at the top
      else if (pct <= prevPct - 10 && row.ai_stage !== 'todo') aiStage = 'todo'; // regressed meaningfully
      else if (pct >= prevPct + 10 && pct >= 15 && row.ai_stage === 'todo') aiStage = 'doing';

      const effectiveStage = row.user_override ? row.stage : aiStage;

      await client.query(`
        UPDATE action_board_cards SET
          title = $1, description = $2, impact_amount = $3, kpi_value = $4, kpi_target = $5,
          pct_complete = $6, ai_stage = $7, stage = $8,
          stage_changed_at = CASE WHEN $8 IS DISTINCT FROM stage THEN NOW() ELSE stage_changed_at END,
          updated_at = NOW(), last_seen_at = NOW()
        WHERE id = $9
      `, [c.title, c.description, c.impact_amount, c.kpi_value, target, pct, aiStage, effectiveStage, row.id]);

      if (aiStage !== row.ai_stage) {
        await client.query(
          `INSERT INTO action_board_card_events (card_id, event_type, from_value, to_value) VALUES ($1,'ai_stage_change',$2,$3)`,
          [row.id, row.ai_stage, aiStage]
        );
      }
    }

    // Anything not re-detected this run (and not dismissed, not already done) has genuinely
    // cleared - resolve it to 'done' rather than leaving a stale card sitting in 'doing'.
    const stale = await client.query(`
      SELECT id, issue_type, scope_key, ai_stage, stage, user_override FROM action_board_cards
      WHERE dismissed = false AND ai_stage <> 'done'
    `);
    for (const row of stale.rows) {
      if (seenKeys.has(`${row.issue_type}::${row.scope_key}`)) continue;
      const effectiveStage = row.user_override ? row.stage : 'done';
      await client.query(`
        UPDATE action_board_cards SET ai_stage = 'done', pct_complete = 100, stage = $1,
          stage_changed_at = CASE WHEN $1 IS DISTINCT FROM stage THEN NOW() ELSE stage_changed_at END,
          updated_at = NOW(), last_seen_at = NOW()
        WHERE id = $2
      `, [effectiveStage, row.id]);
      await client.query(
        `INSERT INTO action_board_card_events (card_id, event_type, from_value, to_value, note) VALUES ($1,'ai_stage_change',$2,'done','no longer detected')`,
        [row.id, row.ai_stage]
      );
    }

    await client.query('COMMIT');
    return { evaluated_at: new Date().toISOString(), candidate_count: candidates.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Scheduling: re-run roughly once a day ─────────────────────────────────────────────────
// No cron-style library in this project's dependencies - a plain hourly check against a
// target UTC hour, guarded so it can only fire once per calendar day, gets the same effect
// without adding one. Exact minute will drift a little around the target hour; that's fine
// for a daily re-prioritization, not something that needs to-the-minute precision.
const DAILY_RUN_UTC_HOUR = 6;
function scheduleDailyEvaluation({ pool, baseUrl }) {
  let lastRunDate = null;
  const tick = async () => {
    const now = new Date();
    const today = fmt(now);
    if (now.getUTCHours() !== DAILY_RUN_UTC_HOUR || today === lastRunDate) return;
    lastRunDate = today;
    try {
      const result = await runActionBoardEvaluation({ pool, baseUrl });
      console.log(`[action-board] daily evaluation complete:`, result);
    } catch (e) {
      console.error('[action-board] daily evaluation failed:', e.message);
    }
  };
  setInterval(tick, 30 * 60 * 1000); // check twice an hour; `lastRunDate` guards against double-firing
  tick(); // also try once at boot, in case the process starts during the target hour
}

// ─── Router ─────────────────────────────────────────────────────────────────────────────
function createActionBoardRouter({ pool, baseUrl }) {
  const router = express.Router();

  router.get('/api/action-board/cards', async (req, res) => {
    try {
      const includeDismissed = req.query.include_dismissed === 'true';
      const result = await pool.query(`
        SELECT *, COALESCE(impact_amount_override, impact_amount) AS effective_impact
        FROM action_board_cards
        ${includeDismissed ? '' : 'WHERE dismissed = false'}
        ORDER BY COALESCE(impact_amount_override, impact_amount) DESC
      `);
      res.json({ generated_at: new Date().toISOString(), cards: result.rows });
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
  });

  router.get('/api/action-board/cards/:id/history', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM action_board_card_events WHERE card_id = $1 ORDER BY created_at DESC`,
        [req.params.id]
      );
      res.json(result.rows);
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
  });

  // Partial update: move stage, dismiss/undismiss, override the £ impact used for sorting,
  // and/or leave a note - used both by the board UI directly and by the chatbot's
  // update_action_board_card tool when the user argues a card's priority with it. Any stage
  // or impact change here is a USER override: it sticks until POST /:id/revert.
  router.post('/api/action-board/cards/:id', async (req, res) => {
    const { id } = req.params;
    const { stage, dismissed, impact_amount_override, note } = req.body;
    if (stage !== undefined && !STAGES.includes(stage)) {
      return res.status(400).json({ error: `stage must be one of ${STAGES.join(', ')}` });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(`SELECT * FROM action_board_cards WHERE id = $1`, [id]);
      if (!existing.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Card not found' }); }
      const row = existing.rows[0];

      const next = {
        stage: stage !== undefined ? stage : row.stage,
        user_override: stage !== undefined ? true : row.user_override,
        dismissed: dismissed !== undefined ? !!dismissed : row.dismissed,
        impact_amount_override: impact_amount_override !== undefined
          ? (impact_amount_override === null ? null : parseFloat(impact_amount_override))
          : row.impact_amount_override,
        override_note: note !== undefined ? note : row.override_note,
      };

      const result = await client.query(`
        UPDATE action_board_cards SET
          stage = $1, user_override = $2, dismissed = $3, impact_amount_override = $4, override_note = $5,
          stage_changed_at = CASE WHEN $1 IS DISTINCT FROM stage THEN NOW() ELSE stage_changed_at END,
          updated_at = NOW()
        WHERE id = $6
        RETURNING *
      `, [next.stage, next.user_override, next.dismissed, next.impact_amount_override, next.override_note, id]);

      const changes = [];
      if (stage !== undefined && stage !== row.stage) changes.push(`stage ${row.stage} -> ${stage}`);
      if (dismissed !== undefined && !!dismissed !== row.dismissed) changes.push(dismissed ? 'dismissed' : 'undismissed');
      if (impact_amount_override !== undefined) changes.push(`impact override -> ${impact_amount_override}`);
      if (note) changes.push(`note: ${note}`);
      if (changes.length) {
        await client.query(
          `INSERT INTO action_board_card_events (card_id, event_type, note) VALUES ($1, 'user_update', $2)`,
          [id, changes.join('; ')]
        );
      }

      await client.query('COMMIT');
      res.json({ ok: true, card: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: err.message });
    } finally { client.release(); }
  });

  // Full reset back to pure AI judgement: clears stage override, dismissal, and impact
  // override in one go - "regret your point of view, go back to what the AI suggested".
  router.post('/api/action-board/cards/:id/revert', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(`SELECT * FROM action_board_cards WHERE id = $1`, [id]);
      if (!existing.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Card not found' }); }
      const row = existing.rows[0];
      const result = await client.query(`
        UPDATE action_board_cards SET
          stage = ai_stage, user_override = false, dismissed = false,
          impact_amount_override = NULL, override_note = NULL,
          stage_changed_at = CASE WHEN ai_stage IS DISTINCT FROM stage THEN NOW() ELSE stage_changed_at END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id]);
      await client.query(
        `INSERT INTO action_board_card_events (card_id, event_type, from_value, to_value) VALUES ($1,'reverted',$2,$3)`,
        [id, row.stage, result.rows[0].stage]
      );
      await client.query('COMMIT');
      res.json({ ok: true, card: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: err.message });
    } finally { client.release(); }
  });

  // Manual trigger - the scheduler calls runActionBoardEvaluation() directly, but this lets
  // the UI offer a "Refresh now" button, and makes testing a full run possible without
  // waiting for the next scheduled tick.
  router.post('/api/action-board/reevaluate', async (req, res) => {
    try {
      const result = await runActionBoardEvaluation({ pool, baseUrl });
      res.json({ ok: true, ...result });
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
  });

  return router;
}

module.exports = { ensureActionBoardSchema, runActionBoardEvaluation, scheduleDailyEvaluation, createActionBoardRouter, STAGES };
