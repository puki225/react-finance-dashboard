import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from '../hooks/useApi';

const fmtMoney = (n, sym = '£') => {
  const v = parseFloat(n || 0);
  const abs = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (v < 0 ? '−' : '') + sym + abs;
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—');
const fmtDateFull = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—');

const cardStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px' };
const statCardStyle = { ...cardStyle, flex: 1, minWidth: 200, padding: '16px 18px' };
const cardLabel = { fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 };
const cardValue = { fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' };

// Same fast custom tooltip pattern as Sales Forecast/PVM - native `title` has a fixed OS
// delay; portalled to document.body so it can't get clipped by a card's own overflow.
function HoverTooltip({ tip }) {
  if (!tip) return null;
  return createPortal(
    <div style={{
      position: 'fixed', top: tip.top, left: tip.left, zIndex: 9999, maxWidth: 260,
      background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8,
      padding: '10px 12px', fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.35)', pointerEvents: 'none',
    }}>
      {tip.content}
    </div>,
    document.body
  );
}

const W = 980, H = 260, PAD_L = 8, PAD_R = 8, PAD_T = 16, PAD_B = 28;

function BalanceChart({ daily, sym, threshold, breachDate }) {
  const [hover, setHover] = useState(null);
  const svgRef = React.useRef(null);

  const values = daily.map(d => parseFloat(d.balance));
  const allVals = threshold > 0 ? [...values, threshold] : values;
  const yMin = Math.min(0, ...allVals);
  const yMax = Math.max(...allVals) * 1.08 || 1;
  const n = daily.length;
  const x = (i) => PAD_L + (i / Math.max(n - 1, 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PAD_T - PAD_B);

  const linePath = useMemo(() => values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '), [values, n, yMin, yMax]);
  const zeroY = y(0);
  const thresholdY = threshold > 0 ? y(threshold) : null;

  // Area below zero shaded red-ish, above zero the normal accent fill, so a dip into
  // negative balance is visually distinct without needing a second series/color.
  const areaPath = `${linePath} L${x(n - 1).toFixed(1)},${zeroY.toFixed(1)} L${x(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  const ticks = useMemo(() => {
    const step = Math.max(1, Math.round(n / 6));
    const out = [];
    for (let i = 0; i < n; i += step) out.push(i);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  }, [n]);

  function handleMove(e) {
    const rect = svgRef.current.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width * W;
    let i = Math.round(((relX - PAD_L) / (W - PAD_L - PAD_R)) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    const d = daily[i];
    setHover({
      i,
      top: e.clientY + 14,
      left: e.clientX + 14,
      content: (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{fmtDateFull(d.date)}</div>
          <div>Balance: <b style={{ fontFamily: 'var(--mono)' }}>{fmtMoney(d.balance, sym)}</b></div>
          <div style={{ color: 'var(--green)' }}>Inflow: {fmtMoney(d.inflow, sym)}</div>
          <div style={{ color: 'var(--red)' }}>Outflow: {fmtMoney(d.outflow, sym)}</div>
        </div>
      ),
    });
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none"
        onMouseMove={handleMove} onMouseLeave={() => setHover(null)} style={{ display: 'block', cursor: 'crosshair' }}>
        {/* gridlines */}
        {[0.25, 0.5, 0.75].map(f => (
          <line key={f} x1={PAD_L} x2={W - PAD_R} y1={PAD_T + f * (H - PAD_T - PAD_B)} y2={PAD_T + f * (H - PAD_T - PAD_B)} stroke="var(--border)" strokeWidth={1} opacity={0.5} />
        ))}
        {/* zero line */}
        <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY} stroke="var(--border2)" strokeWidth={1} />
        {/* minimum-threshold reference line - a status color (amber), not a categorical
            hue, since it marks a state (danger zone) rather than a data series */}
        {thresholdY !== null && (
          <>
            <line x1={PAD_L} x2={W - PAD_R} y1={thresholdY} y2={thresholdY} stroke="var(--amber)" strokeWidth={1.5} strokeDasharray="4,4" opacity={0.8} />
            <text x={W - PAD_R} y={thresholdY - 5} textAnchor="end" fontSize={10} fill="var(--amber)" fontFamily="var(--mono)">Minimum threshold</text>
          </>
        )}
        <path d={areaPath} fill="var(--accent)" opacity={0.08} />
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} />
        {/* breach marker */}
        {breachDate && daily.some(d => d.date === breachDate) && (
          <circle cx={x(daily.findIndex(d => d.date === breachDate))} cy={y(parseFloat(daily.find(d => d.date === breachDate).balance))} r={4} fill="var(--red)" />
        )}
        {hover && <line x1={x(hover.i)} x2={x(hover.i)} y1={PAD_T} y2={H - PAD_B} stroke="var(--muted)" strokeWidth={1} opacity={0.4} />}
        {hover && <circle cx={x(hover.i)} cy={y(values[hover.i])} r={3.5} fill="var(--accent)" />}
        {ticks.map(i => (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--muted)" fontFamily="var(--mono)">{fmtDate(daily[i].date)}</text>
        ))}
      </svg>
      <HoverTooltip tip={hover} />
    </div>
  );
}

function AssumptionsSummary({ data }) {
  const a = data.assumptions;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12, color: 'var(--muted)' }}>
      <span>Amazon payout lag: <b style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{a.amazon_payout_lag_days}d</b></span>
      <span>·</span>
      <span>Shopify payout lag: <b style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{a.shopify_payout_lag_days}d</b></span>
      <span>·</span>
      <span>Amazon payout ratio (trailing 12mo): <b style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{(data.payout_ratios.amazon * 100).toFixed(0)}%</b></span>
      <span>·</span>
      <span>Supplier terms: <b style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{a.supplier_payment_terms_days}d</b></span>
    </div>
  );
}

export default function CashFlowProjection() {
  const { data, loading, error } = useApi('/api/cashflow');
  const sym = data?.currency_symbol || '£';

  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>;
  if (error) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--red)' }}>{error}</div>;
  if (!data) return null;

  const daily = data.daily || [];
  const todayBalance = daily[0]?.balance;
  const threshold = parseFloat(data.assumptions.minimum_cash_threshold || 0);
  const willBreach = !!data.threshold_breach_date;
  const stale = data.balance_stale_days !== null && data.balance_stale_days > 7;

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1200 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Cash Flow</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
          Projected daily cash position — sales forecast converted to actual payout timing, minus planned spend and known outflows.
          Configure assumptions under Settings → Cash Flow.
        </p>
      </div>

      {!data.has_forecast && (
        <div style={{ background: 'var(--amber)15', border: '1px solid var(--amber)', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: 'var(--amber)' }}>
          No sales forecast has been generated yet — this projection only reflects payouts on sales that already happened, not future ones. Check the Sales Forecast tab.
        </div>
      )}
      {stale && (
        <div style={{ background: 'var(--amber)15', border: '1px solid var(--amber)', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: 'var(--amber)' }}>
          Your opening balance was last updated {data.balance_stale_days} days ago ({fmtDateFull(data.assumptions.balance_as_of_date)}) — update it in Settings → Cash Flow for an accurate starting point.
        </div>
      )}
      {willBreach && (
        <div style={{ background: 'var(--red)15', border: '1px solid var(--red)', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: 'var(--red)' }}>
          Projected balance drops below your minimum threshold ({fmtMoney(threshold, sym)}) around {fmtDateFull(data.threshold_breach_date)}.
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <div style={statCardStyle}>
          <div style={cardLabel}>Current balance</div>
          <div style={cardValue}>{fmtMoney(todayBalance, sym)}</div>
        </div>
        <div style={statCardStyle}>
          <div style={cardLabel}>Projected minimum ({data.daily.length}d)</div>
          <div style={{ ...cardValue, color: parseFloat(data.min_balance) < threshold ? 'var(--red)' : 'var(--text)' }}>
            {fmtMoney(data.min_balance, sym)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>on {fmtDate(data.min_balance_date)}</div>
        </div>
        <div style={statCardStyle}>
          <div style={cardLabel}>Minimum threshold</div>
          <div style={cardValue}>{fmtMoney(threshold, sym)}</div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Projected balance</div>
        <BalanceChart daily={daily} sym={sym} threshold={threshold} breachDate={data.threshold_breach_date} />
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <AssumptionsSummary data={data} />
        </div>
      </div>
    </div>
  );
}
