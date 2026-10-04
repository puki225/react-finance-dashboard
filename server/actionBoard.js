// ─── AI ACTION BOARD ────────────────────────────────────────────────────────
// A daily, £-impact-ranked list of business problems - "stock breaks, high TACOS on a given
// product, high returns, warehouse fees, etc." (the brief that started this) - surfaced as
// Trello-style cards (To Do / Doing / Done). Every number comes from the dashboard's OWN
// existing API routes (same reuse pattern as chat.js's callInternalApi), never fresh SQL
// re-deriving VAT/FX/COGS/forecast logic that those routes already get right.
//
// Extensible by design: detectAllIssues() below is a flat list of independent checks, each
// emitting zero or more candidate ISSUES (one per affected SKU, or one account-level), with a
// real £ figure behind each. Adding a new area of the business to watch is adding one more
// check here - nothing else about the schema, scoring, or UI needs to know about it.
//
// Two-level model: a "card" (action_board_cards) is one flashcard on the board - ONE per
// issue_type (same root cause, same remedy). A "member" (action_board_members) is one
// concrete instance of that issue (one SKU, or the single account-level instance) - the
// per-SKU detail the card's dropdown shows, with its own KPI/impact/trend. Grouping by
// issue_type, not by anything finer, is the point: two SKUs with high TACOS share one card
// because the fix is the same shape of action; a SKU with high TACOS and a SKU with a
// stock-out never share a card even if both are "ads" or "inventory" broadly, because
// issue_type already encodes "the same action applies" - no extra logic needed for "if
// nuanced and a different action is required, a new card" (that's just a different
// issue_type to begin with).
//
// How a run moves things (runActionBoardEvaluation, daily via the scheduler in index.js, or
// on-demand via POST /reevaluate) - and the guarantee that nothing is ever lost or duplicated:
//   - Every card and member is upserted by its natural key (issue_type alone for a card;
//     issue_type + scope_key for a member) - never deleted, never re-created. A member not
//     re-detected this run is marked resolved (frozen at its last known value) rather than
//     removed, and a card whose issue_type detects zero candidates this run resolves the
//     same way - the full history stays queryable and nothing can duplicate on a later run.
//   - A card's KPI progress (`pct_complete`) is an impact-weighted average of its members'
//     own progress against their frozen baselines; `ai_stage` advances todo -> doing as that
//     climbs, snaps to 'done' once every member is resolved, and reopens to 'todo' if a
//     resolved issue comes back or a 'doing' card regresses.
//   - `stage` is what the board shows. It tracks `ai_stage` UNLESS a user has overridden it
//     (directly, or by arguing it out with the chatbot - see chat.js's
//     update_action_board_card / revert_action_board_card tools), in which case it holds
//     wherever the user put it until POST /:id/revert resets the card - stage, dismissal, and
//     any impact override - back to pure AI judgement.
//   - To Do is capped at MAX_TODO_CARDS (5), highest impact first - "not more than 5
//     flashcards at a time in to do ... we can keep adding once some make it to doing". A
//     card the AI would otherwise put in To Do but that doesn't make the cut queues in
//     'backlog' (not one of the 3 visible Trello stages) until a slot frees up on a later
//     run. A user who has explicitly pinned a card into To Do keeps it regardless of the cap
//     - that's a deliberate choice, not the AI's to overrule.
const express = require('express');

const STAGES = ['todo', 'doing', 'done']; // the only stages a user (or the chatbot, on their behalf) can set directly - 'backlog' is AI-internal
const MAX_TODO_CARDS = 5;

