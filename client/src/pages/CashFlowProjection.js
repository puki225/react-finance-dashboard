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
const toggleBtn = (active) => ({
  padding: '5px 11px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
  border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border2)'),
  background: active ? 'var(--accent)25' : 'transparent',
  color: active ? 'var(--accent2)' : 'var(--muted)',
  fontFamily: 'var(--font)',
});

const WINDOWS = [
  { id: 30, label: '30d' },
  { id: 60, label: '60d' },
  { id: 90, label: '90d' },
  { id: 180, label: '6mo' },
];
const GRANULARITIES = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
];

// Calendar-week-aligned (Monday start) - same convention Sales Forecast's own weekly
// bucketing already uses. £ figures (inflow/outflow/net) sum across the week; balance is a
// point-in-time reading, not additive, so it takes the last day actually present in that
// week rather than a sum or average.
function weekKey(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay();
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() + diffToMonday);
  return monday.toISOString().slice(0, 10);
}
function bucketWeekly(daily) {
  const buckets = new Map();
  for (const d of daily) {
    const key = weekKey(d.date);
    const cur = buckets.get(key) || { key, inflow: 0, outflow: 0, net: 0, balance: d.balance, date: d.date };
    cur.inflow += parseFloat(d.inflow);
    cur.outflow += parseFloat(d.outflow);
    cur.net += parseFloat(d.net);
    cur.balance = d.balance; // daily arrives date-ascending, so the last write wins
    cur.date = d.date;
    buckets.set(key, cur);
  }
  return [...buckets.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map(b => ({ date: b.date, inflow: b.inflow.toFixed(2), outflow: b.outflow.toFixed(2), net: b.net.toFixed(2), balance: b.balance }));
}

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

const W = 980, PAD_L = 6, PAD_R = 6;
const P1H = 190, GAP = 30, P2H = 90, XAXIS_H = 22;
const TOTAL_H = P1H + GAP + P2H + XAXIS_H;

// One rounded-corner rect path per bar - corners round toward whichever end is away from
// the zero baseline, matching a normal bar chart's "grows away from zero" reading.
function roundedBarPath(cx, yTop, yBottom, w, positive) {
  const r = Math.min(4, w / 2, Math.abs(yBottom - yTop));
  const left = cx - w / 2, right = cx + w / 2;
  if (positive) {
    return `M${left},${yBottom} L${left},${yTop + r} Q${left},${yTop} ${left + r},${yTop} L${right - r},${yTop} Q${right},${yTop} ${right},${yTop + r} L${right},${yBottom} Z`;
  }
  return `M${left},${yTop} L${right},${yTop} L${right},${yBottom - r} Q${right},${yBottom} ${right - r},${yBottom} L${left + r},${yBottom} Q${left},${yBottom} ${left},${yBottom - r} Z`;
}

// Two stacked panels sharing one x-axis and one hover crosshair: balance (the headline -
// "am I safe on any given day") on top, daily net in/out (the explanation - "why did it
// move") below. Deliberately not one dual-axis combo chart - that needs its bar and line
// scales picked independently just to make both fit, which means any visual correlation
// between them is arbitrary, not real (the #1 charting mistake). Sharing an x-axis and a
// crosshair instead still reads as one cohesive chart - a dip up top lines up exactly with
// its cause below - without inventing a fake relationship between two unrelated scales.
function CashFlowChart({ daily, sym, threshold, breachDate, granularity }) {
  const [hover, setHover] = useState(null);
  const svgRef = React.useRef(null);
  const n = daily.length;

  const balances = daily.map(d => parseFloat(d.balance));
  const balVals = threshold > 0 ? [...balances, threshold] : balances;
  const balMin = Math.min(0, ...balVals) - Math.abs(Math.max(...balVals) - Math.min(...balVals)) * 0.08;
  const balMax = Math.max(...balVals) + Math.abs(Math.max(...balVals) - Math.min(...balVals)) * 0.08 || 1;
  const x = (i) => PAD_L + (i / Math.max(n - 1, 1)) * (W - PAD_L - PAD_R);
  const y1 = (v) => (balMax === balMin ? P1H / 2 : P1H - (v - balMin) / (balMax - balMin) * P1H);

  const linePath = useMemo(() => balances.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y1(v).toFixed(1)}`).join(' '), [daily, balMin, balMax]); // eslint-disable-line
  const thresholdY = threshold > 0 ? y1(threshold) : null;
  const areaPath = `${linePath} L${x(n - 1).toFixed(1)},${P1H} L${x(0).toFixed(1)},${P1H} Z`;

  let lowIdx = 0;
  daily.forEach((d, i) => { if (parseFloat(d.balance) < parseFloat(daily[lowIdx].balance)) lowIdx = i; });
  const belowThreshold = threshold > 0 && parseFloat(daily[lowIdx].balance) < threshold;

  const nets = daily.map(d => parseFloat(d.net));
  const maxAbsNet = Math.max(...nets.map(Math.abs), 1) * 1.15;
  const p2Y0 = P1H + GAP;
  const y2 = (v) => p2Y0 + P2H / 2 - (v / maxAbsNet) * (P2H / 2);
  const baseline2 = p2Y0 + P2H / 2;
  const slot = (W - PAD_L - PAD_R) / Math.max(n - 1, 1);
  const barW = Math.max(1, Math.min(24, slot - 2));

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
    let i = Math.round((relX - PAD_L) / (W - PAD_L - PAD_R) * (n - 1));
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
          <div style={{ color: parseFloat(d.net) >= 0 ? 'var(--green)' : 'var(--red)' }}>
            Net: <b style={{ fontFamily: 'var(--mono)' }}>{parseFloat(d.net) >= 0 ? '+' : ''}{fmtMoney(d.net, sym)}</b>
          </div>
          <div style={{ color: 'var(--green)' }}>Inflow: {fmtMoney(d.inflow, sym)}</div>
          <div style={{ color: 'var(--red)' }}>Outflow: {fmtMoney(d.outflow, sym)}</div>
        </div>
      ),
    });
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${TOTAL_H}`} width="100%" height={TOTAL_H} preserveAspectRatio="none"
        onMouseMove={handleMove} onMouseLeave={() => setHover(null)} style={{ display: 'block', cursor: 'crosshair' }}>
        <text x={PAD_L} y={10} fontSize={10} fontFamily="var(--mono)" fill="var(--muted)" letterSpacing="0.05em">PROJECTED CASH BALANCE</text>

        {/* Panel 1: balance line */}
        {[0, 0.5, 1].map(f => (
          <line key={f} x1={PAD_L} x2={W - PAD_R} y1={f * P1H} y2={f * P1H} stroke="var(--border)" strokeWidth={1} opacity={0.5} />
        ))}
        {thresholdY !== null && (
          <>
            <line x1={PAD_L} x2={W - PAD_R} y1={thresholdY} y2={thresholdY} stroke="var(--amber)" strokeWidth={1.5} strokeDasharray="4,4" opacity={0.8} />
            <text x={W - PAD_R} y={thresholdY - 5} textAnchor="end" fontSize={10} fill="var(--amber)" fontFamily="var(--mono)">Min threshold {fmtMoney(threshold, sym)}</text>
          </>
        )}
        <path d={areaPath} fill="var(--accent)" opacity={0.1} />
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(lowIdx)} cy={y1(parseFloat(daily[lowIdx].balance))} r={5} fill={belowThreshold ? 'var(--red)' : 'var(--accent)'} stroke="var(--bg2)" strokeWidth={2} />
        <text x={x(lowIdx)} y={y1(parseFloat(daily[lowIdx].balance)) - 12} textAnchor={lowIdx > n - 12 ? 'end' : 'middle'} fontSize={11} fontFamily="var(--mono)" fontWeight={600} fill={belowThreshold ? 'var(--red)' : 'var(--text)'}>
          Low {fmtMoney(daily[lowIdx].balance, sym)} · {fmtDate(daily[lowIdx].date)}
        </text>
        {breachDate && daily.some(d => d.date === breachDate) && breachDate !== daily[lowIdx].date && (
          <circle cx={x(daily.findIndex(d => d.date === breachDate))} cy={y1(parseFloat(daily.find(d => d.date === breachDate).balance))} r={4} fill="var(--red)" />
        )}

        {/* Panel 2: daily net flow, green/red columns */}
        <text x={PAD_L} y={p2Y0 - 8} fontSize={10} fontFamily="var(--mono)" fill="var(--muted)" letterSpacing="0.05em">{granularity === 'weekly' ? 'WEEKLY' : 'DAILY'} NET FLOW</text>
        <line x1={PAD_L} x2={W - PAD_R} y1={baseline2} y2={baseline2} stroke="var(--border)" strokeWidth={1} opacity={0.5} />
        {daily.map((d, i) => {
          const net = parseFloat(d.net);
          if (Math.abs(net) < 0.01) return null;
          const positive = net > 0;
          const yv = y2(net);
          return (
            <path key={i} d={roundedBarPath(x(i), positive ? yv : baseline2, positive ? baseline2 : yv, barW, positive)}
              fill={positive ? 'var(--green)' : 'var(--red)'} opacity={0.9} />
          );
        })}

        {/* shared crosshair across both panels */}
        {hover && <line x1={x(hover.i)} x2={x(hover.i)} y1={0} y2={p2Y0 + P2H} stroke="var(--muted)" strokeWidth={1} opacity={0.4} />}
        {hover && <circle cx={x(hover.i)} cy={y1(balances[hover.i])} r={3.5} fill="var(--accent)" stroke="var(--bg2)" strokeWidth={1.5} />}

        {/* shared x-axis */}
        {ticks.map(i => (
          <text key={i} x={x(i)} y={p2Y0 + P2H + 16} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize={10} fill="var(--muted)" fontFamily="var(--mono)">{fmtDate(daily[i].date)}</text>
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
      <span>Amazon payout ratio (trailing 180d): <b style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{(data.payout_ratios.amazon * 100).toFixed(0)}%</b></span>
    </div>
  );
}

export default function CashFlowProjection() {
  const [windowDays, setWindowDays] = useState(90);
  const [granularity, setGranularity] = useState('daily');
  const { data, loading, error } = useApi('/api/cashflow', { horizon_days: windowDays });
  const sym = data?.currency_symbol || '£';

  const daily = useMemo(() => {
    const raw = data?.daily || [];
    return granularity === 'weekly' ? bucketWeekly(raw) : raw;
  }, [data, granularity]);

  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>;
  if (error) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--red)' }}>{error}</div>;
  if (!data) return null;

  const todayBalance = data.daily?.[0]?.balance;
  const threshold = parseFloat(data.assumptions.minimum_cash_threshold || 0);
  const willBreach = !!data.threshold_breach_date;
  const stale = data.balance_stale_days !== null && data.balance_stale_days > 7;

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1200 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Cash Flow</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
          Projected cash position — sales forecast converted to actual payout timing, minus procurement replenishment and known outflows.
          Configure payout assumptions under Settings → Cash Flow, and per-product lead times under Settings → Procurement.
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Projected balance</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {WINDOWS.map(w => (
                <button key={w.id} style={toggleBtn(windowDays === w.id)} onClick={() => setWindowDays(w.id)}>{w.label}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {GRANULARITIES.map(g => (
                <button key={g.id} style={toggleBtn(granularity === g.id)} onClick={() => setGranularity(g.id)}>{g.label}</button>
              ))}
            </div>
          </div>
        </div>
        <CashFlowChart daily={daily} sym={sym} threshold={threshold} breachDate={data.threshold_breach_date} granularity={granularity} />
        <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--green)' }} />Cash in
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--red)' }} />Cash out
          </div>
        </div>
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <AssumptionsSummary data={data} />
        </div>
      </div>

      {data.procurement_orders?.length > 0 && (
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Projected replenishment orders</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
            Automatically triggered from current stock, forecasted velocity, and your Procurement lead-time/payment assumptions (Settings → Procurement) — each of these is already included as a cash outflow above.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['SKU', 'Order placed', 'Arrives', 'Cash out', 'Qty', 'Amount'].map((h, i) => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: i >= 3 ? 'right' : 'left', fontSize: 10, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.procurement_orders.map((o, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px', fontSize: 12, fontFamily: 'var(--mono)' }}>{o.sku}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12 }}>{fmtDate(o.trigger_date)}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12 }}>{fmtDate(o.arrival_date)}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtDate(o.payment_date)}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{o.order_qty.toLocaleString()}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(o.amount, sym)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
