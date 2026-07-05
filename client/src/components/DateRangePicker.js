import React, { useState } from 'react';

// Grouped in two logical tiers, separated visually by a divider in the render below:
// rolling windows anchored to "now" (Today .. 90D), then calendar-aligned periods in
// ascending size (This Month .. All).
const ROLLING_PRESETS = [
  { label: 'Today',     days: 0,    dtd: true },
  { label: 'Yesterday', days: null, yesterday: true },
  { label: '7D',  days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
];
const CALENDAR_PRESETS = [
  { label: 'This Month',   days: null, thisMonth: true },
  { label: 'This Quarter', days: null, thisQuarter: true },
  { label: 'Last Quarter', days: null, lastQuarter: true },
  { label: 'YTD',          days: null, ytd: true },
  { label: 'Last Year',    days: null, lastYear: true },
  { label: 'All',          days: null, all: true },
];
const PRESETS = [...ROLLING_PRESETS, ...CALENDAR_PRESETS];

const pad2 = (n) => String(n).padStart(2, '0');
// Last day of a UTC month: day 0 of the following month rolls back to the last day of "month".
function lastDayOfMonth(year, month0) {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}
function quarterStart(year, q0) { return `${year}-${pad2(q0 * 3 + 1)}-01`; }
function quarterEnd(year, q0) {
  const month0 = q0 * 3 + 2;
  return `${year}-${pad2(month0 + 1)}-${pad2(lastDayOfMonth(year, month0))}`;
}

function getRange(preset) {
  const to = new Date().toISOString().split('T')[0];
  if (preset.all) return { from: '2020-01-01', to };
  // Built directly from UTC getters throughout (rather than constructing local-timezone Date
  // objects and round-tripping through toISOString) - that round-trip shifts month/quarter/year
  // boundaries back a day for any browser whose local timezone sits ahead of UTC, which is
  // exactly the bug the existing YTD case below was already written to avoid.
  if (preset.ytd) {
    const from = `${new Date().getUTCFullYear()}-01-01`;
    return { from, to };
  }
  if (preset.lastYear) {
    const y = new Date().getUTCFullYear() - 1;
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  if (preset.thisMonth) {
    const now = new Date();
    const from = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-01`;
    return { from, to };
  }
  if (preset.thisQuarter) {
    const now = new Date();
    const q0 = Math.floor(now.getUTCMonth() / 3);
    return { from: quarterStart(now.getUTCFullYear(), q0), to };
  }
  if (preset.lastQuarter) {
    const now = new Date();
    const q0 = Math.floor(now.getUTCMonth() / 3);
    const year = q0 === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    const prevQ0 = q0 === 0 ? 3 : q0 - 1;
    return { from: quarterStart(year, prevQ0), to: quarterEnd(year, prevQ0) };
  }
  if (preset.dtd) return { from: to, to };
  if (preset.yesterday) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    return { from: yesterday, to: yesterday };
  }
  const from = new Date(Date.now() - preset.days * 86400000).toISOString().split('T')[0];
  return { from, to };
}

const btn = (active) => ({
  padding: '6px 14px',
  borderRadius: 6,
  border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
  background: active ? 'var(--accent)' : 'transparent',
  color: active ? '#fff' : 'var(--muted)',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'var(--font)',
  cursor: 'pointer',
  transition: 'all 0.15s',
  letterSpacing: '0.04em',
});

// Reverse-match the incoming value against the presets so the highlighted button reflects
// the range actually in effect on mount — rather than always defaulting to '30D' regardless
// of what the parent page passed in (e.g. PnL defaults to a 90-day range, and a saved custom
// range should show neither button highlighted).
function matchPreset(value) {
  for (const p of PRESETS) {
    const r = getRange(p);
    if (r.from === value.from && r.to === value.to) return p.label;
  }
  return 'custom';
}

const groupLabel = {
  fontSize: 9, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em',
  textTransform: 'uppercase', paddingLeft: 2,
};

// Each set of presets (plus the custom range) gets its own labeled, bordered box instead of
// a flat row split by thin divider lines — with more presets added over time, the flat row
// became hard to scan at a glance. Rolling and Calendar get distinct backgrounds (bg2 vs bg3,
// both already part of the app's palette) purely for visual contrast between the two sets.
function PresetGroup({ title, presets, active, onSelect, bg }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={groupLabel}>{title}</span>
      <div style={{ display: 'flex', gap: 4, background: bg, border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
        {presets.map(p => (
          <button key={p.label} style={btn(active === p.label)} onClick={() => onSelect(p)}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function DateRangePicker({ value, onChange }) {
  const [active, setActive] = useState(() => matchPreset(value));

  const handlePreset = (preset) => {
    setActive(preset.label);
    onChange(getRange(preset));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', rowGap: 10 }}>
      <PresetGroup title="Rolling" presets={ROLLING_PRESETS} active={active} onSelect={handlePreset} bg="var(--bg2)" />
      <PresetGroup title="Calendar" presets={CALENDAR_PRESETS} active={active} onSelect={handlePreset} bg="var(--bg3)" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={groupLabel}>Custom Range</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
          <input
            type="date"
            value={value.from}
            onChange={e => { setActive('custom'); onChange({ ...value, from: e.target.value }); }}
            style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', cursor: 'pointer' }}
          />
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>→</span>
          <input
            type="date"
            value={value.to}
            onChange={e => { setActive('custom'); onChange({ ...value, to: e.target.value }); }}
            style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', cursor: 'pointer' }}
          />
        </div>
      </div>
    </div>
  );
}

export { getRange };