// ─── Schema ─────────────────────────────────────────────────────────────────────────────
async function ensureActionBoardSchema(pool) {
  // v1 (shipped a few hours before this) kept one flat card per (issue_type, SKU) - no
  // grouping, no member/trend tables. This version's shape is incompatible (cards no longer
  // carry scope_key/kpi_* directly - those moved to the new members table). Since v1 had been
  // live only briefly with nothing but AI-regenerable detections (no real user data worth a
  // hand-written migration), detect it by the presence of v1's `scope_key` column directly on
  // action_board_cards and drop-and-recreate rather than migrate column-by-column. This only
  // ever fires once, the first time a v2 server boots against a v1 database.
  const v1Check = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_board_cards' AND column_name = 'scope_key'
  `);
  if (v1Check.rows.length) {
    await pool.query(`
      DROP TABLE IF EXISTS action_board_card_events CASCADE;
      DROP TABLE IF EXISTS action_board_cards CASCADE;
    `);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS action_board_cards (
      id SERIAL PRIMARY KEY,
      issue_type TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      drivers TEXT,
      recommended_action TEXT,
      impact_amount NUMERIC NOT NULL DEFAULT 0,
      impact_amount_override NUMERIC,
      currency_symbol TEXT NOT NULL DEFAULT '£',
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS action_board_members (
      id SERIAL PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES action_board_cards(id) ON DELETE CASCADE,
      issue_type TEXT NOT NULL,
      -- '' for the single instance of an account-level issue (not nullable - Postgres treats
      -- every NULL as distinct, which would let duplicate account-level members slip past the
      -- UNIQUE constraint below).
      scope_key TEXT NOT NULL DEFAULT '',
      sku TEXT,
      subject TEXT, -- bare product/account name, for group-card summaries (title is a full sentence)
      image_url TEXT, -- product thumbnail for the flashcard's product chips; null for an account-level member
      title TEXT NOT NULL,
      description TEXT,
      drivers TEXT,
      recommended_action TEXT,
      impact_amount NUMERIC NOT NULL DEFAULT 0,
      impact_baseline NUMERIC NOT NULL DEFAULT 0, -- impact at first detection; weights this member in the card's aggregate progress
      kpi_name TEXT,
      kpi_value NUMERIC,
      kpi_target NUMERIC,
      kpi_baseline NUMERIC,
      kpi_basis TEXT, -- plain-English explanation of what kpi_target is actually based on (self-best window, peer benchmark, a stated assumption, ...)
      kpi_unit TEXT,
      kpi_direction TEXT,
      pct_complete NUMERIC NOT NULL DEFAULT 0,
      resolved BOOLEAN NOT NULL DEFAULT false,
      first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (issue_type, scope_key)
    );
    ALTER TABLE action_board_members ADD COLUMN IF NOT EXISTS image_url TEXT;
    ALTER TABLE action_board_cards ADD COLUMN IF NOT EXISTS drivers TEXT;
    ALTER TABLE action_board_cards ADD COLUMN IF NOT EXISTS recommended_action TEXT;
    ALTER TABLE action_board_members ADD COLUMN IF NOT EXISTS drivers TEXT;
    ALTER TABLE action_board_members ADD COLUMN IF NOT EXISTS recommended_action TEXT;
    ALTER TABLE action_board_members ADD COLUMN IF NOT EXISTS kpi_basis TEXT;
    CREATE TABLE IF NOT EXISTS action_board_member_snapshots (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES action_board_members(id) ON DELETE CASCADE,
      snapshot_date DATE NOT NULL,
      kpi_value NUMERIC,
      impact_amount NUMERIC,
      pct_complete NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (member_id, snapshot_date)
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

// Vine giveaway units (Amazon's free-review-copy program) are a known, real drag on a SKU's
// raw margin - COGS/fulfillment fees are incurred for a unit that brings in ~£0 revenue. That
// is real, deliberate marketing spend, not a business PROBLEM worth a flashcard, so margin
// detectors must never fire on a dip that Vine explains. Backs the Vine-attributable cost
// share out of margin: per-unit COGS/fulfillment fee don't vary by channel or reason, so
// splitting total_cogs/total_fees proportionally by (sold - vine) / sold units is exact, not
// an approximation - same product decision as the PVM bridge's own vine-exclude toggle (see
// pvmBaseRows in index.js), applied here from the vine_units count product-breakdown rows
// already carry, with no extra query needed.
function exVineMarginPct(row) {
  const unitsSold = num(row.units_sold);
  const netRevenue = num(row.net_revenue);
  if (unitsSold <= 0) return num(row.gross_margin_pct);
  const exVineUnits = Math.max(unitsSold - num(row.vine_units), 0);
  const ratio = exVineUnits / unitsSold;
  const exVineCogs = num(row.total_cogs) * ratio;
  const exVineFees = num(row.total_fees) * ratio;
  const exVineProfit = netRevenue - exVineCogs - exVineFees;
  return netRevenue > 0 ? (exVineProfit / netRevenue * 100) : 0;
}

// Interquartile-range outlier exclusion - drops anything more than 1.5x the IQR outside the
// middle 50%, the standard robust-statistics rule of thumb. Returns the input unchanged (never
// empty) when there aren't enough points to compute a meaningful IQR, or when excluding would
// leave nothing.
function excludeOutliers(vals) {
  if (vals.length < 4) return vals;
  const sorted = [...vals].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
  const cleaned = vals.filter(v => v >= lo && v <= hi);
  return cleaned.length ? cleaned : vals;
}

// A product's own best historical 30-day window is a more tangible, motivating end-goal than
// an abstract peer benchmark - "get it back to where it's already proven it can be", not "be
// as good as everyone else". Checks up to 6 trailing 30-day windows (the last ~6 months);
// falls back to the peer figure only when there isn't enough of the product's OWN history yet
// (under 3 qualifying windows - e.g. a product newer than ~3 months). `windowMaps` is an
// array of Map<sku, row>, one per historical window, in any order.
function selfBestOrPeerTarget({ sku, metricFn, validFn, direction, peerValue, windowMaps }) {
  const vals = [];
  for (const m of windowMaps) {
    const row = m.get(sku);
    if (row && validFn(row)) vals.push(metricFn(row));
  }
  if (vals.length >= 3) {
    const pool = excludeOutliers(vals);
    const target = direction === 'lower_better' ? Math.min(...pool) : Math.max(...pool);
    return { target, basis: `this product's own best 30-day window over the last 6 months (${vals.length} windows checked, outliers excluded)` };
  }
  if (peerValue !== null && peerValue !== undefined) {
    return { target: peerValue, basis: "a peer benchmark across similar-selling products (not enough of this product's own history yet for a self-referenced target)" };
  }
  return null;
}

// Decomposes a SKU's margin change between two product-breakdown rows into named £ drivers -
// price (ASP), discount, refunds, COGS, and fulfillment/referral fees - and names whichever
// moved against margin the most. Per-unit COGS/fees don't vary period to period for the same
// product, so a per-unit delta x current volume is each driver's exact £ contribution, not an
// approximation. ASP uses GROSS sales per unit (not net) specifically so the discount driver
// isn't silently double-counted inside it.
function diagnoseMarginDrivers(curRow, priorRow) {
  const curUnits = num(curRow.units_sold), priorUnits = num(priorRow.units_sold);
  if (curUnits <= 0 || priorUnits <= 0) return null;
  const curAsp = num(curRow.gross_sales) / curUnits, priorAsp = num(priorRow.gross_sales) / priorUnits;
  const curDisc = num(curRow.total_discounts) / curUnits, priorDisc = num(priorRow.total_discounts) / priorUnits;
  const curRefund = num(curRow.total_refunded) / curUnits, priorRefund = num(priorRow.total_refunded) / priorUnits;
  const curCogs = num(curRow.total_cogs) / curUnits, priorCogs = num(priorRow.total_cogs) / priorUnits;
  const curFees = num(curRow.total_fees) / curUnits, priorFees = num(priorRow.total_fees) / priorUnits;

  const candidates = [
    { name: 'price', label: 'a lower selling price', amount: (curAsp - priorAsp) * curUnits },
    { name: 'discount', label: 'heavier discounting', amount: -(curDisc - priorDisc) * curUnits },
    { name: 'refunds', label: 'more refunds', amount: -(curRefund - priorRefund) * curUnits },
    { name: 'cogs', label: 'rising unit cost (COGS)', amount: -(curCogs - priorCogs) * curUnits },
    { name: 'fees', label: 'rising Amazon fees', amount: -(curFees - priorFees) * curUnits },
  ];
  candidates.sort((a, b) => a.amount - b.amount); // most negative = biggest drag on margin
  const dominant = candidates[0];
  const actionByDriver = {
    price: 'Review pricing on this product — the list price itself has slipped.',
    discount: 'Pull back promotional depth/frequency on this product.',
    refunds: 'Investigate what\'s driving returns/refunds — a quality or listing-accuracy issue is the likely cause.',
    cogs: 'Revisit the supplier cost, or raise price to offset the rising unit cost.',
    fees: 'Check for an Amazon fee-structure or fulfillment-category change — price/cost are the main levers available to offset it.',
  };
  return {
    drivers: `${dominant.label.charAt(0).toUpperCase()}${dominant.label.slice(1)} is the main driver, based on a per-unit price/discount/refund/COGS/fee breakdown vs the comparison period.`,
    recommended_action: actionByDriver[dominant.name],
  };
}

