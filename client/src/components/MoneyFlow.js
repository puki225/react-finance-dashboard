import React from 'react';
import { useApi } from '../hooks/useApi';

// A single continuous line walking Sales down to Profit for one period, colored by the
// running margin at each step rather than by whether that one step was itself good or bad -
// the point is "is the business still healthy at this point in the walk," which is what makes
// it readable as a command-center signal. Returns sit early (right where /api/pnl already
// nets them off, before COGS) and Storage & OPEX sits last (the same final bridge to Profit
// /api/pnl's own math already uses) - see server/index.js's /api/money-flow for why nothing
// here is re-derived, only re-presented.

const ZONE_COLOR = { healthy: 'var(--green)', watch: 'var(--amber)', loss: 'var(--red)' };
const ZONE_LABEL = { healthy: 'Healthy margin (≥20%)', watch: 'Thin margin', loss: 'Loss-making' };

const fmtCurrency = (sym, v) => {
  const n = Math.round(v);
  const sign = n < 0 ? '−' : '';
  return `${sign}${sym}${Math.abs(n).toLocaleString('en-GB')}`;
};
const fmtSigned = (sym, v) => (v >= 0 ? '+' : '−') + sym + Math.abs(Math.round(v)).toLocaleString('en-GB');

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function FlowChart({ points, grossSales, sym }) {
  const W = 820, H = 260, padX = 52, padTop = 56, padBottom = 56;
  const innerW = W - padX * 2;
  const innerH = H - padTop - padBottom;
  const n = points.length;

  const values = points.map(p => p.value);
  const healthyLine = grossSales * 0.2; // the >=20% "healthy margin" reference band
  const maxV = Math.max(...values, 0, healthyLine);
  const minV = Math.min(...values, 0);
  const span = Math.max(maxV - minV, 1);

  const xOf = (i) => padX + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const yOf = (v) => padTop + innerH - ((v - minV) / span) * innerH;
  const zeroY = yOf(0);
  const healthyY = yOf(healthyLine);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {/* Reference bands: 0 (break-even) and the >=20% healthy-margin line, both recessive and
          unlabeled here - labeling them inline risked colliding with a data point's own label
          wherever the line happened to pass near one (the original version of this chart did
          exactly that). They're named once in the legend above instead. */}
      <line x1={padX} y1={zeroY} x2={W - padX} y2={zeroY} stroke="var(--border2)" strokeWidth="1" strokeDasharray="3,4" />
      <line x1={padX} y1={healthyY} x2={W - padX} y2={healthyY} stroke="var(--green)" strokeOpacity="0.25" strokeWidth="1" strokeDasharray="2,4" />

      {/* The flow itself - one segment per step, colored by the zone it arrives in */}
      {points.slice(1).map((p, idx) => {
        const prev = points[idx];
        return (
          <line
            key={p.id}
            x1={xOf(idx)} y1={yOf(prev.value)} x2={xOf(idx + 1)} y2={yOf(p.value)}
            stroke={ZONE_COLOR[p.zone]} strokeWidth="2.5" strokeLinecap="round"
          />
        );
      })}

      {points.map((p, i) => {
        const x = xOf(i), y = yOf(p.value);
        const isEndpoint = p.delta === null;
        return (
          <g key={p.id}>
            <circle cx={x} cy={y} r={isEndpoint ? 6 : 5} fill={ZONE_COLOR[p.zone]} stroke="var(--bg3)" strokeWidth="2">
              <title>{`${p.label}: ${fmtCurrency(sym, p.value)} (${p.margin_pct.toFixed(1)}% of gross sales)`}</title>
            </circle>
            {/* Value + margin%, one line, above the dot */}
            <text x={x} y={y - 12} textAnchor="middle" fontSize="11" fontWeight="700" fontFamily="var(--mono)" fill="var(--text)">
              {fmtCurrency(sym, p.value)}
              <tspan fontSize="9" fontWeight="400" fill="var(--muted)"> ({p.margin_pct.toFixed(0)}%)</tspan>
            </text>
            {/* Stage name + delta below the axis */}
            <text x={x} y={H - 34} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--muted)">
              {p.label}
            </text>
            {p.delta !== null && (
              <text x={x} y={H - 20} textAnchor="middle" fontSize="10" fontFamily="var(--mono)" fill={ZONE_COLOR[p.zone]}>
                {fmtSigned(sym, p.delta)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Legend() {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      {Object.entries(ZONE_LABEL).map(([zone, label]) => (
        <div key={zone} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: ZONE_COLOR[zone], display: 'inline-block' }} />
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>
        </div>
      ))}
      <span style={{ width: 1, height: 12, background: 'var(--border2)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="14" height="8"><line x1="0" y1="4" x2="14" y2="4" stroke="var(--green)" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="2,3" /></svg>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>20% margin line</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="14" height="8"><line x1="0" y1="4" x2="14" y2="4" stroke="var(--border2)" strokeWidth="1.5" strokeDasharray="2,3" /></svg>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>break-even</span>
      </div>
    </div>
  );
}

export default function MoneyFlow({ from, to }) {
  const { data, loading, error } = useApi('/api/money-flow', { from, to });

  if (loading) return <div style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>Loading money flow…</div>;
  if (error) return <div style={{ color: 'var(--red)', fontSize: 13, padding: '20px 0' }}>{error}</div>;
  if (!data || !data.points?.length) return null;

  const sym = data.currency_symbol;
  // Every step after Sales only subtracts (discounts/returns/costs), so the running margin
  // is monotonically non-increasing - once it leaves "healthy" or turns negative it never
  // comes back, which is what makes "first point it happens at" a well-defined, stable fact
  // rather than something that could flip on a later, better-looking step.
  const firstWatch = data.points.find(p => p.zone === 'watch' || p.zone === 'loss');
  const firstLoss = data.points.find(p => p.zone === 'loss');
  const finalZone = data.points[data.points.length - 1].zone;

  return (
    <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 14, padding: '22px 26px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Money Flow</div>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, maxWidth: 640 }}>
            Sales ({fmtDate(data.current.from)}–{fmtDate(data.current.to)}) walked down to Profit — returns
            and discounts come off early, Storage &amp; OPEX comes off last. Line color tracks the running
            margin at each step, not any single step's own size.
          </p>
        </div>
        <Legend />
      </div>

      {firstWatch && (
        <div style={{
          fontSize: 11, color: ZONE_COLOR[finalZone], background: `${ZONE_COLOR[finalZone]}14`,
          border: `1px solid ${ZONE_COLOR[finalZone]}40`, borderRadius: 8, padding: '6px 12px',
          display: 'inline-block', marginBottom: 8, fontWeight: 600,
        }}>
          {finalZone === 'loss'
            ? `Margin turns negative at ${firstLoss.label} and stays there through Profit.`
            : `Margin drops out of the healthy range at ${firstWatch.label}.`}
        </div>
      )}

      <FlowChart points={data.points} grossSales={data.gross_sales} sym={sym} />
    </div>
  );
}
