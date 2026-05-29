import React, { useState } from 'react';

const PRESETS = [
  { label: '7D',  days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: 'YTD', days: null, ytd: true },
  { label: 'All', days: null, all: true },
];

function getRange(preset) {
  const to = new Date().toISOString().split('T')[0];
  if (preset.all) return { from: '2020-01-01', to };
  if (preset.ytd) {
    const from = new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    return { from, to };
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

export default function DateRangePicker({ value, onChange }) {
  const [active, setActive] = useState('30D');

  const handlePreset = (preset) => {
    setActive(preset.label);
    onChange(getRange(preset));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {PRESETS.map(p => (
        <button key={p.label} style={btn(active === p.label)} onClick={() => handlePreset(p)}>
          {p.label}
        </button>
      ))}
      <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
      <input
        type="date"
        value={value.from}
        onChange={e => { setActive('custom'); onChange({ ...value, from: e.target.value }); }}
        style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', cursor: 'pointer' }}
      />
      <span style={{ color: 'var(--muted)', fontSize: 12 }}>→</span>
      <input
        type="date"
        value={value.to}
        onChange={e => { setActive('custom'); onChange({ ...value, to: e.target.value }); }}
        style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', cursor: 'pointer' }}
      />
    </div>
  );
}

export { getRange };
