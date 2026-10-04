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
      impact_amount NUMERIC NOT NULL DEFAULT 0,
      impact_baseline NUMERIC NOT NULL DEFAULT 0, -- impact at first detection; weights this member in the card's aggregate progress
      kpi_name TEXT,
      kpi_value NUMERIC,
      kpi_target NUMERIC,
      kpi_baseline NUMERIC,
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
// description, impact_amount, currency_symbol, kpi_name, kpi_value, kpi_target, kpi_unit,
// kpi_direction }. `subject` is the bare product/account name (used in group-card summaries);
// `title`/`description` are the full, SKU-specific sentences (used as-is when a card has only
// one member). Materiality floors (impact_amount thresholds below) exist so a card doesn't
// flicker in and out of existence over noise - every floor is a judgment call, not a measured
// fact, and is a reasonable first thing to loosen/tighten if the board feels too noisy or quiet.
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

  // Every £ figure below is framed as "what doing nothing costs over the next 30 days", not
  // an abstract/perpetual "£/month" run-rate - a concrete, bounded number reads as more
  // tangible than a rate that implies it just continues forever. The underlying math is
  // already a 30-day (or 30-day-equivalent) figure for every detector that uses this - this
  // only changes the words around the number, not the number itself.
  const inactionClause = (impact) => `Left as-is, this is projected to cost ${currencySymbol}${impact.toFixed(2)} over the next 30 days.`;

  // Peer benchmarks: medians across the wider, more stable 90-day window, each restricted to
  // SKUs where the metric is actually meaningful (e.g. only SKUs running ads for TACOS) so a
  // pile of zero-spend/zero-return SKUs doesn't drag the "normal" level down to nothing.
  const peerTacos = median(peer.filter(r => num(r.ppc_cost) > 0).map(r => num(r.tacos)));
  const peerReturnRate = median(peer.filter(r => num(r.units_sold) >= 5).map(r => num(r.units_refunded) / num(r.units_sold) * 100));
  const peerDiscountRate = median(peer.filter(r => num(r.gross_sales) > 0).map(r => num(r.total_discounts) / num(r.gross_sales) * 100));
  const peerMargin = median(peer.filter(r => num(r.net_revenue) >= 50).map(exVineMarginPct));

  for (const row of current) {
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

    // TACOS blowout: ad spend materially above what peer SKUs achieve for a similar sales mix
    // (the user's own worked example: "TACOS on a given product is 40% and is costing me
    // £300/month overspend when I could have it at 10% with similar CTR and volume").
    if (ppcCost > 0 && peerTacos !== null && tacos > peerTacos) {
      const impact = (tacos - peerTacos) / 100 * netRevenue;
      if (impact >= 30) {
        candidates.push({
          issue_type: 'tacos_blowout', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `High TACOS on ${subject}`,
          description: `TACOS is ${tacos.toFixed(1)}% vs a ${peerTacos.toFixed(1)}% peer benchmark across similar-selling SKUs (last 90 days) — ad spend here is outpacing what comparable products need. ${inactionClause(impact)}`,
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
            issue_type: 'high_returns', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `High return rate on ${subject}`,
            description: `${returnRate.toFixed(1)}% of units sold are coming back vs a ${peerReturnRate.toFixed(1)}% peer benchmark — worth checking for a quality, sizing, or listing-accuracy issue. ${inactionClause(impact)}`,
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
            issue_type: 'discount_leakage', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `Heavy discounting on ${subject}`,
            description: `${discountRate.toFixed(1)}% of gross sales is being discounted away vs a ${peerDiscountRate.toFixed(1)}% peer benchmark. ${inactionClause(impact)}`,
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
          issue_type: 'negative_margin', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `Thin/negative margin on ${subject}`,
          description: `Gross margin is ${marginPct.toFixed(1)}% over the last 30 days (excluding Vine giveaway units) vs a ${target.toFixed(1)}% target — this SKU is barely covering, or losing, its own cost to sell. ${inactionClause(impact)}`,
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
      const priorMargin = exVineMarginPct(priorRow);
      const drop = priorMargin - marginPct;
      if (drop >= 8) {
        const impact = (drop / 100) * netRevenue;
        if (impact >= 20) {
          candidates.push({
            issue_type: 'margin_compression', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `Margin slipping on ${subject}`,
            description: `Gross margin (excluding Vine giveaway units) dropped from ${priorMargin.toFixed(1)}% to ${marginPct.toFixed(1)}% vs the 30 days before — rising cost, price erosion, or promo pressure is eating into profit here. ${inactionClause(impact)}`,
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
    const subject = row.product_title || sku;

    const surcharge = num(row.surcharge_monthly);
    if (surcharge >= 15) {
      const agedUnits = num(row.age_271_365) + num(row.age_365_plus);
      candidates.push({
        issue_type: 'aged_inventory', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `Aged stock surcharge on ${subject}`,
        description: `${agedUnits} units have been sitting 271+ days, triggering a long-term storage surcharge that repeats every cycle until the stock sells, gets discounted out, or is removed. ${inactionClause(surcharge)}`,
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
              issue_type: 'stock_out', scope_key: sku, sku, subject, image_url: row.image_url || null, title: `Stock-out on ${subject}`,
              description: `Out of sellable stock while still selling ~${velocity.toFixed(1)} units/day. ${inactionClause(impact)}`,
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
        issue_type: 'cash_runway', scope_key: '', sku: null, subject: 'Cash balance', image_url: null,
        title: 'Cash balance projected to breach minimum threshold',
        description: `Projected balance dips to ${currencySymbol}${minBalance.toFixed(2)} on ${cashflow.min_balance_date}, ${currencySymbol}${shortfall.toFixed(2)} below the ${currencySymbol}${threshold.toFixed(2)} minimum threshold, in ${daysUntil} day(s).`,
        impact_amount: round2(shortfall), currency_symbol: currencySymbol,
        kpi_name: 'Days until threshold breach', kpi_value: daysUntil, kpi_target: 60,
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
  tacos_blowout: 'running ad spend well above the peer benchmark',
  high_returns: 'seeing return rates well above the peer benchmark',
  discount_leakage: 'being discounted well above the peer benchmark',
  negative_margin: 'running thin or negative margin',
  margin_compression: "seeing margin slip from where it was 30 days ago",
  aged_inventory: 'accumulating long-term storage surcharges on aged stock',
  stock_out: 'out of sellable stock despite real ongoing demand',
};

// Builds the group card's title/description from its member rows. A single-member group
// reads exactly like a v1 card (the member's own sentence); a multi-member group gets a
// generic issue-level summary - which product(s) are affected is shown visually on the card
// (product image + SKU chips, from `members`), not spelled out in this text. `members` should
// be the active (unresolved) ones when any exist, so a card doesn't keep advertising a fixed
// SKU in its headline - callers pass allMembers only when every one of them is resolved.
function synthesizeCardText(issueType, members) {
  const label = ISSUE_TYPE_LABELS[issueType] || issueType;
  if (members.length === 0) return { title: `${label} — resolved`, description: 'Every affected product is back within target.' };
  if (members.length === 1) return { title: members[0].title, description: members[0].description };
  const summary = ISSUE_TYPE_SUMMARY[issueType] || 'affected';
  return {
    title: `${label} across ${members.length} products`,
    description: `${members.length} products are ${summary}.`,
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
      const { title, description } = synthesizeCardText(issueType, allResolved ? [] : activeMembers);

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
          title = $1, description = $2, impact_amount = $3, currency_symbol = $4,
          pct_complete = $5, ai_stage = $6, stage = $7,
          stage_changed_at = CASE WHEN $7 IS DISTINCT FROM stage THEN NOW() ELSE stage_changed_at END,
          updated_at = NOW(), last_seen_at = NOW()
        WHERE id = $8
      `, [title, description, round2(totalImpact), currencySymbol, groupPct, aiStage, effectiveStage, cardId]);

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
    // kpi_baseline intentionally reuses the kpi_value param ($9) - the baseline IS the value
    // at the moment of first detection, by definition. Same for impact_baseline ($7/$8).
    const ins = (await client.query(`
      INSERT INTO action_board_members
        (card_id, issue_type, scope_key, sku, subject, image_url, title, description, impact_amount, impact_baseline,
         kpi_name, kpi_value, kpi_target, kpi_baseline, kpi_unit, kpi_direction, pct_complete, resolved)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$11,$13,$14,0,false)
      RETURNING id, kpi_value AS baseline, impact_baseline
    `, [cardId, c.issue_type, c.scope_key, c.sku, c.subject, c.image_url, c.title, c.description, c.impact_amount,
        c.kpi_name, c.kpi_value, c.kpi_target, c.kpi_unit, c.kpi_direction])).rows[0];
    memberId = ins.id; baseline = num(ins.baseline); impactBaseline = num(ins.impact_baseline);
  } else {
    memberId = existing.id; baseline = num(existing.kpi_baseline); impactBaseline = num(existing.impact_baseline);
  }

  const pct = clampPct(baseline, c.kpi_target, c.kpi_value, c.kpi_direction);
  const resolved = isResolved(c.kpi_value, c.kpi_target, c.kpi_direction);

  await client.query(`
    UPDATE action_board_members SET
      card_id = $1, subject = $2, image_url = $3, title = $4, description = $5, impact_amount = $6,
      kpi_value = $7, kpi_target = $8, pct_complete = $9, resolved = $10,
      updated_at = NOW(), last_seen_at = NOW()
    WHERE id = $11
  `, [cardId, c.subject, c.image_url, c.title, c.description, c.impact_amount, c.kpi_value, c.kpi_target, pct, resolved, memberId]);

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
