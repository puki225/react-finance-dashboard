import React, { useState, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';

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

// ─── Waterfall ─────────────────────────────────────────────────────────────
// Five columns: scenario 1 baseline, the three effects as floating bars, then
// scenario 2. Bars are positioned against a shared scale that always includes 0 so
// a negative effect reads as genuinely below the axis rather than just shorter.
function Waterfall({ bridge, s1, s2, sym, isMobile }) {
  const H = isMobile ? 220 : 300;
  const c1 = s1.value;
  const c2 = c1 + bridge.price;
  const c3 = c2 + bridge.volume;
  const c4 = c3 + bridge.mix; // == s2.value, bar the balancing rounding

  const bars = [
    { label: 'Scenario 1', sub: `${s1.from} → ${s1.to}`, start: 0, end: c1, kind: 'total' },
    { label: 'Price', sub: 'Δprice × vol₂, per member', start: c1, end: c2, kind: 'effect', value: bridge.price },
    { label: 'Volume', sub: 'Δvol × blended price₁', start: c2, end: c3, kind: 'effect', value: bridge.volume },
    { label: 'Mix', sub: 'balancing figure', start: c3, end: c4, kind: 'effect', value: bridge.mix },
    { label: 'Scenario 2', sub: `${s2.from} → ${s2.to}`, start: 0, end: s2.value, kind: 'total' },
  ];

  const pts = [0, c1, c2, c3, c4, s2.value];
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
        const displayValue = b.kind === 'total' ? fmtMoney(b.end, sym) : fmtSigned(b.value, sym);
        // Labels sit above the bar, or below it when the bar reaches the very top.
        const labelAbove = top > 22;
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ position: 'relative', height: H }}>
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
              }}>{displayValue}</div>
              {/* Zero axis, only drawn when the scale actually crosses it */}
              {yMin < 0 && yMax > 0 && (
                <div style={{ position: 'absolute', top: y(0), left: 0, right: 0, borderTop: '1px dashed var(--border)' }} />
              )}
            </div>
            <div style={{ marginTop: 10, textAlign: 'center', minWidth: 0 }}>
              <div style={{ fontSize: isMobile ? 11 : 13, fontWeight: 600, color: 'var(--text)' }}>{b.label}</div>
              <div style={{ fontSize: isMobile ? 8 : 10, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.sub}</div>
            </div>
          </div>
        );
      })}
    </div>
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
  const [level, setLevel] = useState(() => localStorage.getItem('gb_pvm_level') || 'asin');
  const [presetId, setPresetId] = useState('lq');
  const [periods, setPeriods] = useState(() => PRESETS[0].build());
  const [filters, setFilters] = useState({ country: '', brand: '', asin: '' });

  const applyPreset = (p) => { setPresetId(p.id); setPeriods(p.build()); };
  const setScenario = (which, field, value) => {
    setPresetId('custom');
    setPeriods(prev => ({ ...prev, [which]: { ...prev[which], [field]: value } }));
  };
  const chooseMetric = (m) => { setMetric(m); localStorage.setItem('gb_pvm_metric', m); };
  const chooseLevel = (l) => { setLevel(l); localStorage.setItem('gb_pvm_level', l); };

  // Empty filter values must be omitted entirely — URLSearchParams would otherwise
  // serialise them as literal "undefined"/"" and the server would filter on that.
  const params = useMemo(() => {
    const p = {
      s1_from: periods.s1.from, s1_to: periods.s1.to,
      s2_from: periods.s2.from, s2_to: periods.s2.to,
      metric, level,
    };
    if (filters.country) p.country = filters.country;
    if (filters.brand) p.brand = filters.brand;
    if (filters.asin) p.asin = filters.asin;
    return p;
  }, [periods, metric, level, filters]);

  const { data, loading, error } = useApi('/api/pvm', params);
  const sym = data?.currency_symbol || '£';
  const metricLabel = metric === 'margin' ? 'Gross Profit' : 'Net Revenue';
  const unitLabel = metric === 'margin' ? 'margin/unit' : 'price/unit';

  const members = data?.members || [];
  const opts = data?.options || { countries: [], brands: [], asins: [] };

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
      <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 14 }}>
        <button style={subTab(metric === 'revenue')} onClick={() => chooseMetric('revenue')}>Revenue</button>
        <button style={subTab(metric === 'margin')} onClick={() => chooseMetric('margin')}>Margin</button>
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
          <span style={groupLabel}>Filter</span>
          <div style={{ display: 'flex', gap: 6, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4, flexWrap: 'wrap' }}>
            <select style={selectStyle} value={filters.country} onChange={e => setFilters(f => ({ ...f, country: e.target.value }))}>
              <option value="">All countries</option>
              {opts.countries.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select style={selectStyle} value={filters.brand} onChange={e => setFilters(f => ({ ...f, brand: e.target.value }))}>
              <option value="">All brands</option>
              {opts.brands.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <select style={selectStyle} value={filters.asin} onChange={e => setFilters(f => ({ ...f, asin: e.target.value }))}>
              <option value="">All ASINs</option>
              {opts.asins.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            {(filters.country || filters.brand || filters.asin) && (
              <button style={chip(false)} onClick={() => setFilters({ country: '', brand: '', asin: '' })}>Clear</button>
            )}
          </div>
        </div>
      </div>

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
            <StatCard
              label={`S1 ${metricLabel}`} value={fmtMoney(data.scenario1.value, sym)}
              sub={`${fmtNum(data.scenario1.units)} units · ${fmtMoney2(data.scenario1.avg_price, sym)} ${unitLabel}`}
            />
            <StatCard
              label={`S2 ${metricLabel}`} value={fmtMoney(data.scenario2.value, sym)}
              sub={`${fmtNum(data.scenario2.units)} units · ${fmtMoney2(data.scenario2.avg_price, sym)} ${unitLabel}`}
            />
            <StatCard
              label="Total Δ" value={fmtSigned(data.bridge.total_delta, sym)}
              accent={data.bridge.total_delta >= 0 ? 'var(--green)' : 'var(--red)'}
              sub={data.scenario1.value !== 0
                ? `${(data.bridge.total_delta / Math.abs(data.scenario1.value) * 100).toFixed(1)}% vs base`
                : '—'}
            />
          </div>

          {/* Bridge */}
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: isMobile ? '18px 12px' : '24px 28px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 20 }}>
              {metricLabel} Bridge
              <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                — mix is the residual after price and volume
              </span>
            </div>
            <Waterfall bridge={data.bridge} s1={data.scenario1} s2={data.scenario2} sym={sym} isMobile={isMobile} />
          </div>

          {/* Breakdown table */}
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
              By {LEVELS.find(l => l.id === level)?.label}
              <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                {members.length} {members.length === 1 ? 'row' : 'rows'}, largest movement first
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 860, borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--bg3)' }}>
                    {['', 'S1 Units', `S1 ${unitLabel}`, 'S1 Value', 'S2 Units', `S2 ${unitLabel}`, 'S2 Value', 'Price', 'Volume', 'Mix', 'Δ Total'].map((h, i) => (
                      <th key={i} style={{
                        padding: '10px 10px', textAlign: i === 0 ? 'left' : 'right',
                        fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                        color: 'var(--muted)', whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {members.length === 0 && (
                    <tr><td colSpan={11} style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--muted)' }}>No data for this selection</td></tr>
                  )}
                  {members.map(m => {
                    const cell = (v, color) => (
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: color || 'var(--text)', whiteSpace: 'nowrap' }}>{v}</td>
                    );
                    const effColor = (v) => v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--muted)';
                    return (
                      <tr key={m.key} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '9px 10px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.label}>{m.label}</td>
                        {cell(fmtNum(m.s1_units))}
                        {cell(fmtMoney2(m.s1_price, sym), 'var(--muted)')}
                        {cell(fmtMoney(m.s1_value, sym))}
                        {cell(fmtNum(m.s2_units))}
                        {cell(fmtMoney2(m.s2_price, sym), 'var(--muted)')}
                        {cell(fmtMoney(m.s2_value, sym))}
                        {cell(fmtSigned(m.price, sym), effColor(m.price))}
                        {cell(fmtSigned(m.volume, sym), effColor(m.volume))}
                        {cell(fmtSigned(m.mix, sym), effColor(m.mix))}
                        {cell(fmtSigned(m.delta, sym), effColor(m.delta))}
                      </tr>
                    );
                  })}
                </tbody>
                {members.length > 0 && (
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg3)', fontWeight: 700 }}>
                      <td style={{ padding: '11px 10px' }}>Total</td>
                      <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(data.scenario1.units)}</td>
                      <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtMoney2(data.scenario1.avg_price, sym)}</td>
                      <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtMoney(data.scenario1.value, sym)}</td>
                      <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(data.scenario2.units)}</td>
                      <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtMoney2(data.scenario2.avg_price, sym)}</td>
                      <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtMoney(data.scenario2.value, sym)}</td>
                      <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSigned(data.bridge.price, sym)}</td>
                      <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSigned(data.bridge.volume, sym)}</td>
                      <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtSigned(data.bridge.mix, sym)}</td>
                      <td style={{ padding: '11px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtSigned(data.bridge.total_delta, sym)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
              Price is each row's own {unitLabel} change on its scenario-2 units. Volume is the unit change
              priced at the blended scenario-1 {unitLabel} ({fmtMoney2(data.scenario1.avg_price, sym)}), so a row's
              mix is its unit change × how far its own {unitLabel} sits from that blend. Rows sum exactly to the Total.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
