import React from 'react';

const fmt = (val, type) => {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  if (type === 'currency') return '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (type === 'percent') return n.toFixed(1) + '%';
  if (type === 'number') return n.toLocaleString('en-GB');
  return val;
};

export default function KpiCard({ label, value, type = 'currency', sub, trend, color }) {
  const trendPositive = trend > 0;
  const trendColor = trendPositive ? 'var(--green)' : 'var(--red)';

  return (
    <div style={{
      background: 'var(--bg2)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: '20px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      position: 'relative',
      overflow: 'hidden',
      transition: 'border-color 0.2s',
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
    >
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: color || 'var(--accent)',
        opacity: 0.6
      }} />
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--muted)', textTransform: 'uppercase' }}>
        {label}
      </span>
      <span style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: '-0.02em', color: 'var(--text)' }}>
        {fmt(value, type)}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {trend !== undefined && (
          <span style={{ fontSize: 12, fontWeight: 600, color: trendColor, fontFamily: 'var(--mono)' }}>
            {trendPositive ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}%
          </span>
        )}
        {sub && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</span>}
      </div>
    </div>
  );
}
