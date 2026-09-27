import React from 'react';

// Inline charts the chat assistant can render to illustrate an answer (a revenue/sales
// trend, or a PVM-style margin bridge) - driven by a small JSON spec the assistant emits in
// a ```chart fenced code block (see chat.js's system prompt for the exact schema). Kept
// deliberately compact for a narrow chat panel rather than reusing the full-size dashboard
// chart components (CashFlowProjection's two-panel chart, PVM's connected waterfall) - both
// need far more horizontal room per data point than a chat bubble has.
//
// Mark specs follow the dataviz skill: 2px lines with rounded caps, an 8px end-marker with
// a 2px surface-color ring, a ~10% opacity area wash under a trend line, sparse direct
// labels (endpoints only, never one per point), hairline recessive gridlines, and text in
// text tokens (never the series color) - marks carry color, labels don't.
//
// Form choice for "bridge": a full connected waterfall (like PVM.js's own chart) needs
// enough width per step to draw the floating segment and its connector - that doesn't fit a
// ~320px chat panel. The job here is "compare several named deltas that sum to a total",
// which a horizontal diverging bar list (bars from a zero baseline, red/green by sign)
// serves just as well at any width, so that's the form used here instead.

const GREEN = '#34d399';
const RED = '#f87171';
const ACCENT = 'var(--accent)';

function fmtValue(value, unit, currencySymbol) {
  const n = Number(value);
  if (unit === 'percent') return `${n >= 0 ? '' : ''}${n.toFixed(1)}%`;
  if (unit === 'currency') {
    const sym = currencySymbol || '£';
    const abs = Math.abs(n);
    const compact = abs >= 1000 ? (abs / 1000).toFixed(abs >= 10000 ? 0 : 1) + 'k' : abs.toFixed(0);
    return `${n < 0 ? '-' : ''}${sym}${compact}`;
  }
  return n.toLocaleString();
}

function ChartFrame({ title, children }) {
  return (
    <div style={{
      background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 10,
      padding: '10px 12px', margin: '4px 0',
    }}>
      {title && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>{title}</div>}
      {children}
    </div>
  );
}

function TrendChart({ spec }) {
  const points = Array.isArray(spec.points) ? spec.points.filter(p => Number.isFinite(Number(p.value))) : [];
  if (points.length < 2) return <ChartFrame title={spec.title}><div style={{ fontSize: 11, color: 'var(--muted)' }}>Not enough data to chart.</div></ChartFrame>;

  const W = 280, H = 72, PAD = 4;
  const values = points.map(p => Number(p.value));
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = (max - min) || 1;
  const x = (i) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - min) / range) * (H - PAD * 2);

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(Number(p.value)).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
  const last = points[points.length - 1];
  const first = points[0];

  return (
    <ChartFrame title={spec.title}>
      <svg width="100%" viewBox={`0 0 ${W} ${H + 14}`} style={{ display: 'block', overflow: 'visible' }}>
        <path d={areaPath} fill={ACCENT} opacity={0.1} />
        <path d={linePath} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={x(points.length - 1)} cy={y(Number(last.value))} r={4} fill={ACCENT} stroke="var(--bg3)" strokeWidth={2} />
        <text x={PAD} y={H + 12} fontSize={9} fill="var(--muted)" fontFamily="var(--mono)">{first.label}</text>
        <text x={W - PAD} y={H + 12} fontSize={9} fill="var(--muted)" fontFamily="var(--mono)" textAnchor="end">{last.label}</text>
        <text x={x(points.length - 1)} y={y(Number(last.value)) - 8} fontSize={10} fill="var(--text)" fontFamily="var(--mono)" fontWeight={700} textAnchor="end">
          {fmtValue(last.value, spec.unit, spec.currency_symbol)}
        </text>
      </svg>
    </ChartFrame>
  );
}

function BridgeChart({ spec }) {
  const steps = Array.isArray(spec.steps) ? spec.steps.filter(s => Number.isFinite(Number(s.value))) : [];
  if (!steps.length) return null;
  const maxAbs = Math.max(...steps.map(s => Math.abs(Number(s.value))), 1e-9);
  const rowH = 20;

  return (
    <ChartFrame title={spec.title}>
      {(spec.start_label || spec.end_label) && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)' }}>
          <span>{spec.start_label}: <b style={{ color: 'var(--text)' }}>{fmtValue(spec.start_value, spec.unit, spec.currency_symbol)}</b></span>
          <span>{spec.end_label}: <b style={{ color: 'var(--text)' }}>{fmtValue(spec.end_value, spec.unit, spec.currency_symbol)}</b></span>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {steps.map((s, i) => {
          const v = Number(s.value);
          const pct = (Math.abs(v) / maxAbs) * 100;
          const positive = v >= 0;
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '72px 1fr 52px', alignItems: 'center', gap: 6, height: rowH }}>
              <span style={{ fontSize: 10, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.label}</span>
              <div style={{ position: 'relative', height: 8, background: 'var(--bg2)', borderRadius: 4 }}>
                <div style={{
                  position: 'absolute', left: positive ? '50%' : `${50 - pct / 2}%`,
                  width: `${pct / 2}%`, height: '100%', borderRadius: 4,
                  background: positive ? GREEN : RED,
                }} />
                <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--border2)' }} />
              </div>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 700, color: positive ? GREEN : RED, textAlign: 'right' }}>
                {v >= 0 ? '+' : ''}{fmtValue(v, spec.unit, spec.currency_symbol)}
              </span>
            </div>
          );
        })}
      </div>
    </ChartFrame>
  );
}

export default function ChatChart({ raw }) {
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch {
    return (
      <pre style={{ fontSize: 11, background: 'var(--bg2)', padding: 8, borderRadius: 6, overflowX: 'auto' }}>{raw}</pre>
    );
  }
  // A spec that parses as JSON but has the wrong shape (missing/malformed fields) throws
  // inside the chart components below - render nothing rather than crash the whole message.
  try {
    if (spec.type === 'trend') return <TrendChart spec={spec} />;
    if (spec.type === 'bridge') return <BridgeChart spec={spec} />;
  } catch {
    return null;
  }
  return null;
}
