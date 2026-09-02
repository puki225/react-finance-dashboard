import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';

// Same fast custom tooltip as Product Breakdown (native `title` has a fixed ~1s OS delay) —
// portalled to document.body so it can't get clipped by the table's own scroll container.
function HoverTooltip({ tip }) {
  if (!tip) return null;
  return createPortal(
    <div style={{
      position: 'fixed', top: tip.top, left: tip.left, zIndex: 9999, maxWidth: 320,
      background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6,
      padding: '6px 10px', fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.35)', pointerEvents: 'none',
    }}>
      {tip.text}
    </div>,
    document.body
  );
}

// Amazon is the account's UK marketplace throughout this dashboard, matching Product Breakdown.
const amazonUrl = (asin) => asin ? `https://www.amazon.co.uk/dp/${asin}` : null;

function ProductImage({ imageUrl, asin, sku, onEnter, onLeave }) {
  const url = amazonUrl(asin);
  const Tag = url ? 'a' : 'div';
  const linkProps = url ? { href: url, target: '_blank', rel: 'noopener noreferrer' } : {};
  return (
    <Tag
      {...linkProps}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: url ? 'pointer' : 'help', textDecoration: 'none' }}
    >
      {imageUrl ? <img src={imageUrl} alt={sku} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 15, opacity: 0.2 }}>◉</span>}
    </Tag>
  );
}

// Unicode regional-indicator flag emoji render inconsistently across platforms — Windows
// in particular falls back to a plain two-letter pill instead of the pictographic flag.
// Same flagcdn.com image approach WorldMap.js already uses for the same reason, so
// flags render identically everywhere regardless of the viewer's OS/font support.
function CountryFlag({ code }) {
  if (!code || code.length !== 2) return null;
  return (
    <img
      src={`https://flagcdn.com/20x15/${code.toLowerCase()}.png`} alt={code}
      style={{ width: 16, height: 12, borderRadius: 2, objectFit: 'cover', verticalAlign: 'middle', marginRight: 6 }}
      onError={e => { e.target.style.display = 'none'; }}
    />
  );
}

// ─── Period presets ────────────────────────────────────────────────────────
// Every preset pairs a current period (scenario 2) with the same period a year
// earlier (scenario 1 / "PY"), because a PVM bridge is only meaningful against a
// like-for-like comparator.
//
// Calendar presets (quarter, month) shift by a whole calendar year, so Q2-2026
// compares to Q2-2025. Week presets shift by 364 days (52 whole weeks) rather than
// a calendar year, which keeps the weekday alignment intact — a 12-week window
// compared to a calendar-year-shifted window would start on a different weekday and
// silently include/exclude an extra weekend, distorting the volume term.
const WEEK_SHIFT_DAYS = 364;

const pad2 = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const lastDayOfMonth = (year, month0) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
const addDays = (dateStr, days) => iso(new Date(Date.parse(dateStr + 'T00:00:00Z') + days * 86400000));

function lastCompleteQuarter() {
  const now = new Date();
  const q0 = Math.floor(now.getUTCMonth() / 3);
  const year = q0 === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const prevQ0 = q0 === 0 ? 3 : q0 - 1;
  const m0 = prevQ0 * 3;
  return {
    from: `${year}-${pad2(m0 + 1)}-01`,
    to: `${year}-${pad2(m0 + 3)}-${pad2(lastDayOfMonth(year, m0 + 2))}`,
  };
}
function lastCompleteMonth() {
  const now = new Date();
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const m0 = now.getUTCMonth() === 0 ? 11 : now.getUTCMonth() - 1;
  return { from: `${year}-${pad2(m0 + 1)}-01`, to: `${year}-${pad2(m0 + 1)}-${pad2(lastDayOfMonth(year, m0))}` };
}
// Calendar-year shift, clamped for the 29 Feb → 28 Feb case.
function shiftCalendarYear({ from, to }) {
  const back = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    const py = y - 1;
    return `${py}-${pad2(m)}-${pad2(Math.min(d, lastDayOfMonth(py, m - 1)))}`;
  };
  return { from: back(from), to: back(to) };
}
function lastNWeeks(weeks) {
  // Ends yesterday — today is partial and would understate the latest period's volume.
  const to = iso(new Date(Date.now() - 86400000));
  return { from: addDays(to, -(weeks * 7) + 1), to };
}

const PRESETS = [
  {
    id: 'lq', label: 'Last Quarter vs PY', build: () => {
      const s2 = lastCompleteQuarter();
      return { s1: shiftCalendarYear(s2), s2 };
    },
  },
  {
    id: 'lm', label: 'Last Month vs PY', build: () => {
      const s2 = lastCompleteMonth();
      return { s1: shiftCalendarYear(s2), s2 };
    },
  },
  ...[12, 6, 3].map(w => ({
    id: `l${w}w`, label: `L${w}W vs PY`, build: () => {
      const s2 = lastNWeeks(w);
      return { s1: { from: addDays(s2.from, -WEEK_SHIFT_DAYS), to: addDays(s2.to, -WEEK_SHIFT_DAYS) }, s2 };
    },
  })),
];

const LEVELS = [
  { id: 'country', label: 'Country' },
  { id: 'brand', label: 'Brand' },
  { id: 'asin', label: 'ASIN' },
];

const CHANNELS = [
  { id: 'all', label: 'All' },
  { id: 'shopify', label: 'Shopify' },
  { id: 'amazon', label: 'Amazon' },
];

// ─── Formatting ────────────────────────────────────────────────────────────
const fmtMoney = (n, sym = '£') => {
  const v = parseFloat(n || 0);
  return (v < 0 ? '−' : '') + sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};
