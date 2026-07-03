import React from 'react';
const fmt = (val, type, symbol = '£') => {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  if (type === 'currency') return symbol + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (type === 'percent') return n.toFixed(1) + '%';
  if (type === 'number') return n.toLocaleString('en-GB');
  return val;
};
export default function KpiCard({ label, value, type = 'currency', sub, trend, color, symbol = '£' }) {
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
      minWidth: 0, // lets the card shrink below its content's intrinsic width inside a CSS
                   // grid (e.g. `repeat(auto-fit, minmax(180px, 1fr))`) — without this, expanding
                   // the sidebar shrinks the available column width but the card itself refuses
                   // to shrink, so the value/label overflow and get hard-clipped by overflow:hidden.
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
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--muted)', textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
      <span
        title={String(fmt(value, type, symbol))}
        style={{ fontSize: 24, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: '-0.02em', color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}
      >
        {fmt(value, type, symbol)}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {trend !== undefined && (
          <span style={{ fontSize: 12, fontWeight: 600, color: trendColor, fontFamily: 'var(--mono)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {trendPositive ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}%
          </span>
        )}
        {sub && <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{sub}</span>}
      </div>
    </div>
  );
}
