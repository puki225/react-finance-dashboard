import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from '../hooks/useApi';

const fmtMoney = (n, sym = '£') => {
  const v = parseFloat(n || 0);
  const abs = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (v < 0 ? '−' : '') + sym + abs;
};
const fmtDate = (d, granularity) => {
  if (!d) return '—';
  const opts = granularity === 'monthly'
    ? { month: 'short', year: '2-digit' }
    : { day: 'numeric', month: 'short' };
  return new Date(d).toLocaleDateString('en-GB', opts);
};
const fmtDateFull = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};

const STAGES = [
  { id: 'new', label: 'New', hex: '#6da7ec' },
  { id: 'growth', label: 'Growth', hex: '#2a78d6' },
  { id: 'mature', label: 'Mature', hex: '#1c5cab' },
  { id: 'plateau', label: 'Plateau', hex: 'var(--amber)' },
  { id: 'declining', label: 'Declining', hex: 'var(--red)' },
];
const stageMeta = (id) => STAGES.find(s => s.id === id) || { id, label: id || 'Unclassified', hex: 'var(--muted)' };

// Same fast custom tooltip as PVM/Product Breakdown (native `title` has a fixed ~1s OS
// delay) — portalled to document.body so it can't get clipped by the table's scroll box.
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
      style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: url ? 'pointer' : 'help', textDecoration: 'none' }}
    >
      {imageUrl ? <img src={imageUrl} alt={sku} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 13, opacity: 0.2 }}>◉</span>}
    </Tag>
  );
}

const cardStyle = {
  background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px',
};
const statCardStyle = { ...cardStyle, flex: 1, minWidth: 200, padding: '16px 18px' };
const cardLabel = { fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 };
const cardValue = { fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' };
const toggleBtn = (active) => ({
  padding: '5px 11px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
  border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border2)'),
  background: active ? 'var(--accent)25' : 'transparent',
  color: active ? 'var(--accent2)' : 'var(--muted)',
  fontFamily: 'var(--font)',
});

// ─── Combine actual + forecast per-day rows into one continuous series ────────────────
// Forecast rows start at "today" (day 0 of the horizon), which can overlap history's last
// (possibly partial) actual day — forecast wins that one date, since it's the model's
// full-day projection rather than a partial actual-so-far.
function buildDays(history, forecast) {
  const days = history.map(d => ({ date: d.date, value: parseFloat(d.revenue), actual: true }));
  const indexByDate = new Map(days.map((d, i) => [d.date, i]));
  for (const d of forecast) {
    const row = { date: d.date, value: parseFloat(d.revenue), low: parseFloat(d.low), high: parseFloat(d.high), actual: false };
    if (indexByDate.has(d.date)) days[indexByDate.get(d.date)] = row;
    else days.push(row);
  }
  return days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function bucketKey(dateStr, granularity) {
  const d = new Date(dateStr);
  if (granularity === 'monthly') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  if (granularity === 'weekly') {
    const day = d.getUTCDay();
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() + diffToMonday);
    return monday.toISOString().slice(0, 10);
  }
  return dateStr;
}