const fmtMoney2 = (n, sym = '£') => {
  const v = parseFloat(n || 0);
  return (v < 0 ? '−' : '') + sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtSigned = (n, sym = '£') => {
  const v = parseFloat(n || 0);
  return (v < 0 ? '−' : '+') + sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};
const fmtNum = (n) => parseInt(n || 0, 10).toLocaleString('en-GB');
const fmtPct = (n) => parseFloat(n || 0).toFixed(2) + '%';
const fmtSignedPct = (n) => {
  const v = parseFloat(n || 0);
  return (v < 0 ? '−' : '+') + Math.abs(v).toFixed(2) + 'pp';
};
// A margin RATE always has to come from summed revenue and summed profit — averaging
// the child rows' own rates would weight a £5 variant the same as a £5,000 one — so
// every rate shown in the table (child, parent group, or total) is derived here.
const marginPct = (revenue, profit) => {
  const r = parseFloat(revenue || 0);
  return r === 0 ? 0 : (parseFloat(profit || 0) / r) * 100;
};

const subTab = (active) => ({
  padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
  border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
  background: active ? 'var(--accent)' : 'transparent',
  color: active ? '#fff' : 'var(--muted)',
  cursor: 'pointer', fontFamily: 'var(--font)', letterSpacing: '0.02em', transition: 'all 0.15s',
});
const chip = (active) => ({
  padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
  border: '1px solid ' + (active ? 'var(--accent2)' : 'var(--border)'),
  background: active ? 'var(--accent2)20' : 'transparent',
  color: active ? 'var(--accent2)' : 'var(--muted)',
  cursor: 'pointer', fontFamily: 'var(--font)', letterSpacing: '0.04em', transition: 'all 0.15s',
});
const groupLabel = {
  fontSize: 9, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em',
  textTransform: 'uppercase', paddingLeft: 2,
};
const dateInput = {
  background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6,
  padding: '5px 8px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', cursor: 'pointer',
};
const selectStyle = {
  background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6,
  padding: '6px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font)',
  cursor: 'pointer', minWidth: 130,
};

// ─── Growth arrow ──────────────────────────────────────────────────────────
// Spans from Scenario 1's column-center to Scenario 2's — for an N-column bar row
// that's always the [1/(2N), 1 − 1/(2N)] fraction of the row width; N is 5 for the
// £ bridge (Scenario1/Price/Volume/Mix/Scenario2) and 4 for the % bridge (no
// separate Price/Volume split, since a ratio has no independent "volume" term).
function GrowthArrow({ text, color, isMobile, columns }) {
  const inset = `${100 / (columns * 2)}%`;
  return (
    <div style={{ position: 'relative', height: isMobile ? 24 : 30, marginBottom: 4 }}>
      <div style={{ position: 'absolute', left: inset, right: inset, top: '50%', borderTop: `2px solid ${color}` }} />
      <div style={{
        position: 'absolute', right: inset, top: '50%', transform: 'translate(50%, -50%)',
        width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent',
        borderLeft: `7px solid ${color}`,
      }} />
      <div style={{
        position: 'absolute', left: '50%', top: 0, transform: 'translateX(-50%)',
        background: 'var(--bg2)', padding: '0 10px', fontSize: isMobile ? 11 : 13, fontWeight: 700,
        color, fontFamily: 'var(--mono)', whiteSpace: 'nowrap',
      }}>
        {text}
      </div>
    </div>
  );
}

// ─── Bridge chart engine ───────────────────────────────────────────────────
// Shared bar-rendering for both the £ bridge (5 columns: Scenario1/Price/Volume/
// Mix/Scenario2) and the margin-% bridge (8 columns: Scenario1/Price/Std COGS/
// Freight/Amazon Fees/FBA Fees/Mix/Scenario2) — a bar is just
// {label, sub, start, end, kind: 'total'|'effect', value, display}
// with `display` pre-formatted by the caller, so this component has no £-or-%
// specific logic at all. Bars are positioned against a shared scale that always
// includes 0 so a negative effect reads as genuinely below the axis, not just shorter.
function BridgeChart({ bars, isMobile }) {
  const H = isMobile ? 220 : 300;
  // Reserved space below the bar canvas purely for a value label that lands there — a bar
  // reaching (near) the container's own top has nowhere "above" to put its label, so it
  // always renders below instead; without a dedicated gap that label sits right at H and
  // collides with the bar's own name/subtitle immediately underneath it.
  const LABEL_GAP = 26;

  const pts = [0, ...bars.flatMap(b => [b.start, b.end])];
  const yMax = Math.max(...pts);
  const yMin = Math.min(...pts);
  const span = (yMax - yMin) || 1;
  const y = (v) => H * (yMax - v) / span;

  return (
    <div style={{ display: 'flex', gap: isMobile ? 6 : 14, alignItems: 'stretch' }}>
      {bars.map((b, i) => {
        const top = Math.min(y(b.start), y(b.end));
        const height = Math.max(Math.abs(y(b.end) - y(b.start)), 2);
        const positive = b.kind === 'total' ? true : (b.value || 0) >= 0;
        const color = b.kind === 'total' ? 'var(--accent2)' : positive ? 'var(--green)' : 'var(--red)';
        // Labels sit above the bar, or below it when the bar reaches the very top.
        const labelAbove = top > 22;
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ position: 'relative', height: H, marginBottom: LABEL_GAP }}>
              <div style={{
                position: 'absolute', top, height, left: '10%', width: '80%',
                background: color, opacity: b.kind === 'total' ? 1 : 0.85,
                borderRadius: 4, transition: 'all 0.25s ease',
              }} />
              <div style={{
                position: 'absolute', left: 0, right: 0, textAlign: 'center',
                top: labelAbove ? top - 20 : top + height + 4,
                fontSize: isMobile ? 10 : 12, fontWeight: 700, color,
                fontFamily: 'var(--mono)', whiteSpace: 'nowrap',
              }}>{b.display}</div>
              {/* Zero axis, only drawn when the scale actually crosses it */}
              {yMin < 0 && yMax > 0 && (
                <div style={{ position: 'absolute', top: y(0), left: 0, right: 0, borderTop: '1px dashed var(--border)' }} />
              )}
            </div>
            <div style={{ textAlign: 'center', minWidth: 0 }}>
              <div style={{ fontSize: isMobile ? 11 : 13, fontWeight: 600, color: 'var(--text)' }}>{b.label}</div>
              <div style={{ fontSize: isMobile ? 8 : 10, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.sub}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── £ bridge (Price / Volume / Mix) ───────────────────────────────────────
// showPctOfBase (Revenue mode only — see the call site) appends each effect's size as
// a % of scenario-1's value alongside its £ figure, so "how much of the move is Price
// vs Volume vs Mix" reads at a glance instead of requiring mental division.
function Waterfall({ bridge, s1, s2, sym, isMobile, showPctOfBase }) {
  const c1 = s1.value;
  const c2 = c1 + bridge.price;
  const c3 = c2 + bridge.volume;
  const c4 = c3 + bridge.mix; // == s2.value, bar the balancing rounding

  const pctOfBase = (v) => s1.value !== 0 ? (v / Math.abs(s1.value)) * 100 : null;
  const withPct = (v) => {
    const base = fmtSigned(v, sym);
    if (!showPctOfBase) return base;
    const p = pctOfBase(v);
    return p === null ? base : `${base} (${p >= 0 ? '+' : ''}${p.toFixed(1)}%)`;
  };

  const bars = [
    { label: 'Scenario 1', sub: `${s1.from} → ${s1.to}`, start: 0, end: c1, kind: 'total', display: fmtMoney(c1, sym) },
    { label: 'Price', sub: 'Δprice × vol₂, per member', start: c1, end: c2, kind: 'effect', value: bridge.price, display: withPct(bridge.price) },
    { label: 'Volume', sub: 'Δvol × blended price₁', start: c2, end: c3, kind: 'effect', value: bridge.volume, display: withPct(bridge.volume) },
    { label: 'Mix', sub: 'balancing figure', start: c3, end: c4, kind: 'effect', value: bridge.mix, display: withPct(bridge.mix) },
    { label: 'Scenario 2', sub: `${s2.from} → ${s2.to}`, start: 0, end: s2.value, kind: 'total', display: fmtMoney(s2.value, sym) },
  ];

  const totalDelta = s2.value - s1.value;
  const pct = s1.value !== 0 ? (totalDelta / Math.abs(s1.value)) * 100 : null;
  const growthPositive = totalDelta >= 0;
  const growthText = `${fmtSigned(totalDelta, sym)}${pct !== null ? ` (${growthPositive ? '+' : ''}${pct.toFixed(1)}%)` : ''}`;

  return (
    <div>
      <GrowthArrow text={growthText} color={growthPositive ? 'var(--green)' : 'var(--red)'} isMobile={isMobile} columns={bars.length} />
      <BridgeChart bars={bars} isMobile={isMobile} />
    </div>
  );
}

// ─── Margin-rate (%) bridge — Price/Std COGS/Freight/Amazon fees/FBA fees/Mix ──────
// A margin RATE (profit ÷ revenue) is a ratio, not an additive £ amount, so unlike
// the £ bridge there is no independent "volume" effect — scaling volume uniformly
// doesn't move a ratio at all. What used to be one lumped "Rate" bar is exploded into
// its 5 underlying drivers (they telescope exactly to the old Rate figure — see the
// server's /api/pvm margin_pct_bridge comment for the derivation); Mix is unchanged.
function MarginPctWaterfall({ pctBridge, s1, s2, isMobile }) {
  const c1 = pctBridge.scenario1_pct;
  const c2 = c1 + pctBridge.price_effect;
  const c3 = c2 + pctBridge.cogs_effect;
  const c4 = c3 + pctBridge.freight_effect;
  const c5 = c4 + pctBridge.amz_fee_effect;
  const c6 = c5 + pctBridge.fba_fee_effect; // == c1 + rate_effect
  const c7 = c6 + pctBridge.mix_effect; // == scenario2_pct, bar the balancing rounding

  const bars = [
    { label: 'Scenario 1', sub: `${s1.from} → ${s1.to}`, start: 0, end: c1, kind: 'total', display: fmtPct(c1) },
    { label: 'Price', sub: 'ASP per unit', start: c1, end: c2, kind: 'effect', value: pctBridge.price_effect, display: fmtSignedPct(pctBridge.price_effect) },
    { label: 'Std COGS', sub: 'unit cost of goods', start: c2, end: c3, kind: 'effect', value: pctBridge.cogs_effect, display: fmtSignedPct(pctBridge.cogs_effect) },
    { label: 'Freight', sub: 'inbound freight/unit', start: c3, end: c4, kind: 'effect', value: pctBridge.freight_effect, display: fmtSignedPct(pctBridge.freight_effect) },
    { label: 'Amazon Fees', sub: 'referral + closing fees', start: c4, end: c5, kind: 'effect', value: pctBridge.amz_fee_effect, display: fmtSignedPct(pctBridge.amz_fee_effect) },
    { label: 'FBA Fees', sub: 'fulfillment fee/unit', start: c5, end: c6, kind: 'effect', value: pctBridge.fba_fee_effect, display: fmtSignedPct(pctBridge.fba_fee_effect) },
    { label: 'Mix', sub: 'balancing figure', start: c6, end: c7, kind: 'effect', value: pctBridge.mix_effect, display: fmtSignedPct(pctBridge.mix_effect) },
    { label: 'Scenario 2', sub: `${s2.from} → ${s2.to}`, start: 0, end: pctBridge.scenario2_pct, kind: 'total', display: fmtPct(pctBridge.scenario2_pct) },
  ];

  const totalDelta = pctBridge.total_delta_pct;
  const growthPositive = totalDelta >= 0;
  const growthText = `${growthPositive ? '+' : ''}${totalDelta.toFixed(2)}pp`;

  return (
    <div>
      <GrowthArrow text={growthText} color={growthPositive ? 'var(--green)' : 'var(--red)'} isMobile={isMobile} columns={bars.length} />
      <BridgeChart bars={bars} isMobile={isMobile} />
    </div>
  );
}

// A single active filter, shown in the banner below the Hierarchy controls — click
// the × to drop just that one value (equivalent to a ctrl/cmd-click on its row again).
function FilterChip({ label, onRemove }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--bg3)',
      border: '1px solid var(--accent2)', borderRadius: 999, padding: '3px 6px 3px 10px',
      fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text)',
    }}>
      {label}
      <button
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        style={{
          background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer',
          fontSize: 13, lineHeight: 1, padding: '0 2px', fontFamily: 'inherit',
        }}
      >×</button>
    </span>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 6, fontFamily: 'var(--mono)', color: accent || 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export default function PVM() {
  const isMobile = useIsMobile();
  const [metric, setMetric] = useState(() => localStorage.getItem('gb_pvm_metric') || 'revenue');
  // Only meaningful in Margin mode — 'currency' is the existing £ Price/Volume/Mix
  // bridge, 'percent' is the margin RATE (ppt) bridge. Revenue mode has no % analogue
  // (revenue ÷ revenue is trivially 100%), so this is simply ignored outside Margin.
  const [marginView, setMarginView] = useState('currency');
  const [level, setLevel] = useState(() => localStorage.getItem('gb_pvm_level') || 'asin');
  const [channel, setChannel] = useState(() => localStorage.getItem('gb_pvm_channel') || 'all');
  const [presetId, setPresetId] = useState('lq');
  const [periods, setPeriods] = useState(() => PRESETS[0].build());
  // Each is an array — the dropdowns below set a single-element array, while
  // ctrl/cmd-clicking a breakdown-table row toggles membership for multi-select.
  const [filters, setFilters] = useState({ country: [], brand: [], asin: [], sku: [] });

  const applyPreset = (p) => { setPresetId(p.id); setPeriods(p.build()); };
  const setScenario = (which, field, value) => {
    setPresetId('custom');
    setPeriods(prev => ({ ...prev, [which]: { ...prev[which], [field]: value } }));
  };
  const chooseMetric = (m) => { setMetric(m); localStorage.setItem('gb_pvm_metric', m); };
  const chooseLevel = (l) => { setLevel(l); localStorage.setItem('gb_pvm_level', l); };
  // Switching channel changes which SKUs/ASINs/brands are even in scope, so a filter
  // selected under the old channel (e.g. a Shopify-only SKU with no ASIN, filtered
  // while on "All") can silently zero out the whole result under "Amazon" — clear
  // filters on every channel switch rather than leave a stale, invisible-cause filter.
  const chooseChannel = (c) => { setChannel(c); localStorage.setItem('gb_pvm_channel', c); setFilters({ country: [], brand: [], asin: [], sku: [] }); };

  // Toggles a row's filter values. Takes a LIST because one row can stand for several
  // values — a parent-ASIN group row selects all of its child ASINs at once.
  // Non-additive click (no ctrl/cmd): selecting what's already the sole selection clears
  // it (click to drill in, click again to back out); otherwise it replaces the selection
  // within this row's own dimension(s), leaving a filter on another dimension alone.
  // Additive (ctrl/cmd-click): folds this row's values in/out of the existing selection.
  const toggleTargets = (targets, additive) => {
    if (!targets.length) return;
    setFilters(prev => {
      const next = { ...prev };
      const allSelected = targets.every(t => (prev[t.field] || []).includes(t.value));
      if (additive) {
        for (const t of targets) {
          const cur = next[t.field] || [];
          next[t.field] = allSelected
            ? cur.filter(v => v !== t.value)
            : (cur.includes(t.value) ? cur : [...cur, t.value]);
        }
        return next;
      }
      // At ASIN level a member is keyed by asin OR sku, so both are this row's dimension.
      const touched = level === 'asin' ? ['asin', 'sku'] : [...new Set(targets.map(t => t.field))];
      const onlyThis = allSelected && touched.reduce((n, f) => n + (prev[f] || []).length, 0) === targets.length;
      for (const f of touched) next[f] = [];
      if (!onlyThis) for (const t of targets) next[t.field] = [...next[t.field], t.value];
      return next;
    });
  };
  const clearFilters = () => setFilters({ country: [], brand: [], asin: [], sku: [] });
  const hasActiveFilters = filters.country.length || filters.brand.length || filters.asin.length || filters.sku.length;
  const showPct = metric === 'margin' && marginView === 'percent';
  // Channel Mix (revenue/margin hiding inside a member's own blended Price/Rate because
  // its Amazon-vs-Shopify unit or revenue split shifted) is only a meaningful, distinct
  // story when both channels are actually in view — filtered to one channel, every row
  // IS single-channel, so it would just be a column of zeros. Drop it entirely then.
  const showChannelMix = channel === 'all';

  // Empty filter arrays must be omitted entirely — URLSearchParams would otherwise
  // serialise them as literal "" and the server would filter on that. The CURRENT
  // level's own dimension is deliberately left off the request (except in %-mode, see
  // below) so the table keeps listing every row at this level — letting you keep
  // ctrl/cmd-clicking more of them — instead of narrowing away every sibling the moment
  // one is picked. The £ Price/Volume/Mix bridge is then re-aggregated client-side from
  // just the selected rows (see `effective` below), which is exact because those figures
  // are plain per-member sums. The margin-RATE (%) bridge can't do the same trick — its
  // Price/COGS/Freight/Fees drivers are weighted by each member's share of scenario-1
  // REVENUE, so re-deriving them for an arbitrary subset needs the same server-side
  // computation the full page uses — so in %-mode the self filter IS sent, and the table
  // narrows immediately like any other filter.
  const params = useMemo(() => {
    const p = {
      s1_from: periods.s1.from, s1_to: periods.s1.to,
      s2_from: periods.s2.from, s2_to: periods.s2.to,
      metric, level, channel,
    };
    // The filter dimension(s) matching the CURRENTLY DISPLAYED breakdown level — e.g. at
    // asin level, a member is identified by either 'asin' or 'sku' (see clickableFilterFor).
    const selfFields = level === 'country' ? ['country'] : level === 'brand' ? ['brand'] : ['asin', 'sku'];
    for (const field of ['country', 'brand', 'asin', 'sku']) {
      if (!showPct && selfFields.includes(field)) continue;
      if (filters[field].length) p[field] = filters[field].join(',');
    }
    return p;
  }, [periods, metric, level, channel, filters, showPct]);

  const { data, loading, error } = useApi('/api/pvm', params);
  const sym = data?.currency_symbol || '£';
  const metricLabel = metric === 'margin' ? 'Gross Profit' : 'Net Revenue';
  const unitLabel = metric === 'margin' ? 'margin/unit' : 'price/unit';

  // Margin rate is derived here rather than read off the server's own s1_margin_pct so
  // it exists in EVERY metric mode (the server only builds that field for the margin-%
  // bridge) and so one rule covers child rows, parent-group rows and the footer total.
  const rawMembers = useMemo(() => (data?.members || []).map(m => ({
    ...m,
    s1_margin_pct: marginPct(m.s1_revenue, m.s1_profit),
    s2_margin_pct: marginPct(m.s2_revenue, m.s2_profit),
  })), [data]);
  const opts = data?.options || { countries: [], brands: [], asins: [] };
  const [hoverTip, setHoverTip] = useState(null);
  const showProduct = level === 'asin';

  // Which filter dimension (and value) a click on this row drills into — null for a
  // synthetic bucket (e.g. a null-country "Unknown" group) that has no real filterable
  // value. At asin level, m.asin/m.sku genuinely identify that one row's own product
  // (unlike at country/brand level, where they're just whichever underlying row
  // happened to seed the group) — sku is the fallback for a member with no real ASIN
  // (e.g. a Shopify-only SKU).
  const clickableFilterFor = (m) => {
    if (level === 'country') return opts.countries.includes(m.key) ? { field: 'country', value: m.key } : null;
    if (level === 'brand')   return opts.brands.includes(m.key) ? { field: 'brand', value: m.key } : null;
    if (m.asin) return { field: 'asin', value: m.asin };
    if (m.sku)  return { field: 'sku', value: m.sku };
    return null;
  };
  // What clicking a row selects — one value normally, every child's value for a
  // parent-ASIN group row.
  const filterTargetsFor = (row) => {
    if (row.isGroup) return row.children.map(clickableFilterFor).filter(Boolean);
    const t = clickableFilterFor(row);
    return t ? [t] : [];
  };

  // null = the server's own order (largest absolute movement first). Once a column is
  // clicked, sort by its raw signed value instead — a plain numeric sort is what a click
  // on "Price"/"Volume"/"Mix"/"Δ Total" actually implies, not another abs-magnitude sort.
  const [sort, setSort] = useState({ key: null, dir: 'desc' });
  const toggleSort = (key) => {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' });
  };
  const members = useMemo(() => {
    if (!sort.key) return rawMembers;
    const mult = sort.dir === 'asc' ? 1 : -1;
    return [...rawMembers].sort((a, b) => (parseFloat(a[sort.key] || 0) - parseFloat(b[sort.key] || 0)) * mult);
  }, [rawMembers, sort]);

  const isMemberSelected = (m) => {
    const c = clickableFilterFor(m);
    return !!c && filters[c.field].includes(c.value);
  };

  // ── Parent-ASIN grouping ────────────────────────────────────────────────────
  // Variants of one product (same parent ASIN) collapse into a single expandable
  // row. Only at ASIN level, and only where a parent actually has more than one
  // child in the current selection — a "group" wrapping a single ASIN would just be
  // a row with a chevron that reveals itself. Every figure on a group row is summed
  // from its children (each per-member figure is an additive contribution to the
  // totals, so this is exact), except the rates: price/unit and margin % are
  // re-derived from the summed value/units/revenue/profit.
  const [expandedParents, setExpandedParents] = useState(() => new Set());
  const toggleParent = (parentAsin) => {
    setExpandedParents(prev => {
      const next = new Set(prev);
      if (next.has(parentAsin)) next.delete(parentAsin); else next.add(parentAsin);
      return next;
    });
  };

  const aggregateGroup = (parentAsin, children) => {
    const sumOf = (f) => children.reduce((t, m) => t + (parseFloat(m[f]) || 0), 0);
    const s1Units = sumOf('s1_units'), s2Units = sumOf('s2_units');
    const s1Value = sumOf('s1_value'), s2Value = sumOf('s2_value');
    return {
      key: `parent:${parentAsin}`,
      isGroup: true,
      parentAsin,
      children,
      label: parentAsin,
      asin: parentAsin,
      // Variants of one product share artwork, so the first child's image represents
      // the group; there is no parent-level image_url in sku_parameters.
      image_url: children.find(c => c.image_url)?.image_url || null,
      product_name: children[0]?.product_name || parentAsin,
      s1_units: s1Units, s2_units: s2Units,
      s1_value: s1Value, s2_value: s2Value,
      s1_price: s1Units ? s1Value / s1Units : 0,
      s2_price: s2Units ? s2Value / s2Units : 0,
      s1_revenue: sumOf('s1_revenue'), s1_profit: sumOf('s1_profit'),
      s2_revenue: sumOf('s2_revenue'), s2_profit: sumOf('s2_profit'),
      s1_margin_pct: marginPct(sumOf('s1_revenue'), sumOf('s1_profit')),
      s2_margin_pct: marginPct(sumOf('s2_revenue'), sumOf('s2_profit')),
      price: sumOf('price'), volume: sumOf('volume'), mix: sumOf('mix'), delta: sumOf('delta'),
      channel_mix: sumOf('channel_mix'),
      price_effect: sumOf('price_effect'), cogs_effect: sumOf('cogs_effect'),
      freight_effect: sumOf('freight_effect'), amz_fee_effect: sumOf('amz_fee_effect'),
      fba_fee_effect: sumOf('fba_fee_effect'), rate_effect: sumOf('rate_effect'),
      channel_mix_effect: sumOf('channel_mix_effect'),
      mix_effect_pct: sumOf('mix_effect_pct'), delta_pct: sumOf('delta_pct'),
    };
  };

  // Footer margin rate — from summed revenue/profit across every listed row, so it
  // matches the rows above it whatever the metric mode or grouping.
  const tableTotals = useMemo(() => {
    const sumOf = (f) => rawMembers.reduce((t, m) => t + (parseFloat(m[f]) || 0), 0);
    return {
      s1_margin_pct: marginPct(sumOf('s1_revenue'), sumOf('s1_profit')),
      s2_margin_pct: marginPct(sumOf('s2_revenue'), sumOf('s2_profit')),
    };
  }, [rawMembers]);

  // Flat list of what the table actually renders: group rows (with their children
  // inlined right after when expanded) and ungrouped rows, in sort order.
  const displayRows = useMemo(() => {
    if (level !== 'asin') return members.map(m => ({ row: m, depth: 0 }));

    const byParent = new Map();
    const loose = [];
    for (const m of members) {
      // A member IS its own parent (a parent ASIN sold directly) or has none — either
      // way there's no group to fold it into on its own.
      if (m.parent_asin && m.parent_asin !== m.asin) {
        if (!byParent.has(m.parent_asin)) byParent.set(m.parent_asin, []);
        byParent.get(m.parent_asin).push(m);
      } else {
        loose.push(m);
      }
    }

    const entries = [];
    for (const m of loose) entries.push({ row: m, depth: 0 });
    for (const [parentAsin, children] of byParent) {
      if (children.length < 2) entries.push({ row: children[0], depth: 0 });
      else entries.push({ row: aggregateGroup(parentAsin, children), depth: 0 });
    }

    // Groups sort against ungrouped rows on their aggregate, using the same comparator
    // the flat table uses; children keep the order they already came in.
    if (sort.key) {
      const mult = sort.dir === 'asc' ? 1 : -1;
      entries.sort((a, b) => (parseFloat(a.row[sort.key] || 0) - parseFloat(b.row[sort.key] || 0)) * mult);
    } else {
      entries.sort((a, b) => Math.abs(b.row.delta || 0) - Math.abs(a.row.delta || 0));
    }

    const out = [];
    for (const entry of entries) {
      out.push(entry);
      if (entry.row.isGroup && expandedParents.has(entry.row.parentAsin)) {
        for (const child of entry.row.children) out.push({ row: child, depth: 1 });
      }
    }
    return out;
  }, [members, level, sort, expandedParents]);

  const groupedParentCount = displayRows.filter(r => r.row.isGroup).length;
  // True when the CURRENT level's own dimension has an active selection (see the params
  // comment above) — the case where the table lists every row but the summary above it
  // needs to be re-aggregated down to just the selected ones.
  const selfSelectionActive = !showPct && (
    level === 'country' ? filters.country.length > 0 :
    level === 'brand'   ? filters.brand.length > 0 :
    (filters.asin.length > 0 || filters.sku.length > 0)
  );
  // The £ Price/Volume/Mix bridge (Revenue mode, or Margin's £ view) sums exactly from
  // its members either way, so summing just the selected ones is exact — no server
  // round-trip needed to show "what these selected rows alone are doing".
  const effective = useMemo(() => {
    if (!data) return null;
    if (!selfSelectionActive) return { scenario1: data.scenario1, scenario2: data.scenario2, bridge: data.bridge };
    const sel = rawMembers.filter(isMemberSelected);
    const sumOf = (f) => sel.reduce((t, m) => t + (parseFloat(m[f]) || 0), 0);
    const s1Units = sumOf('s1_units'), s2Units = sumOf('s2_units');
    const s1Value = sumOf('s1_value'), s2Value = sumOf('s2_value');
    return {
      scenario1: { ...data.scenario1, value: s1Value, units: s1Units, avg_price: s1Units ? s1Value / s1Units : 0 },
      scenario2: { ...data.scenario2, value: s2Value, units: s2Units, avg_price: s2Units ? s2Value / s2Units : 0 },
      bridge: { price: sumOf('price'), volume: sumOf('volume'), mix: sumOf('mix'), total_delta: s2Value - s1Value, channel_mix: sumOf('channel_mix') },
    };
  }, [data, rawMembers, selfSelectionActive, filters]);

  return (
    <div style={{ padding: isMobile ? '16px' : '28px 32px', display: 'flex', flexDirection: 'column', gap: isMobile ? 16 : 22 }}>

      {/* Header */}
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>PVM Analysis</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
          Price / Volume / Mix bridge between two scenario periods
        </p>
      </div>

      {/* Subheaders — Revenue | Margin */}
      <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={subTab(metric === 'revenue')} onClick={() => chooseMetric('revenue')}>Revenue</button>
        <button style={subTab(metric === 'margin')} onClick={() => chooseMetric('margin')}>Margin</button>
        {metric === 'margin' && (
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4, marginLeft: 8 }}>
            <button style={chip(marginView === 'currency')} onClick={() => { setMarginView('currency'); setSort({ key: null, dir: 'desc' }); }} title="Gross Profit £ bridge">£</button>
            <button style={chip(marginView === 'percent')} onClick={() => { setMarginView('percent'); setSort({ key: null, dir: 'desc' }); }} title="Margin rate (percentage-point) bridge">%</button>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={groupLabel}>Comparison</span>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4, flexWrap: 'wrap' }}>
            {PRESETS.map(p => (
              <button key={p.id} style={chip(presetId === p.id)} onClick={() => applyPreset(p)}>{p.label}</button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={groupLabel}>Scenario 1 (base)</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
            <input type="date" style={dateInput} value={periods.s1.from} onChange={e => setScenario('s1', 'from', e.target.value)} />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>→</span>
            <input type="date" style={dateInput} value={periods.s1.to} onChange={e => setScenario('s1', 'to', e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={groupLabel}>Scenario 2 (compare)</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
            <input type="date" style={dateInput} value={periods.s2.from} onChange={e => setScenario('s2', 'from', e.target.value)} />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>→</span>
            <input type="date" style={dateInput} value={periods.s2.to} onChange={e => setScenario('s2', 'to', e.target.value)} />
          </div>
        </div>
      </div>

      {/* Hierarchy */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={groupLabel}>Breakdown Level</span>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
            {LEVELS.map(l => (
              <button key={l.id} style={chip(level === l.id)} onClick={() => chooseLevel(l.id)}>{l.label}</button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={groupLabel}>Channel</span>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
            {CHANNELS.map(c => (
              <button key={c.id} style={chip(channel === c.id)} onClick={() => chooseChannel(c.id)}>{c.label}</button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={groupLabel}>Filter</span>
          <div style={{ display: 'flex', gap: 6, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4, flexWrap: 'wrap' }}>
            <select style={selectStyle} value={filters.country.length === 1 ? filters.country[0] : ''} onChange={e => setFilters(f => ({ ...f, country: e.target.value ? [e.target.value] : [] }))}>
              <option value="">All countries</option>
              {opts.countries.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select style={selectStyle} value={filters.brand.length === 1 ? filters.brand[0] : ''} onChange={e => setFilters(f => ({ ...f, brand: e.target.value ? [e.target.value] : [] }))}>
              <option value="">All brands</option>
              {opts.brands.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <select style={selectStyle} value={filters.asin.length === 1 ? filters.asin[0] : ''} onChange={e => setFilters(f => ({ ...f, asin: e.target.value ? [e.target.value] : [], sku: [] }))}>
              <option value="">All ASINs</option>
              {opts.asins.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            {hasActiveFilters > 0 && (
              <button style={chip(false)} onClick={clearFilters}>Clear</button>
            )}
          </div>
        </div>
      </div>

      {/* Active-filter banner — surfaces row-click selections (which don't show up in the
          dropdowns above once more than one value is picked) and gives one obvious way
          back to the unfiltered totals, alongside the small "Clear" in the Filter group. */}
      {hasActiveFilters > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: 'var(--bg2)', border: '1px solid var(--accent2)', borderRadius: 10, padding: '8px 12px' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Filtered</span>
          {filters.country.map(v => <FilterChip key={`country-${v}`} label={v} onRemove={() => toggleTargets([{ field: 'country', value: v }], true)} />)}
          {filters.brand.map(v => <FilterChip key={`brand-${v}`} label={v} onRemove={() => toggleTargets([{ field: 'brand', value: v }], true)} />)}
          {filters.asin.map(v => <FilterChip key={`asin-${v}`} label={v} onRemove={() => toggleTargets([{ field: 'asin', value: v }], true)} />)}
          {filters.sku.map(v => <FilterChip key={`sku-${v}`} label={v} onRemove={() => toggleTargets([{ field: 'sku', value: v }], true)} />)}
          <button style={{ ...chip(false), marginLeft: 'auto' }} onClick={clearFilters}>Clear — show total business</button>
        </div>
      )}

      {error && (
        <div style={{ background: '#f8717112', border: '1px solid #f8717140', borderRadius: 10, padding: '12px 16px', fontSize: 12, color: 'var(--red)' }}>
          {error}
        </div>
      )}
      {loading && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}

      {!loading && data && (
        <>
          {/* Summary stats */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {showPct ? (
              <>
                <StatCard label="S1 Margin %" value={fmtPct(data.margin_pct_bridge.scenario1_pct)} sub={`${data.scenario1.from} → ${data.scenario1.to}`} />
                <StatCard label="S2 Margin %" value={fmtPct(data.margin_pct_bridge.scenario2_pct)} sub={`${data.scenario2.from} → ${data.scenario2.to}`} />
                <StatCard
                  label="Total Δ" value={fmtSignedPct(data.margin_pct_bridge.total_delta_pct)}
                  accent={data.margin_pct_bridge.total_delta_pct >= 0 ? 'var(--green)' : 'var(--red)'}
                  sub="percentage points"
                />
              </>
            ) : (
              <>
                <StatCard
                  label={`S1 ${metricLabel}`} value={fmtMoney(effective.scenario1.value, sym)}
                  sub={`${fmtNum(effective.scenario1.units)} units · ${fmtMoney2(effective.scenario1.avg_price, sym)} ${unitLabel}`}
                />
                <StatCard
                  label={`S2 ${metricLabel}`} value={fmtMoney(effective.scenario2.value, sym)}
                  sub={`${fmtNum(effective.scenario2.units)} units · ${fmtMoney2(effective.scenario2.avg_price, sym)} ${unitLabel}`}
                />
                <StatCard
                  label="Total Δ" value={fmtSigned(effective.bridge.total_delta, sym)}
                  accent={effective.bridge.total_delta >= 0 ? 'var(--green)' : 'var(--red)'}
                  sub={effective.scenario1.value !== 0
                    ? `${(effective.bridge.total_delta / Math.abs(effective.scenario1.value) * 100).toFixed(1)}% vs base`
                    : '—'}
                />
              </>
            )}
          </div>

          {/* Bridge — reflects the selected subset when a same-level filter is active
              (see `effective` above), the full totals otherwise. */}
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: isMobile ? '18px 12px' : '24px 28px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 20 }}>
              {showPct ? 'Margin Rate Bridge' : `${metricLabel} Bridge`}
              {selfSelectionActive && <span style={{ color: 'var(--accent2)', fontWeight: 700, marginLeft: 8, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>selected rows only</span>}
              <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                {showPct ? '— mix is the residual after the rate drivers' : '— mix is the residual after price and volume'}
              </span>
            </div>
            {showPct
              ? <MarginPctWaterfall pctBridge={data.margin_pct_bridge} s1={data.scenario1} s2={data.scenario2} isMobile={isMobile} />
              : <Waterfall bridge={effective.bridge} s1={effective.scenario1} s2={effective.scenario2} sym={sym} isMobile={isMobile} showPctOfBase={metric === 'revenue'} />}
          </div>

          {/* Breakdown table */}
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
              By {LEVELS.find(l => l.id === level)?.label}
              <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                {members.length} {members.length === 1 ? 'row' : 'rows'}
                {groupedParentCount > 0 && ` · ${groupedParentCount} parent ${groupedParentCount === 1 ? 'group' : 'groups'}`}
                {sort.key ? ` — sorted by ${sort.key.replace(/_/g, ' ')} (${sort.dir === 'asc' ? 'low→high' : 'high→low'})` : ', largest movement first'}
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: (showProduct ? (showPct ? 1100 : 1180) : (showPct ? 1020 : 1100)) + (showChannelMix ? 120 : 0), borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--bg3)' }}>
                    {(showPct ? [
                      { label: '' },
                      { label: 'S1 Units', key: 's1_units' },
                      { label: 'S1 Margin %', key: 's1_margin_pct' },
                      { label: 'S2 Units', key: 's2_units' },
                      { label: 'S2 Margin %', key: 's2_margin_pct' },
                      { label: 'Price', key: 'price_effect' },
                      { label: 'Std COGS', key: 'cogs_effect' },
                      { label: 'Freight', key: 'freight_effect' },
                      { label: 'Amazon Fees', key: 'amz_fee_effect' },
                      { label: 'FBA Fees', key: 'fba_fee_effect' },
                      ...(showChannelMix ? [{ label: 'Channel Mix', key: 'channel_mix_effect' }] : []),
                      { label: 'Mix', key: 'mix_effect_pct' },
                      { label: 'Δ Total', key: 'delta_pct' },
                    ] : [
                      { label: '' },
                      { label: 'S1 Units', key: 's1_units' },
                      { label: `S1 ${unitLabel}`, key: 's1_price' },
                      { label: 'S1 Value', key: 's1_value' },
                      { label: 'S1 Margin %', key: 's1_margin_pct' },
                      { label: 'S2 Units', key: 's2_units' },
                      { label: `S2 ${unitLabel}`, key: 's2_price' },
                      { label: 'S2 Value', key: 's2_value' },
                      { label: 'S2 Margin %', key: 's2_margin_pct' },
                      { label: 'Price', key: 'price' },
                      ...(showChannelMix ? [{ label: 'Channel Mix', key: 'channel_mix' }] : []),
                      { label: 'Volume', key: 'volume' },
                      { label: 'Mix', key: 'mix' },
                      { label: 'Δ Total', key: 'delta' },
                    ]).map((h, i) => (
                      <th
                        key={i}
                        onClick={h.key ? () => toggleSort(h.key) : undefined}
                        style={{
                          padding: '10px 10px', textAlign: i === 0 ? 'left' : 'right',
                          fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                          color: sort.key === h.key ? 'var(--accent2)' : 'var(--muted)', whiteSpace: 'nowrap',
                          cursor: h.key ? 'pointer' : 'default', userSelect: 'none',
                        }}
                      >
                        {h.label}
                        {h.key && <span style={{ marginLeft: 4, opacity: sort.key === h.key ? 1 : 0.25 }}>{sort.key === h.key && sort.dir === 'asc' ? '▲' : '▼'}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.length === 0 && (
                    <tr><td colSpan={(showPct ? 12 : 13) + (showChannelMix ? 1 : 0)} style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--muted)' }}>No data for this selection</td></tr>
                  )}
                  {displayRows.map(({ row: m, depth }) => {
                    const cell = (v, color) => (
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: color || 'var(--text)', whiteSpace: 'nowrap' }}>{v}</td>
                    );
                    const effColor = (v) => v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--muted)';
                    const targets = filterTargetsFor(m);
                    // A group counts as selected only when every one of its children is.
                    const isSelected = targets.length > 0 && targets.every(t => filters[t.field].includes(t.value));
                    const isChild = depth > 0;
                    const expanded = m.isGroup && expandedParents.has(m.parentAsin);
                    return (
                      <tr
                        key={m.key}
                        onClick={targets.length ? (e) => toggleTargets(targets, e.ctrlKey || e.metaKey) : undefined}
                        title={targets.length ? 'Click to filter · ctrl/cmd-click to select multiple' : undefined}
                        style={{
                          borderTop: isChild ? '1px solid var(--border)' : '1px solid var(--border)',
                          borderLeft: isSelected ? '3px solid var(--accent2)' : '3px solid transparent',
                          background: isSelected ? '#a78bfa14' : isChild ? '#ffffff04' : 'transparent',
                          cursor: targets.length ? 'pointer' : 'default',
                        }}
                      >
                        <td style={{ padding: showProduct ? '8px 10px' : '9px 10px', maxWidth: 320, overflow: 'hidden' }}>
                          {showProduct ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, paddingLeft: isChild ? 22 : 0 }}>
                              {m.isGroup ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); toggleParent(m.parentAsin); }}
                                  title={expanded ? 'Collapse variants' : 'Expand variants'}
                                  style={{
                                    background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer',
                                    fontSize: 10, padding: '2px 4px', width: 18, flexShrink: 0, fontFamily: 'inherit',
                                  }}
                                >{expanded ? '▼' : '▶'}</button>
                              ) : !isChild && <span style={{ width: 18, flexShrink: 0 }} />}
                              <ProductImage
                                imageUrl={m.image_url} asin={m.asin} sku={m.sku}
                                onEnter={e => {
                                  const r = e.currentTarget.getBoundingClientRect();
                                  setHoverTip({ text: m.product_name || m.sku || m.label, top: r.bottom + 6, left: r.left });
                                }}
                                onLeave={() => setHoverTip(null)}
                              />
                              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                                <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: m.isGroup ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {m.isGroup ? m.parentAsin : (m.sku || '—')}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {m.isGroup ? `${m.children.length} variants` : (m.asin || '—')}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }} title={m.label}>
                              {level === 'country' && <CountryFlag code={m.key} />}{m.label}
                            </span>
                          )}
                        </td>
                        {showPct ? (
                          <>
                            {cell(fmtNum(m.s1_units))}
                            {cell(fmtPct(m.s1_margin_pct), 'var(--muted)')}
                            {cell(fmtNum(m.s2_units))}
                            {cell(fmtPct(m.s2_margin_pct), 'var(--muted)')}
                            {cell(fmtSignedPct(m.price_effect), effColor(m.price_effect))}
                            {cell(fmtSignedPct(m.cogs_effect), effColor(m.cogs_effect))}
                            {cell(fmtSignedPct(m.freight_effect), effColor(m.freight_effect))}
                            {cell(fmtSignedPct(m.amz_fee_effect), effColor(m.amz_fee_effect))}
                            {cell(fmtSignedPct(m.fba_fee_effect), effColor(m.fba_fee_effect))}
                            {showChannelMix && cell(fmtSignedPct(m.channel_mix_effect), effColor(m.channel_mix_effect))}
                            {cell(fmtSignedPct(m.mix_effect_pct), effColor(m.mix_effect_pct))}
                            {cell(fmtSignedPct(m.delta_pct), effColor(m.delta_pct))}
                          </>
                        ) : (
                          <>
                            {cell(fmtNum(m.s1_units))}
                            {cell(fmtMoney2(m.s1_price, sym), 'var(--muted)')}
                            {cell(fmtMoney(m.s1_value, sym))}
                            {cell(fmtPct(m.s1_margin_pct), 'var(--muted)')}
                            {cell(fmtNum(m.s2_units))}
                            {cell(fmtMoney2(m.s2_price, sym), 'var(--muted)')}
                            {cell(fmtMoney(m.s2_value, sym))}
                            {cell(fmtPct(m.s2_margin_pct), 'var(--muted)')}
                            {cell(fmtSigned(m.price, sym), effColor(m.price))}
                            {showChannelMix && cell(fmtSigned(m.channel_mix, sym), effColor(m.channel_mix))}
                            {cell(fmtSigned(m.volume, sym), effColor(m.volume))}
                            {cell(fmtSigned(m.mix, sym), effColor(m.mix))}
                            {cell(fmtSigned(m.delta, sym), effColor(m.delta))}
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                {members.length > 0 && (
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg3)', fontWeight: 700 }}>
                      <td style={{ padding: '11px 10px' }}>Total</td>
                      {showPct ? (
                        <>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(data.scenario1.units)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtPct(data.margin_pct_bridge.scenario1_pct)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(data.scenario2.units)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtPct(data.margin_pct_bridge.scenario2_pct)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSignedPct(data.margin_pct_bridge.price_effect)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSignedPct(data.margin_pct_bridge.cogs_effect)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSignedPct(data.margin_pct_bridge.freight_effect)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSignedPct(data.margin_pct_bridge.amz_fee_effect)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSignedPct(data.margin_pct_bridge.fba_fee_effect)}</td>
                          {showChannelMix && <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSignedPct(data.margin_pct_bridge.channel_mix_effect)}</td>}
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSignedPct(data.margin_pct_bridge.mix_effect)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtSignedPct(data.margin_pct_bridge.total_delta_pct)}</td>
                        </>
                      ) : (
                        <>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(data.scenario1.units)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtMoney2(data.scenario1.avg_price, sym)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtMoney(data.scenario1.value, sym)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtPct(tableTotals.s1_margin_pct)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(data.scenario2.units)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtMoney2(data.scenario2.avg_price, sym)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtMoney(data.scenario2.value, sym)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtPct(tableTotals.s2_margin_pct)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSigned(data.bridge.price, sym)}</td>
                          {showChannelMix && <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSigned(data.bridge.channel_mix, sym)}</td>}
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSigned(data.bridge.volume, sym)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSigned(data.bridge.mix, sym)}</td>
                          <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtSigned(data.bridge.total_delta, sym)}</td>
                        </>
                      )}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
              {showPct ? (
                <>Rate is each row's own margin-rate change, weighted at its scenario-1 revenue share — it isolates
                  "did this row itself get more/less profitable" from "did the revenue mix shift toward it." Mix is
                  the residual, capturing that share shift. A row with revenue in only one scenario has no rate to
                  compare, so its whole movement counts as Mix. Rows sum exactly to the Total.
                  {showChannelMix && ' Channel Mix is carved OUT of Rate (not incremental to it) — it isolates how much of a row’s own rate move came from its Amazon/Shopify revenue split shifting, as opposed to either channel genuinely getting more or less profitable.'}</>
              ) : (
                <>Price is each row's own {unitLabel} change on its scenario-2 units. Volume is the unit change
                  priced at the blended scenario-1 {unitLabel} ({fmtMoney2(data.scenario1.avg_price, sym)}), so a row's
                  mix is its unit change × how far its own {unitLabel} sits from that blend. Rows sum exactly to the Total.
                  {showChannelMix && ' Channel Mix is carved OUT of Price (not incremental to it) — it isolates how much of a row’s own blended-price move came from its Amazon/Shopify unit split shifting, as opposed to either channel’s own price genuinely moving.'}</>
              )}
            </div>
          </div>
        </>
      )}
      <HoverTooltip tip={hoverTip} />
    </div>
  );
}
