import React, { useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';

// A small, fixed set of headline KPIs for a glanceable "is anything wrong" view - see
// server/index.js's /api/command-center for why these 7 and not more (NOC/exec-dashboard
// research converges on 5-7 headline metrics; a wall of tiles defeats the point of a command
// center). Grouped the way a cold reader would look for them, not alphabetically.
const GROUP_ORDER = ['Sales', 'Profitability', 'Advertising', 'Quality', 'Cash'];

const SEVERITY_DOT = { ok: 'var(--border)', watch: '#fbbf24', alert: '#f87171' };
const SEVERITY_LABEL = { ok: null, watch: 'WATCH', alert: 'ALERT' };

const fmtValue = (unit, sym, v) => {
  if (v === null || v === undefined) return '—';
  // cash_runway's headline number is the projected minimum balance - a currency figure,
  // even though the tile's `unit` names its special days-until-breach rendering below it.
  if (unit === 'currency' || unit === 'days_until_breach') return `${sym}${Math.round(v).toLocaleString('en-GB')}`;
  if (unit === 'percent') return `${v.toFixed(1)}%`;
  if (unit === 'number') return Math.round(v).toLocaleString('en-GB');
  return v;
};
const fmtDelta = (v) => (v === null || v === undefined) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
// Color encodes GOOD/BAD, not up/down - a falling TACOS is green, a falling margin is red.
// Small moves (<0.5%) read as noise, not signal, and stay neutral.
const deltaColor = (v, direction) => {
  if (v === null || v === undefined || !direction || Math.abs(v) < 0.5) return 'var(--muted)';
  const good = direction === 'higher_better' ? v > 0 : v < 0;
  return good ? '#34d399' : '#f87171';
};

function Sparkline({ points, gradId }) {
  const valid = (points || []).filter(p => p.value !== null && p.value !== undefined);
  if (valid.length < 2) {
    return <div style={{ height: 36, display: 'flex', alignItems: 'center', fontSize: 10, color: 'var(--muted)', fontStyle: 'italic' }}>not enough history yet</div>;
  }
  const vals = valid.map(p => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const w = 148, h = 36, pad = 3;
  const x = (i) => pad + (i / (valid.length - 1)) * (w - pad * 2);
  const y = (v) => max === min ? h / 2 : h - pad - ((v - min) / (max - min)) * (h - pad * 2);
  const line = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(valid.length - 1).toFixed(1)},${h} L${x(0).toFixed(1)},${h} Z`;
  const improving = vals[vals.length - 1] >= vals[0];
  const color = improving ? '#34d399' : '#f87171';
  const lastX = x(valid.length - 1), lastY = y(vals[vals.length - 1]);
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r="2.4" fill={color} />
    </svg>
  );
}

function Tile({ tile, sym }) {
  const dotColor = SEVERITY_DOT[tile.severity] || 'var(--border)';
  const sevLabel = SEVERITY_LABEL[tile.severity];
  return (
    <div style={{
      background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 12,
      padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10,
      borderLeft: `3px solid ${dotColor}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, letterSpacing: '0.02em' }}>{tile.label}</div>
        {sevLabel && (
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: dotColor, border: `1px solid ${dotColor}`, borderRadius: 10, padding: '1px 6px' }}>{sevLabel}</span>
        )}
      </div>

      <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--mono)', color: 'var(--text)', letterSpacing: '-0.01em' }}>
        {fmtValue(tile.unit, sym, tile.value)}
      </div>

      {tile.unit === 'days_until_breach' ? (
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
          {tile.days_until_breach === null
            ? 'No threshold breach projected ahead.'
            : <>Projected to dip below the {sym}{Math.round(tile.threshold).toLocaleString('en-GB')} threshold in <strong style={{ color: tile.severity === 'alert' ? '#f87171' : tile.severity === 'watch' ? '#fbbf24' : 'var(--text)' }}>{tile.days_until_breach} day{tile.days_until_breach === 1 ? '' : 's'}</strong> ({tile.breach_date}).</>
          }
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
            <div>
              <span style={{ color: 'var(--muted)' }}>vs prior 14d </span>
              <span style={{ fontWeight: 700, color: deltaColor(tile.vs_prior_14d_pct, tile.direction) }}>{fmtDelta(tile.vs_prior_14d_pct)}</span>
            </div>
            <div>
              <span style={{ color: 'var(--muted)' }}>vs 90d avg </span>
              <span style={{ fontWeight: 700, color: deltaColor(tile.vs_quarter_avg_pct, tile.direction) }}>{fmtDelta(tile.vs_quarter_avg_pct)}</span>
            </div>
          </div>
          <Sparkline points={tile.sparkline} gradId={`spark-${tile.id}`} />
        </>
      )}
    </div>
  );
}

export default function TestBoard() {
  const isMobile = useIsMobile();
  const { data, loading, error } = useApi('/api/command-center');

  const grouped = useMemo(() => {
    const m = {};
    for (const t of data?.tiles || []) { (m[t.group] ||= []).push(t); }
    return m;
  }, [data]);

  const attention = (data?.tiles || []).filter(t => t.severity !== 'ok');

  return (
    <div style={{ padding: isMobile ? '16px' : '28px 32px', display: 'flex', flexDirection: 'column', gap: isMobile ? 18 : 24 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Test Board</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
          Headline KPIs, trailing 14 days — compared against the 14 days before, and the trailing 90-day average.
          A working first cut: more goes here as it proves useful.
        </p>
      </div>

      {loading && <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}
      {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}

      {!loading && !error && (
        <>
          {attention.length > 0 ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              background: '#f8717112', border: '1px solid #f8717140', borderRadius: 10, padding: '10px 14px',
            }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#f87171' }}>Needs a look:</span>
              {attention.map(t => (
                <span key={t.id} style={{ fontSize: 11, color: 'var(--text)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '3px 9px' }}>
                  {t.label}
                </span>
              ))}
            </div>
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: '#34d39912', border: '1px solid #34d39940', borderRadius: 10, padding: '10px 14px',
            }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>Everything's within normal range.</span>
            </div>
          )}

          {GROUP_ORDER.filter(g => grouped[g]?.length).map(group => (
            <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent2)' }}>{group}</div>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
                {grouped[group].map(t => <Tile key={t.id} tile={t} sym={data.currency_symbol} />)}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