function bucketDays(days, granularity) {
  if (granularity === 'daily') return days;
  const buckets = new Map();
  for (const d of days) {
    const key = bucketKey(d.date, granularity);
    const cur = buckets.get(key) || { date: key, value: 0, low: 0, high: 0, hasBand: false, actual: true };
    cur.value += d.value;
    if (!d.actual) {
      cur.low += (d.low ?? d.value);
      cur.high += (d.high ?? d.value);
      cur.hasBand = true;
    }
    cur.actual = cur.actual && d.actual;
    buckets.set(key, cur);
  }
  return [...buckets.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(b => ({ date: b.date, value: b.value, actual: b.actual, low: b.hasBand ? b.low : undefined, high: b.hasBand ? b.high : undefined }));
}

// Pick a readable subset of x-axis tick indices regardless of series length: always the
// first, last, and "today" boundary, filled out to ~6 evenly-spaced ticks in between.
function pickTicks(n, todayIdx) {
  const want = new Set([0, n - 1]);
  if (todayIdx > 0 && todayIdx < n - 1) want.add(todayIdx);
  const target = Math.min(6, n);
  for (let k = 1; k < target - 1; k++) want.add(Math.round((k / (target - 1)) * (n - 1)));
  return [...want].sort((a, b) => a - b);
}

// "YYYY-MM" key so a hovered day can look up which calendar-month milestone it falls in.
function monthKeyOf(dateStr) {
  const d = new Date(dateStr);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const isoDate = (d) => d.toISOString().slice(0, 10);

// PY comparator for a Daily or Weekly bucket - 364 days back (52 whole weeks, weekday-
// aligned, same convention forecast-service's own PY blend uses), not a calendar year
// shift. Monthly is handled separately via `milestones` (calendar-month-aligned, which
// matters more at that grain than weekday alignment does). Weekly sums the matching
// 7-day PY window so it's comparing week-total to week-total, not one day to a week.
function pyValueForBucket(bucketDateStr, granularity, pyByDate) {
  if (granularity === 'monthly') return undefined; // caller uses milestoneByMonth instead
  const bucketDate = new Date(bucketDateStr);
  const span = granularity === 'weekly' ? 7 : 1;
  let sum = 0, found = false;
  for (let i = 0; i < span; i++) {
    const d = new Date(bucketDate);
    d.setUTCDate(d.getUTCDate() - 364 + i);
    const key = isoDate(d);
    if (pyByDate.has(key)) { sum += pyByDate.get(key); found = true; }
  }
  return found ? sum : null;
}

// ─── Main chart: actual (solid) -> forecast (dashed) with uncertainty band ────────────
function MainChart({ days, granularity, sym, milestones, pyByDate }) {
  const [hover, setHover] = useState(null);
  const W = 980, ML = 4, MR = 4, H = 220, XAXISH = 22;

  if (!days.length) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>No sales data yet.</div>;

  const todayIdx = days.reduce((last, d, i) => (d.actual ? i : last), -1);
  const N = days.length;
  const plotW = W - ML - MR;
  const slot = N > 1 ? plotW / (N - 1) : plotW;
  const x = (i) => ML + i * slot;

  const vals = days.map(d => (d.actual ? d.value : (d.high ?? d.value)));
  const lowVals = days.map(d => (d.actual ? d.value : (d.low ?? d.value)));
  const yMin = Math.min(...lowVals, 0) * (Math.min(...lowVals) < 0 ? 1.1 : 0.9);
  const yMax = Math.max(...vals) * 1.08 || 1;
  const y = (v) => H - ((v - yMin) / (yMax - yMin || 1)) * H;
  const ticks = [yMin, (yMin + yMax) / 2, yMax];

  let areaPath = '';
  if (todayIdx >= 0 && todayIdx < N - 1) {
    areaPath = `M${x(todayIdx)},${y(days[todayIdx].value)} `;
    for (let i = todayIdx; i < N; i++) areaPath += `L${x(i)},${y(days[i].high ?? days[i].value)} `;
    for (let i = N - 1; i >= todayIdx; i--) areaPath += `L${x(i)},${y(days[i].low ?? days[i].value)} `;
    areaPath += 'Z';
  }

  let actualPath = '';
  for (let i = 0; i <= todayIdx; i++) actualPath += (i === 0 ? 'M' : 'L') + x(i) + ',' + y(days[i].value) + ' ';
  let forecastPath = '';
  for (let i = Math.max(todayIdx, 0); i < N; i++) forecastPath += (i === Math.max(todayIdx, 0) ? 'M' : 'L') + x(i) + ',' + y(days[i].value) + ' ';

  const handleMove = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    // rect is the SVG's actual on-screen box; viewBox (W x H+XAXISH) maps onto it
    // independently per axis (preserveAspectRatio="none" below) - relX/relY must divide
    // by rect.width/rect.height respectively to match, not both by rect.width, or this
    // drifts the moment the rendered box's aspect ratio differs from the viewBox's.
    const relX = (e.clientX - rect.left) / rect.width * W;
    let i = Math.round((relX - ML) / slot);
    i = Math.max(0, Math.min(N - 1, i));
    setHover({ i, clientX: e.clientX, clientY: e.clientY });
  };
  const hoveredDay = hover ? days[hover.i] : null;
  const ticksX = pickTicks(N, todayIdx);

  // vs-PY comparison for the hovered point, at whatever grain the chart is currently
  // showing - a day compares to the same day last year, a week to the same week, a month
  // to the same month (via `milestones`, calendar-month-aligned rather than a 364-day
  // shift - matters more for months than weekday alignment does).
  const milestoneByMonth = new Map((milestones || []).map(m => [monthKeyOf(m.month), m.growth_pct]));
  let hoveredPyPct;
  if (hoveredDay) {
    if (granularity === 'monthly') {
      hoveredPyPct = milestoneByMonth.get(monthKeyOf(hoveredDay.date));
    } else {
      const pyValue = pyValueForBucket(hoveredDay.date, granularity, pyByDate);
      hoveredPyPct = pyValue === null ? null : (pyValue > 0 ? (((hoveredDay.value - pyValue) / pyValue) * 100).toFixed(1) : null);
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H + XAXISH}`} width="100%" height={H + XAXISH} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}
        onMouseMove={handleMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((v, idx) => {
          const yy = y(v);
          return (
            <g key={idx}>
              <line x1={ML} x2={W - MR} y1={yy} y2={yy} stroke="var(--border2)" strokeWidth={1} />
              <text x={ML} y={yy - 4} fontFamily="var(--mono)" fontSize={10} fill="var(--muted)">{sym}{Math.round(v / 1000)}K</text>
            </g>
          );
        })}
        {todayIdx >= 0 && todayIdx < N && (
          <>
            <line x1={x(todayIdx)} x2={x(todayIdx)} y1={0} y2={H} stroke="var(--border2)" strokeWidth={1} />
            <text x={x(todayIdx)} y={12} fontFamily="var(--mono)" fontSize={10} fill="var(--muted)" textAnchor="middle">Today</text>
          </>
        )}
        {areaPath && <path d={areaPath} fill="var(--accent)" opacity={0.12} />}
        <path d={actualPath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {forecastPath && <path d={forecastPath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="5,4" strokeLinejoin="round" strokeLinecap="round" />}
        {N > 0 && (
          <>
            <circle cx={x(N - 1)} cy={y(days[N - 1].value)} r={4} fill="var(--accent2)" stroke="var(--bg2)" strokeWidth={2} />
            <text x={x(N - 1) - 8} y={y(days[N - 1].value) - 10} fontFamily="var(--mono)" fontSize={11} fontWeight={500} fill="var(--text)" textAnchor="end">
              {fmtMoney(days[N - 1].value, sym)}
            </text>
          </>
        )}
        {ticksX.map(i => (
          <text key={i} x={x(i)} y={H + 16} fontFamily="var(--mono)" fontSize={10} fill="var(--muted)"
            textAnchor={i === 0 ? 'start' : (i === N - 1 ? 'end' : 'middle')}>
            {fmtDate(days[i].date, granularity)}
          </text>
        ))}
        {hover && (
          <>
            <line x1={x(hover.i)} x2={x(hover.i)} y1={0} y2={H} stroke="var(--border2)" strokeWidth={1} />
            <circle cx={x(hover.i)} cy={y(days[hover.i].value)} r={4} fill="var(--accent2)" stroke="var(--bg2)" strokeWidth={2} />
          </>
        )}
      </svg>
      {hoveredDay && (
        <div style={{
          position: 'fixed', left: hover.clientX + 14, top: hover.clientY - 60, pointerEvents: 'none',
          background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 8, padding: '9px 11px',
          fontSize: 11, lineHeight: 1.6, boxShadow: '0 8px 24px #00000060', zIndex: 5, minWidth: 150,
        }}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
            {fmtDateFull(hoveredDay.date)}{!hoveredDay.actual && ' · forecast'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
            <span>Revenue</span><span style={{ fontFamily: 'var(--mono)', fontWeight: 500 }}>{fmtMoney(hoveredDay.value, sym)}</span>
          </div>
          {!hoveredDay.actual && hoveredDay.low !== undefined && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
              <span>Range</span><span style={{ fontFamily: 'var(--mono)', fontWeight: 500 }}>{fmtMoney(hoveredDay.low, sym)} – {fmtMoney(hoveredDay.high, sym)}</span>
            </div>
          )}
          {hoveredPyPct !== undefined && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
              <span>{granularity === 'monthly' ? 'Month' : granularity === 'weekly' ? 'Week' : 'Day'} vs PY</span>
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, color: hoveredPyPct === null ? 'var(--muted)' : (parseFloat(hoveredPyPct) >= 0 ? 'var(--green)' : 'var(--red)') }}>
                {hoveredPyPct === null ? 'No PY data' : `${parseFloat(hoveredPyPct) >= 0 ? '+' : ''}${parseFloat(hoveredPyPct).toFixed(1)}%`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Stage distribution — small ordinal bar chart ─────────────────────────────────────
function StageChart({ skus }) {
  const counts = STAGES.map(s => ({ ...s, count: skus.filter(sk => sk.stage === s.id).length }));
  const unclassified = skus.filter(sk => !sk.stage).length;
  const W = 480, H = 130, ML = 4, MR = 4, XAXISH = 20;
  const all = unclassified ? [...counts, { id: null, label: 'Unclassified', hex: 'var(--muted)', count: unclassified }] : counts;
  const maxCount = Math.max(...all.map(c => c.count), 1) * 1.2;
  const plotW = W - ML - MR;
  const slot = plotW / all.length;
  const y = (v) => H - (v / maxCount) * H;
  const barW = Math.min(40, slot - 10);

  return (
    <svg viewBox={`0 0 ${W} ${H + XAXISH}`} width="100%" height={H + XAXISH} style={{ display: 'block', maxWidth: 480, overflow: 'visible' }}>
      <line x1={ML} x2={W - MR} y1={H} y2={H} stroke="var(--border2)" strokeWidth={1} />
      {all.map((s, i) => {
        const cx = ML + slot * i + slot / 2;
        const top = y(s.count);
        const r = s.count > 0 ? 4 : 0;
        const path = `M${cx - barW / 2},${H} L${cx - barW / 2},${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} L${cx + barW / 2 - r},${top} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} L${cx + barW / 2},${H} Z`;
        return (
          <g key={s.id || 'none'}>
            <path d={path} fill={s.hex} />
            <text x={cx} y={top - 8} fontFamily="var(--mono)" fontSize={11} fontWeight={500} fill="var(--text)" textAnchor="middle">{s.count}</text>
            <text x={cx} y={H + 15} fontFamily="var(--mono)" fontSize={10} fill="var(--muted)" textAnchor="middle">{s.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

const HISTORY_WINDOWS = [
  { id: 30, label: '30d' },
  { id: 60, label: '60d' },
  { id: 90, label: '90d' },
  { id: 180, label: '6mo' },
];
const GRANULARITIES = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
];

export default function SalesForecast() {
  const [historyWindow, setHistoryWindow] = useState(60);
  const [granularity, setGranularity] = useState('daily');
  const [selectedSkus, setSelectedSkus] = useState(() => new Set());
  const [tip, setTip] = useState(null);
  const [savingSku, setSavingSku] = useState(null);

  const { data, loading, error, refetch } = useApi('/api/sales-forecast', { history_days: historyWindow });
  const sym = data?.currency_symbol || '£';
  const history = data?.history || [];
  const forecast = data?.forecast || [];
  const skus = data?.skus || [];
  const skuSeries = data?.sku_series || [];
  const milestones = data?.milestones || [];
  const pyHistory = data?.py_history || [];
  const hasForecast = !!data?.has_forecast;

  const pyByDate = useMemo(() => new Map(pyHistory.map(d => [d.date.slice(0, 10), parseFloat(d.revenue)])), [pyHistory]);

  const skuSeriesBySku = useMemo(() => {
    const m = new Map();
    for (const r of skuSeries) {
      if (!m.has(r.sku)) m.set(r.sku, []);
      m.get(r.sku).push(r);
    }
    return m;
  }, [skuSeries]);

  const fullDays = useMemo(() => buildDays(history, forecast), [history, forecast]);

  const selectedDays = useMemo(() => {
    if (selectedSkus.size === 0) return fullDays;
    const byDate = new Map();
    for (const sku of selectedSkus) {
      for (const r of (skuSeriesBySku.get(sku) || [])) {
        const cur = byDate.get(r.date) || { revenue: 0, low: 0, high: 0 };
        cur.revenue += parseFloat(r.revenue);
        cur.low += r.low !== null ? parseFloat(r.low) : parseFloat(r.revenue);
        cur.high += r.high !== null ? parseFloat(r.high) : parseFloat(r.revenue);
        byDate.set(r.date, cur);
      }
    }
    return fullDays.map(d => {
      const v = byDate.get(d.date);
      if (!v) return { date: d.date, value: 0, actual: d.actual, low: d.actual ? undefined : 0, high: d.actual ? undefined : 0 };
      return { date: d.date, value: v.revenue, actual: d.actual, low: d.actual ? undefined : v.low, high: d.actual ? undefined : v.high };
    });
  }, [fullDays, selectedSkus, skuSeriesBySku]);

  const bucketedDays = useMemo(() => bucketDays(selectedDays, granularity), [selectedDays, granularity]);

  const last30Total = useMemo(() => history.slice(-30).reduce((s, d) => s + parseFloat(d.revenue || 0), 0), [history]);
  const next30Total = useMemo(() => forecast.slice(0, 30).reduce((s, d) => s + parseFloat(d.revenue || 0), 0), [forecast]);
  const deltaPct = last30Total > 0 ? ((next30Total - last30Total) / last30Total) * 100 : null;
  const flaggedCount = useMemo(() => skus.filter(s => s.excluded_count > 0 || (s.stage === 'plateau' && !s.stage_override)).length, [skus]);
  const sortedSkus = useMemo(() => [...skus].sort((a, b) => parseFloat(b.next_30d_revenue || 0) - parseFloat(a.next_30d_revenue || 0)), [skus]);

  function toggleSkuSelection(sku, additive) {
    setSelectedSkus(prev => {
      const next = new Set(prev);
      if (additive) {
        if (next.has(sku)) next.delete(sku); else next.add(sku);
        return next;
      }
      const onlyThis = prev.size === 1 && prev.has(sku);
      return onlyThis ? new Set() : new Set([sku]);
    });
  }

  async function updateConfig(sku, body) {
    setSavingSku(sku);
    try {
      const res = await fetch(`/api/sales-forecast/config/${encodeURIComponent(sku)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed'); }
      refetch();
    } catch (e) {
      alert(e.message);
    } finally {
      setSavingSku(null);
    }
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Sales Forecast</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 780 }}>
          Per-SKU revenue forecast, segmented by growth stage, with seasonality (blended
          against prior-year where available) and outlier exclusion. Click a SKU below to
          filter the chart to it — ctrl/cmd-click to compare several. Set a manual stage
          override or flag a SKU end-of-life; both are respected by the next nightly run.
        </p>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
      ) : error ? (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--red)15', border: '1px solid var(--red)', fontSize: 13, color: 'var(--red)' }}>
          Failed to load: {error}
        </div>
      ) : (
        <>
          {!hasForecast && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--amber)15', border: '1px solid var(--amber)', fontSize: 13, color: 'var(--amber)' }}>
              No forecast has been generated yet — the nightly forecasting job hasn't run. Showing historical actuals only.
            </div>
          )}

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={statCardStyle}>
              <div style={cardLabel}>Last 30 days (actual)</div>
              <div style={cardValue}>{fmtMoney(last30Total, sym)}</div>
            </div>
            <div style={statCardStyle}>
              <div style={cardLabel}>Next 30 days (forecast)</div>
              <div style={{ ...cardValue, color: hasForecast ? 'var(--accent2)' : 'var(--muted)' }}>
                {hasForecast ? fmtMoney(next30Total, sym) : '—'}
              </div>
              {deltaPct !== null && hasForecast && (
                <div style={{ fontSize: 11, marginTop: 4, color: deltaPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}% vs trailing 30d
                </div>
              )}
            </div>
            <div style={statCardStyle}>
              <div style={cardLabel}>SKUs flagged</div>
              <div style={cardValue}>{flaggedCount}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Plateauing or with excluded outlier periods</div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>
                  Revenue — actual → forecast
                  {selectedSkus.size > 0 && (
                    <span style={{ fontWeight: 400, color: 'var(--accent2)' }}> · {selectedSkus.size} SKU{selectedSkus.size > 1 ? 's' : ''} selected</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Solid = actual. Dashed = projected. Shaded band = forecast uncertainty.
                  {selectedSkus.size > 0 && (
                    <button onClick={() => setSelectedSkus(new Set())} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--accent2)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0, fontFamily: 'var(--font)' }}>
                      Clear selection
                    </button>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  {HISTORY_WINDOWS.map(w => (
                    <button key={w.id} style={toggleBtn(historyWindow === w.id)} onClick={() => setHistoryWindow(w.id)}>{w.label}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {GRANULARITIES.map(g => (
                    <button key={g.id} style={toggleBtn(granularity === g.id)} onClick={() => setGranularity(g.id)}>{g.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <MainChart days={bucketedDays} granularity={granularity} sym={sym} milestones={milestones} pyByDate={pyByDate} />
            <div style={{ display: 'flex', gap: 16, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                <span style={{ width: 14, height: 2, background: 'var(--accent)' }} />Actual
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                <span style={{ width: 14, height: 0, borderTop: '2px dashed var(--accent)' }} />Forecast
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent)', opacity: 0.15, border: '1px solid var(--accent2)' }} />Uncertainty range
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Hover a point for its revenue and how it compares to the same day/week/month last year.</div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>SKUs by growth stage</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
              Lifecycle stage drives which curve shape the model fits. Override below if the auto-classification looks wrong.
            </div>
            <StageChart skus={skus} />
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Per-SKU forecast</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
              Sorted by next-30d forecast. Click a row to filter the chart above to it — ctrl/cmd-click to add more.
            </div>
            {!sortedSkus.length ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No SKUs with recent sales.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['SKU', 'Stage', 'End of life', 'Last 30d', 'Next 30d', 'Δ'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: i >= 3 ? 'right' : 'left', fontSize: 10, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSkus.map(s => {
                      const last30 = parseFloat(s.last_30d_revenue || 0);
                      const next30 = parseFloat(s.next_30d_revenue || 0);
                      const delta = last30 > 0 ? ((next30 - last30) / last30) * 100 : null;
                      const meta = stageMeta(s.stage);
                      const saving = savingSku === s.sku;
                      const isSelected = selectedSkus.has(s.sku);
                      return (
                        <tr
                          key={s.sku}
                          onClick={e => toggleSkuSelection(s.sku, e.ctrlKey || e.metaKey)}
                          style={{
                            borderBottom: '1px solid var(--border)', opacity: saving ? 0.5 : 1, cursor: 'pointer',
                            background: isSelected ? 'var(--accent)12' : 'transparent',
                            boxShadow: isSelected ? 'inset 2px 0 0 var(--accent)' : 'none',
                          }}
                        >
                          <td style={{ padding: '9px 10px', fontSize: 12 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <ProductImage
                                imageUrl={s.image_url} asin={s.asin} sku={s.sku}
                                onEnter={e => {
                                  e.stopPropagation();
                                  const r = e.currentTarget.getBoundingClientRect();
                                  setTip({ text: s.product_title || s.sku, top: r.bottom + 6, left: r.left });
                                }}
                                onLeave={() => setTip(null)}
                              />
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.sku || '—'}</div>
                                <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>{s.asin || '—'}</div>
                                {s.excluded_count > 0 && (
                                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                                    ⚑ {s.excluded_count} period{s.excluded_count > 1 ? 's' : ''} excluded{s.last_exclusion_reason ? ` — ${s.last_exclusion_reason}` : ''}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: '9px 10px' }} onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: meta.hex }} />
                              <select
                                value={s.stage_override || ''}
                                disabled={saving}
                                onChange={e => updateConfig(s.sku, { stage_override: e.target.value || null })}
                                style={{ background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font)', padding: '4px 6px' }}
                              >
                                <option value="">Auto{s.auto_stage ? ` (${stageMeta(s.auto_stage).label})` : ''}</option>
                                {STAGES.map(st => <option key={st.id} value={st.id}>{st.label}</option>)}
                              </select>
                            </div>
                          </td>
                          <td style={{ padding: '9px 10px' }} onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={!!s.is_end_of_life}
                              disabled={saving}
                              onChange={e => updateConfig(s.sku, { is_end_of_life: e.target.checked })}
                              style={{ width: 16, height: 16, cursor: 'pointer' }}
                            />
                          </td>
                          <td style={{ padding: '9px 10px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtMoney(last30, sym)}</td>
                          <td style={{ padding: '9px 10px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', color: hasForecast ? 'var(--text)' : 'var(--muted)' }}>
                            {hasForecast ? fmtMoney(next30, sym) : '—'}
                          </td>
                          <td style={{ padding: '9px 10px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', color: delta === null ? 'var(--muted)' : (delta >= 0 ? 'var(--green)' : 'var(--red)') }}>
                            {hasForecast && delta !== null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      <HoverTooltip tip={tip} />
    </div>
  );
}