// Simpler 2-factor version for TACOS: is the ratio climbing because spend is rising, or
// because sales are falling (so TACOS worsens even at flat spend)? Whichever moved more, in
// relative terms, is named as the driver.
function diagnoseTacosDrivers(curRow, priorRow) {
  if (!priorRow) return { drivers: 'Based on ad spend vs. sales over the comparison period.', recommended_action: 'Review campaign targeting/bids on this product.' };
  const curCost = num(curRow.ppc_cost), priorCost = num(priorRow.ppc_cost);
  const curRev = num(curRow.net_revenue), priorRev = num(priorRow.net_revenue);
  const costUpPct = priorCost > 0 ? (curCost - priorCost) / priorCost : (curCost > 0 ? 1 : 0);
  const revDownPct = priorRev > 0 ? Math.max(0, (priorRev - curRev) / priorRev) : 0;
  if (costUpPct > revDownPct && costUpPct > 0) {
    return {
      drivers: `Ad spend is up ~${Math.round(costUpPct * 100)}% vs the comparison period, outpacing sales.`,
      recommended_action: 'Reduce bids/budget or tighten targeting on this product.',
    };
  }
  if (revDownPct > 0) {
    return {
      drivers: `Sales are down ~${Math.round(revDownPct * 100)}% vs the comparison period while ad spend held roughly steady, which pushes TACOS up even without higher spend.`,
      recommended_action: 'Investigate the sales decline (seasonality, stock, competition) before cutting ad spend — the ratio, not the spend, is what moved.',
    };
  }
  return { drivers: "TACOS is elevated relative to this product's own best period.", recommended_action: 'Review campaign targeting/bids on this product.' };
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
// Each candidate (one MEMBER instance): { issue_type, scope_key, sku, subject, title,
// description, drivers, recommended_action, impact_amount, currency_symbol, kpi_name,
// kpi_value, kpi_target, kpi_basis, kpi_unit, kpi_direction }. `subject` is the bare
// product/account name (group-card summaries); `title`/`description` are the full,
// SKU-specific sentences (used as-is when a card has only one member). `description` states
// the PROBLEM as a fact; `drivers` says why (where that can be diagnosed from the data);
// `recommended_action` is a concrete next step tied to `kpi_target`; `kpi_basis` says what
// that target is actually based on, so it's never just an unexplained number. Materiality
// floors (impact_amount thresholds below) exist so a card doesn't flicker in and out of
// existence over noise - every floor is a judgment call, not a measured fact, and is a
// reasonable first thing to loosen/tighten if the board feels too noisy or quiet.
//
// Every per-SKU rate (TACOS, return rate, discount rate, margin) reads as its trailing
// 14-day average - "what it looks like right now", not a slower-moving 30-day blend - and is
// judged against the SKU's own best 30-day window over the last ~6 months (outliers
// excluded) wherever there's enough of that SKU's own history, falling back to a peer
// benchmark otherwise (see selfBestOrPeerTarget). £ impact is still framed as a 30-day cost,
// so a 14-day read is scaled up by 30/14 wherever it feeds an impact calculation.
const FOURTEEN_TO_THIRTY = 30 / 14;
async function detectAllIssues({ callInternalApi }) {
  const pb = (from, to) => callInternalApi('/api/product-breakdown', { from: fmt(from), to: fmt(to), channel: 'all' });
  const [last14, current, prior, w2, w3, w4, w5, peer, inventory, cashflow] = await Promise.all([
    pb(daysAgo(13), daysAgo(0)),
    pb(daysAgo(29), daysAgo(0)),
    pb(daysAgo(59), daysAgo(30)),
    pb(daysAgo(89), daysAgo(60)),
    pb(daysAgo(119), daysAgo(90)),
    pb(daysAgo(149), daysAgo(120)),
    pb(daysAgo(179), daysAgo(150)),
    pb(daysAgo(89), daysAgo(0)),
    callInternalApi('/api/inventory', {}),
    callInternalApi('/api/cashflow', {}),
  ]);

  const currencySymbol = inventory.currency_symbol || cashflow.currency_symbol || '£';
  const priorBySku = new Map(prior.map(r => [r.sku, r]));
  const peerBySku = new Map(peer.map(r => [r.sku, r]));
  // The last ~6 months of 30-day windows, checked for each SKU's own best-ever reading of a
  // given metric - see selfBestOrPeerTarget.
  const windowMaps = [current, prior, w2, w3, w4, w5].map(rows => new Map(rows.map(r => [r.sku, r])));
  const candidates = [];

  // Peer benchmarks (fallback only - see selfBestOrPeerTarget): medians across the wider,
  // more stable 90-day window, each restricted to SKUs where the metric is actually
  // meaningful (e.g. only SKUs running ads for TACOS) so a pile of zero-spend/zero-return
  // SKUs doesn't drag the "normal" level down to nothing.
  const peerTacos = median(peer.filter(r => num(r.ppc_cost) > 0).map(r => num(r.tacos)));
  const peerReturnRate = median(peer.filter(r => num(r.units_sold) >= 5).map(r => num(r.units_refunded) / num(r.units_sold) * 100));
  const peerDiscountRate = median(peer.filter(r => num(r.gross_sales) > 0).map(r => num(r.total_discounts) / num(r.gross_sales) * 100));
  const peerMargin = median(peer.filter(r => num(r.net_revenue) >= 50).map(exVineMarginPct));

  for (const row of last14) {
    const sku = row.sku;
    if (!sku) continue;
    const subject = row.product_title || sku;
    const netRevenue = num(row.net_revenue);
    const grossSales = num(row.gross_sales);
    const unitsSold = num(row.units_sold);
    const unitsRefunded = num(row.units_refunded);
    const ppcCost = num(row.ppc_cost);
    const tacos = num(row.tacos);
    const marginPct = exVineMarginPct(row); // always ex-Vine - see exVineMarginPct
    const priorRow = priorBySku.get(sku);

    // TACOS blowout: ad spend materially above this product's own best-ever rate (the
    // user's own worked example: "TACOS on a given product is 40% and is costing me
    // £300/month overspend when I could have it at 10% with similar CTR and volume").
    if (ppcCost > 0) {
      const t = selfBestOrPeerTarget({
        sku, direction: 'lower_better', peerValue: peerTacos, windowMaps,
        validFn: r => num(r.ppc_cost) > 0, metricFn: r => num(r.tacos),
      });
      if (t && tacos > t.target) {
        const impact = (tacos - t.target) / 100 * netRevenue * FOURTEEN_TO_THIRTY;
        if (impact >= 30) {
          const diag = diagnoseTacosDrivers(row, priorRow);
          candidates.push({
            issue_type: 'tacos_blowout', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `High TACOS on ${subject}`,
            description: `TACOS is ${tacos.toFixed(1)}% over the last 14 days, ad spend outpacing what this product needs.`,
            drivers: diag.drivers, recommended_action: `${diag.recommended_action} Target: back to ${t.target.toFixed(1)}%.`,
            impact_amount: round2(impact), currency_symbol: currencySymbol,
            kpi_name: 'TACOS', kpi_value: round1(tacos), kpi_target: round1(t.target), kpi_basis: t.basis,
            kpi_unit: '%', kpi_direction: 'lower_better',
          });
        }
      }
    }

    // High return rate vs this product's own best-ever rate - a quality/sizing/listing-
    // accuracy signal.
    if (unitsSold >= 3 && unitsRefunded > 0) {
      const t = selfBestOrPeerTarget({
        sku, direction: 'lower_better', peerValue: peerReturnRate, windowMaps,
        validFn: r => num(r.units_sold) >= 5, metricFn: r => num(r.units_refunded) / num(r.units_sold) * 100,
      });
      const returnRate = unitsRefunded / unitsSold * 100;
      if (t && returnRate > t.target) {
        const avgRefundPerUnit = num(row.total_refunded) / unitsRefunded;
        const excessUnits = Math.max(0, (returnRate - t.target) / 100 * unitsSold);
        const impact = excessUnits * avgRefundPerUnit * FOURTEEN_TO_THIRTY;
        if (impact >= 20) {
          candidates.push({
            issue_type: 'high_returns', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `High return rate on ${subject}`,
            description: `${returnRate.toFixed(1)}% of units sold over the last 14 days are coming back.`,
            drivers: 'Return rate alone, with no return-reason data available from Amazon to attribute it further.',
            recommended_action: `Review recent customer feedback/return reasons for a pattern (quality, sizing, listing accuracy). Target: back to ${t.target.toFixed(1)}%.`,
            impact_amount: round2(impact), currency_symbol: currencySymbol,
            kpi_name: 'Return rate', kpi_value: round1(returnRate), kpi_target: round1(t.target), kpi_basis: t.basis,
            kpi_unit: '%', kpi_direction: 'lower_better',
          });
        }
      }
    }

    // Discount leakage vs this product's own best-ever rate.
    if (grossSales > 0) {
      const t = selfBestOrPeerTarget({
        sku, direction: 'lower_better', peerValue: peerDiscountRate, windowMaps,
        validFn: r => num(r.gross_sales) > 0, metricFn: r => num(r.total_discounts) / num(r.gross_sales) * 100,
      });
      const discountRate = num(row.total_discounts) / grossSales * 100;
      if (t && discountRate > t.target) {
        const impact = (discountRate - t.target) / 100 * grossSales * FOURTEEN_TO_THIRTY;
        if (impact >= 20) {
          candidates.push({
            issue_type: 'discount_leakage', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `Heavy discounting on ${subject}`,
            description: `${discountRate.toFixed(1)}% of gross sales over the last 14 days is being discounted away.`,
            drivers: `Discount rate itself is the issue, not volume or price - ${discountRate.toFixed(1)}% discounted vs a ${t.target.toFixed(1)}% target.`,
            recommended_action: `Review promo cadence/depth on this product. Target: back to ${t.target.toFixed(1)}%.`,
            impact_amount: round2(impact), currency_symbol: currencySymbol,
            kpi_name: 'Discount rate', kpi_value: round1(discountRate), kpi_target: round1(t.target), kpi_basis: t.basis,
            kpi_unit: '%', kpi_direction: 'lower_better',
          });
        }
      }
    }

    // Thin/negative margin - a hard floor (margin under 5%), not a self/peer comparison,
    // since a SKU losing money is a problem regardless of what it or its peers normally do.
    if (netRevenue >= 25 && marginPct < 5) {
      const t = selfBestOrPeerTarget({
        sku, direction: 'higher_better', peerValue: peerMargin, windowMaps,
        validFn: r => num(r.net_revenue) >= 50, metricFn: exVineMarginPct,
      });
      const target = Math.max(10, t ? t.target : 10);
      const basis = t ? t.basis : 'a flat 10% floor (not enough history for a self or peer reference)';
      const impact = Math.max(0, (target - marginPct) / 100) * netRevenue * FOURTEEN_TO_THIRTY;
      if (impact >= 20) {
        const diag = priorRow ? diagnoseMarginDrivers(row, priorRow) : null;
        candidates.push({
          issue_type: 'negative_margin', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `Thin/negative margin on ${subject}`,
          description: `Gross margin is ${marginPct.toFixed(1)}% over the last 14 days (excluding Vine giveaway units) — this product is barely covering, or losing, its own cost to sell.`,
          drivers: diag ? diag.drivers : 'Not enough prior-period data to attribute a specific driver.',
          recommended_action: `${diag ? diag.recommended_action : 'Review price, cost, and discounting on this product.'} Target: back to ${target.toFixed(1)}%.`,
          impact_amount: round2(impact), currency_symbol: currencySymbol,
          kpi_name: 'Gross margin', kpi_value: round1(marginPct), kpi_target: round1(target), kpi_basis: basis,
          kpi_unit: '%', kpi_direction: 'higher_better',
        });
      }
    }

    // Margin compression vs this SKU's OWN prior 30 days - catches rising cost, price
    // erosion, or promo pressure even on a SKU whose margin is still "fine" in absolute terms.
    if (priorRow && netRevenue >= 25) {
      const priorMargin = exVineMarginPct(priorRow);
      const drop = priorMargin - marginPct;
      if (drop >= 8) {
        const impact = (drop / 100) * netRevenue * FOURTEEN_TO_THIRTY;
        if (impact >= 20) {
          const diag = diagnoseMarginDrivers(row, priorRow);
          candidates.push({
            issue_type: 'margin_compression', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `Margin slipping on ${subject}`,
            description: `Gross margin (excluding Vine giveaway units) has slipped to ${marginPct.toFixed(1)}% over the last 14 days, from ${priorMargin.toFixed(1)}% in the comparison period.`,
            drivers: diag ? diag.drivers : 'Rising cost, price erosion, or promo pressure is eating into profit here.',
            recommended_action: `${diag ? diag.recommended_action : 'Review price, cost, and discounting on this product.'} Target: back to ${priorMargin.toFixed(1)}%.`,
            impact_amount: round2(impact), currency_symbol: currencySymbol,
            kpi_name: 'Gross margin (vs prior period)', kpi_value: round1(marginPct), kpi_target: round1(priorMargin),
            kpi_basis: 'this product\'s own margin in the comparison period (30 days before the current reading)',
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
    const subject = row.product_title || sku;
    const velocity = num(row.daily_velocity);

    const surcharge = num(row.surcharge_monthly);
    if (surcharge >= 15) {
      const agedUnits = num(row.age_271_365) + num(row.age_365_plus);
      // "Reduce only the excess units" - not all aged stock is a problem, just whatever sits
      // beyond a reasonable buffer for how fast this product is still actually selling.
      const coverBuffer = Math.min(agedUnits, Math.round(velocity * 30));
      const excess = Math.max(0, agedUnits - coverBuffer);
      candidates.push({
        issue_type: 'aged_inventory', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `Aged stock surcharge on ${subject}`,
        description: `${agedUnits} units have been sitting 271+ days, triggering a long-term storage surcharge that repeats every cycle until the stock sells, gets discounted out, or is removed.`,
        drivers: velocity > 0
          ? `Sales velocity (~${velocity.toFixed(1)} units/day) isn't high enough to work through this stock at a normal pace.`
          : 'This product has had no recent sales velocity to work through the stock at all.',
        recommended_action: `Discount or liquidate the ~${excess} excess units; the remaining ~${coverBuffer} is within a normal buffer for current velocity.`,
        impact_amount: round2(surcharge), currency_symbol: currencySymbol,
        kpi_name: 'Aged units (271+ days)', kpi_value: agedUnits, kpi_target: coverBuffer,
        kpi_basis: `30 days of cover at this product's current sales velocity (~${velocity.toFixed(1)} units/day) — not zero, since holding some long-aged stock is normal for a slower mover`,
        kpi_unit: 'units', kpi_direction: 'lower_better',
      });
    }

    const sellable = num(row.sellable);
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
              issue_type: 'stock_out', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `Stock-out on ${subject}`,
              description: `Out of sellable stock while still selling ~${velocity.toFixed(1)} units/day.`,
              drivers: 'Demand has outpaced available stock.',
              recommended_action: `Expedite a reorder sized to restore cover (~${target} units).`,
              impact_amount: round2(impact), currency_symbol: currencySymbol,
              kpi_name: 'Sellable units', kpi_value: sellable, kpi_target: target,
              kpi_basis: `30 days of cover at this product's current sales velocity (~${velocity.toFixed(1)} units/day)`,
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
        issue_type: 'cash_runway', scope_key: '', sku: null, subject: 'Cash balance', image_url: null,
        title: 'Cash balance projected to breach minimum threshold',
        description: `Projected balance dips to ${currencySymbol}${minBalance.toFixed(2)} on ${cashflow.min_balance_date}, ${currencySymbol}${shortfall.toFixed(2)} below the ${currencySymbol}${threshold.toFixed(2)} minimum threshold, in ${daysUntil} day(s).`,
        drivers: 'Projected outflows (settlements, restocks, recurring fees) over the horizon exceed projected inflows before this date.',
        recommended_action: `Arrange a credit line, or delay a discretionary outflow, before ${cashflow.min_balance_date}.`,
        impact_amount: round2(shortfall), currency_symbol: currencySymbol,
        kpi_name: 'Days until threshold breach', kpi_value: daysUntil, kpi_target: 60,
        kpi_basis: 'a stated 60-day cash-buffer assumption, not a measured fact — adjust in Settings if your own comfort threshold differs',
        kpi_unit: 'days', kpi_direction: 'higher_better',
      });
    }
  }

  return candidates;
}

// ─── Scoring: baseline-relative progress + stage transitions ──────────────────────────────
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
// todo/doing/done advancement rule for a card's impact-weighted aggregate progress.
// `weekAgoPct` is the comparison point a MEANINGFUL trend is measured against - null means
// under a week of history exists yet, so no trend call can honestly be made either way; the
// stage just holds (a 1-5 day move is exactly what this is designed to ignore). Resolving and
// reopening are not trend calls - they're today's measured fact (the KPI crossed its target,
// or stopped being past it) - so those still happen immediately regardless of weekAgoPct.
function nextStage(currentStage, weekAgoPct, newPct, allResolved) {
  if (allResolved) return 'done';
  if (currentStage === 'done') return 'todo'; // was resolved, isn't any more - reopen at the top
  if (weekAgoPct === null) return currentStage; // not enough history yet to call a week-long trend
  if (newPct <= weekAgoPct - 10 && currentStage !== 'todo') return 'todo'; // regressed over the last week
  if (newPct >= weekAgoPct + 10 && newPct >= 15 && currentStage === 'todo') return 'doing';
  return currentStage;
}

const ISSUE_TYPE_LABELS = {
  tacos_blowout: 'High TACOS',
  high_returns: 'High return rate',
  discount_leakage: 'Heavy discounting',
  negative_margin: 'Thin/negative margin',
  margin_compression: 'Margin slipping',
  aged_inventory: 'Aged stock surcharge',
  stock_out: 'Stock-outs',
  cash_runway: 'Cash runway risk',
};
// One-clause description of what's wrong, reused across every member of a multi-member card -
// the card no longer lists member titles in prose (the board shows their product images/SKUs
// as chips instead - see client ActionBoard.js), so this only needs to name the shared problem.
const ISSUE_TYPE_SUMMARY = {
  tacos_blowout: { problem: 'running ad spend well above what each has proven it can run at', drivers: 'Each product\'s own drivers vary - expand below for the per-product breakdown.', action: 'Review targeting/bids product by product - see each one\'s own target and driver below.' },
  high_returns: { problem: 'seeing return rates well above target', drivers: 'No return-reason data available from Amazon to attribute this further.', action: 'Review recent customer feedback/return reasons per product - see below.' },
  discount_leakage: { problem: 'being discounted well above target', drivers: 'Discount rate itself is elevated on each - see below for each product\'s own target.', action: 'Review promo cadence/depth product by product - see below.' },
  negative_margin: { problem: 'running thin or negative margin', drivers: 'Drivers vary by product (price, discounting, cost, fees, refunds) - expand below.', action: 'Review price/cost/discounting per product - see each one\'s own driver below.' },
  margin_compression: { problem: 'seeing margin slip from the comparison period', drivers: 'Drivers vary by product - expand below for the per-product breakdown.', action: 'Review price/cost/discounting per product - see each one\'s own driver below.' },
  aged_inventory: { problem: 'accumulating long-term storage surcharges on aged stock', drivers: 'Sales velocity on each isn\'t high enough to work through the stock at a normal pace.', action: 'Discount or liquidate the excess aged units per product - see below for each one\'s amount.' },
  stock_out: { problem: 'out of sellable stock despite real ongoing demand', drivers: 'Demand has outpaced available stock on each.', action: 'Expedite reorders sized to restore cover - see below for each product\'s quantity.' },
};

// Builds the group card's title/description/drivers/action from its member rows. A
// single-member group reads exactly like its one member's own diagnosis; a multi-member group
// gets a generic issue-level summary - which product(s) are affected, and each one's own
// driver/target, is shown visually/in the dropdown instead (product chips + MemberRow detail -
// see client ActionBoard.js), not spelled out in this card-level text. `members` should be the
// active (unresolved) ones when any exist, so a card doesn't keep advertising a fixed SKU in
// its headline - callers pass allMembers only when every one of them is resolved.
function synthesizeCardText(issueType, members) {
  const label = ISSUE_TYPE_LABELS[issueType] || issueType;
  if (members.length === 0) {
    return { title: `${label} — resolved`, description: 'Every affected product is back within target.', drivers: null, recommended_action: null };
  }
  if (members.length === 1) {
    return { title: members[0].title, description: members[0].description, drivers: members[0].drivers, recommended_action: members[0].recommended_action };
  }
  const s = ISSUE_TYPE_SUMMARY[issueType] || { problem: 'affected', drivers: null, action: null };
  return {
    title: `${label} across ${members.length} products`,
    description: `${members.length} products are ${s.problem}.`,
    drivers: s.drivers, recommended_action: s.action,
  };
}

// ─── The daily (or on-demand) evaluation run ───────────────────────────────────────────────
async function runActionBoardEvaluation({ pool, baseUrl }) {
  const callInternalApi = makeCallInternalApi(baseUrl);
  const candidates = await detectAllIssues({ callInternalApi });
  const groups = new Map(); // issue_type -> candidates[]
  for (const c of candidates) {
    if (!groups.has(c.issue_type)) groups.set(c.issue_type, []);
    groups.get(c.issue_type).push(c);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // issue_types that exist in the DB but detected zero candidates this run - handled after
    // the main loop, same "resolve everything under it" path as a group whose members all
    // individually cleared.
    const existingIssueTypes = (await client.query(`SELECT DISTINCT issue_type FROM action_board_cards`)).rows.map(r => r.issue_type);
    for (const t of existingIssueTypes) if (!groups.has(t)) groups.set(t, []);

    for (const [issueType, members] of groups) {
      let cardRow = (await client.query(`SELECT * FROM action_board_cards WHERE issue_type = $1`, [issueType])).rows[0];
      if (!cardRow) {
        const placeholder = members[0] ? members[0].title : issueType;
        cardRow = (await client.query(`
          INSERT INTO action_board_cards (issue_type, title, description, currency_symbol, ai_stage, stage)
          VALUES ($1, $2, '', $3, 'todo', 'todo') RETURNING *
        `, [issueType, placeholder, members[0] ? members[0].currency_symbol : '£'])).rows[0];
      }
      const cardId = cardRow.id;
      if (cardRow.dismissed) {
        // Still refresh member numbers underneath so a later undismiss/revert isn't stale,
        // but never touch stage while dismissed - same rule as v1.
        for (const c of members) await upsertMember(client, cardId, c);
        continue;
      }

      const detectedKeys = new Set(members.map(c => c.scope_key));
      for (const c of members) await upsertMember(client, cardId, c);

      // Any member previously tracked under this issue_type but not re-detected this run has
      // genuinely cleared - resolve it (frozen at its last value), never delete it.
      const trackedMembers = (await client.query(`SELECT * FROM action_board_members WHERE issue_type = $1`, [issueType])).rows;
      for (const m of trackedMembers) {
        if (m.resolved || detectedKeys.has(m.scope_key)) continue;
        await client.query(`UPDATE action_board_members SET resolved = true, pct_complete = 100, updated_at = NOW() WHERE id = $1`, [m.id]);
        await client.query(`
          INSERT INTO action_board_member_snapshots (member_id, snapshot_date, kpi_value, impact_amount, pct_complete)
          VALUES ($1, CURRENT_DATE, $2, 0, 100)
          ON CONFLICT (member_id, snapshot_date) DO UPDATE SET pct_complete = 100, impact_amount = 0
        `, [m.id, m.kpi_value]);
      }

      // Aggregate the card from ALL its members (including just-resolved ones) - impact sums
      // only the still-active ones (a resolved issue no longer costs anything), but progress
      // is an impact-BASELINE-weighted average across everyone, so a big resolved member
      // visibly pulls the card forward.
      const allMembers = (await client.query(`SELECT * FROM action_board_members WHERE issue_type = $1`, [issueType])).rows;
      const activeMembers = allMembers.filter(m => !m.resolved);
      const totalImpact = activeMembers.reduce((s, m) => s + num(m.impact_amount), 0);
      let weightSum = 0, weightedPct = 0;
      for (const m of allMembers) {
        const w = Math.max(num(m.impact_baseline), 0.01);
        weightSum += w;
        weightedPct += w * num(m.pct_complete);
      }
      const groupPct = weightSum > 0 ? Math.round(weightedPct / weightSum) : 0;
      const allResolved = activeMembers.length === 0;
      const currencySymbol = (members[0] || allMembers[0])?.currency_symbol || cardRow.currency_symbol;
      const { title, description, drivers, recommended_action } = synthesizeCardText(issueType, allResolved ? [] : activeMembers);

      // Stage only moves on a pattern that's held for at least a week, never a 1-5 day blip -
      // so the comparison point is each member's own progress from 7+ days ago (its latest
      // snapshot at or before CURRENT_DATE - 7), not yesterday's run. Same impact-baseline
      // weighting as groupPct above, over whichever members have that much history; one that
      // doesn't yet (card/member younger than a week) simply doesn't contribute a vote. If
      // NOTHING has a week of history yet, weekAgoPct is null and nextStage leaves the stage
      // exactly where it is - "resolved"/"reopened" below are the only moves that still
      // happen immediately, since those are today's measured fact, not a trend call.
      const memberIds = allMembers.map(m => m.id);
      let weekAgoPct = null;
      if (memberIds.length) {
        const weekAgoResult = await client.query(`
          SELECT DISTINCT ON (member_id) member_id, pct_complete
          FROM action_board_member_snapshots
          WHERE member_id = ANY($1) AND snapshot_date <= CURRENT_DATE - INTERVAL '7 days'
          ORDER BY member_id, snapshot_date DESC
        `, [memberIds]);
        const weekAgoByMember = new Map(weekAgoResult.rows.map(r => [r.member_id, num(r.pct_complete)]));
        let weekAgoWeightSum = 0, weekAgoWeightedPct = 0;
        for (const m of allMembers) {
          if (!weekAgoByMember.has(m.id)) continue;
          const w = Math.max(num(m.impact_baseline), 0.01);
          weekAgoWeightSum += w;
          weekAgoWeightedPct += w * weekAgoByMember.get(m.id);
        }
        if (weekAgoWeightSum > 0) weekAgoPct = Math.round(weekAgoWeightedPct / weekAgoWeightSum);
      }
      const aiStage = nextStage(cardRow.ai_stage, weekAgoPct, groupPct, allResolved);
      const effectiveStage = cardRow.user_override ? cardRow.stage : aiStage;

      await client.query(`
        UPDATE action_board_cards SET
          title = $1, description = $2, drivers = $3, recommended_action = $4,
          impact_amount = $5, currency_symbol = $6,
          pct_complete = $7, ai_stage = $8, stage = $9,
          stage_changed_at = CASE WHEN $9 IS DISTINCT FROM stage THEN NOW() ELSE stage_changed_at END,
          updated_at = NOW(), last_seen_at = NOW()
        WHERE id = $10
      `, [title, description, drivers, recommended_action, round2(totalImpact), currencySymbol, groupPct, aiStage, effectiveStage, cardId]);

      if (aiStage !== cardRow.ai_stage) {
        await client.query(
          `INSERT INTO action_board_card_events (card_id, event_type, from_value, to_value) VALUES ($1,'ai_stage_change',$2,$3)`,
          [cardId, cardRow.ai_stage, aiStage]
        );
      }
    }

    // Cap: keep at most MAX_TODO_CARDS AI-assigned cards in 'todo' at once, highest impact
    // first. Overflow queues in 'backlog' until a slot frees up on a later run (a card
    // advancing to doing/done, getting dismissed, or reverted away). A card the user has
    // explicitly pinned into 'todo' keeps its slot outside the cap.
    const openCards = (await client.query(`
      SELECT id, ai_stage, stage, user_override, COALESCE(impact_amount_override, impact_amount) AS impact
      FROM action_board_cards WHERE dismissed = false
    `)).rows;
    const pinnedTodoCount = openCards.filter(r => r.user_override && r.stage === 'todo').length;
    const remainingSlots = Math.max(0, MAX_TODO_CARDS - pinnedTodoCount);
    const aiTodoCandidates = openCards
      .filter(r => !r.user_override && r.ai_stage === 'todo')
      .sort((a, b) => num(b.impact) - num(a.impact));
    for (let i = 0; i < aiTodoCandidates.length; i++) {
      const row = aiTodoCandidates[i];
      const wantStage = i < remainingSlots ? 'todo' : 'backlog';
      if (wantStage === row.ai_stage) continue;
      await client.query(`
        UPDATE action_board_cards SET ai_stage = $1, stage = $1,
          stage_changed_at = CASE WHEN $1 IS DISTINCT FROM stage THEN NOW() ELSE stage_changed_at END,
          updated_at = NOW()
        WHERE id = $2
      `, [wantStage, row.id]);
      await client.query(
        `INSERT INTO action_board_card_events (card_id, event_type, from_value, to_value, note) VALUES ($1,'ai_stage_change',$2,$3,'to-do capacity')`,
        [row.id, row.ai_stage, wantStage]
      );
    }

    await client.query('COMMIT');
    return { evaluated_at: new Date().toISOString(), candidate_count: candidates.length, group_count: groups.size };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Upserts one member row (by issue_type + scope_key) and appends today's snapshot. Shared by
// the dismissed- and active-card paths above so a dismissed card's members still get kept
// current, just without touching any stage.
async function upsertMember(client, cardId, c) {
  const existing = (await client.query(
    `SELECT * FROM action_board_members WHERE issue_type = $1 AND scope_key = $2`,
    [c.issue_type, c.scope_key]
  )).rows[0];

  let memberId, baseline, impactBaseline;
  if (!existing) {
    // kpi_baseline intentionally reuses the kpi_value param ($13) - the baseline IS the value
    // at the moment of first detection, by definition. Same for impact_baseline ($11).
    const ins = (await client.query(`
      INSERT INTO action_board_members
        (card_id, issue_type, scope_key, sku, subject, image_url, title, description, drivers, recommended_action,
         impact_amount, impact_baseline, kpi_name, kpi_value, kpi_target, kpi_baseline, kpi_basis, kpi_unit, kpi_direction,
         pct_complete, resolved)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$13,$15,$16,$17,0,false)
      RETURNING id, kpi_value AS baseline, impact_baseline
    `, [cardId, c.issue_type, c.scope_key, c.sku, c.subject, c.image_url, c.title, c.description, c.drivers, c.recommended_action,
        c.impact_amount, c.kpi_name, c.kpi_value, c.kpi_target, c.kpi_basis, c.kpi_unit, c.kpi_direction])).rows[0];
    memberId = ins.id; baseline = num(ins.baseline); impactBaseline = num(ins.impact_baseline);
  } else {
    memberId = existing.id; baseline = num(existing.kpi_baseline); impactBaseline = num(existing.impact_baseline);
  }

  const pct = clampPct(baseline, c.kpi_target, c.kpi_value, c.kpi_direction);
  const resolved = isResolved(c.kpi_value, c.kpi_target, c.kpi_direction);

  await client.query(`
    UPDATE action_board_members SET
      card_id = $1, subject = $2, image_url = $3, title = $4, description = $5, drivers = $6, recommended_action = $7,
      impact_amount = $8, kpi_value = $9, kpi_target = $10, kpi_basis = $11, pct_complete = $12, resolved = $13,
      updated_at = NOW(), last_seen_at = NOW()
    WHERE id = $14
  `, [cardId, c.subject, c.image_url, c.title, c.description, c.drivers, c.recommended_action,
      c.impact_amount, c.kpi_value, c.kpi_target, c.kpi_basis, pct, resolved, memberId]);

  await client.query(`
    INSERT INTO action_board_member_snapshots (member_id, snapshot_date, kpi_value, impact_amount, pct_complete)
    VALUES ($1, CURRENT_DATE, $2, $3, $4)
    ON CONFLICT (member_id, snapshot_date) DO UPDATE SET kpi_value = $2, impact_amount = $3, pct_complete = $4
  `, [memberId, c.kpi_value, c.impact_amount, pct]);

  return { memberId, impactBaseline };
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

  // Returns every card (grouped flashcard) with its members nested underneath, each member
  // carrying up to its last 30 daily snapshots as `trend` - the board's dropdown uses this to
  // show the individual per-SKU trend behind a multi-member card without a second round trip.
  router.get('/api/action-board/cards', async (req, res) => {
    try {
      const includeDismissed = req.query.include_dismissed === 'true';
      const cardsResult = await pool.query(`
        SELECT *, COALESCE(impact_amount_override, impact_amount) AS effective_impact
        FROM action_board_cards
        ${includeDismissed ? '' : 'WHERE dismissed = false'}
        ORDER BY COALESCE(impact_amount_override, impact_amount) DESC
      `);
      const cardIds = cardsResult.rows.map(r => r.id);
      const membersByCard = new Map();
      if (cardIds.length) {
        const membersResult = await pool.query(
          `SELECT * FROM action_board_members WHERE card_id = ANY($1) ORDER BY resolved ASC, impact_amount DESC`,
          [cardIds]
        );
        const memberIds = membersResult.rows.map(m => m.id);
        const trendByMember = new Map();
        if (memberIds.length) {
          const trendResult = await pool.query(`
            SELECT member_id, snapshot_date, kpi_value, impact_amount, pct_complete
            FROM action_board_member_snapshots
            WHERE member_id = ANY($1) AND snapshot_date >= CURRENT_DATE - INTERVAL '30 days'
            ORDER BY snapshot_date ASC
          `, [memberIds]);
          for (const t of trendResult.rows) {
            if (!trendByMember.has(t.member_id)) trendByMember.set(t.member_id, []);
            trendByMember.get(t.member_id).push(t);
          }
        }
        for (const m of membersResult.rows) {
          if (!membersByCard.has(m.card_id)) membersByCard.set(m.card_id, []);
          membersByCard.get(m.card_id).push({ ...m, trend: trendByMember.get(m.id) || [] });
        }
      }
      const cards = cardsResult.rows.map(c => ({ ...c, members: membersByCard.get(c.id) || [] }));
      res.json({ generated_at: new Date().toISOString(), max_todo_cards: MAX_TODO_CARDS, cards });
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
  // or impact change here is a USER override: it sticks (and, for 'todo', sits outside the
  // 5-card cap) until POST /:id/revert.
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
  // override in one go - "regret your point of view, go back to what the AI suggested". If
  // that hands it back to 'todo', the next evaluation run's capping pass decides whether it
  // actually keeps a To Do slot or queues in backlog.
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

module.exports = { ensureActionBoardSchema, runActionBoardEvaluation, scheduleDailyEvaluation, createActionBoardRouter, STAGES, MAX_TODO_CARDS };
