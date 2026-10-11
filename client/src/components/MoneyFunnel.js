import React from 'react';
import { useApi } from '../hooks/useApi';

// Visual bridge from Sales down to Profit for a single period - Sales broken into its
// Price/Volume/Mix drivers vs. the immediately-prior period of equal length (the "mouth" of
// the funnel), then walked down through Cost of Goods (product COGS + selling fees + every
// OPEX line, lumped together per the product ask) and Marketing (ad spend) to Profit (the
// narrow end). See server/index.js's /api/money-funnel for why each number ties out exactly -
// it's composed from /api/pnl's and /api/pvm's own already-reconciled totals, not re-derived.

const fmtCurrency = (sym, v) => {
  const n = Math.round(v);
  const sign = n < 0 ? '−' : '';
  return `${sign}${sym}${Math.abs(n).toLocaleString('en-GB')}`;
};
const fmtSignedCurrency = (sym, v) => (v >= 0 ? '+' : '−') + sym + Math.abs(Math.round(v)).toLocaleString('en-GB');

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Standard floating waterfall: two "total" bars (Prior Sales, Current Sales) anchored to 0,
// with three "delta" bars (Price/Volume/Mix) floating between them at their running cumulative
// position - so the three deltas visibly sum from the first total bar's top to the second's.
function SalesBridge({ bridge, sym }) {
  const items = [
    { id: 'prior', label: 'Prior Sales', value: bridge.prior.value, kind: 'total' },
    { id: 'price', label: 'Price', value: bridge.price, kind: 'delta' },
    { id: 'volume', label: 'Volume', value: bridge.volume, kind: 'delta' },
    { id: 'mix', label: 'Mix', value: bridge.mix, kind: 'delta' },
    { id: 'current', label: 'Current Sales', value: bridge.current.value, kind: 'total' },
  ];
  let running = 0;
  const bars = items.map(it => {
    if (it.kind === 'total') { running = it.value; return { ...it, from: 0, to: it.value }; }
    const from = running;
    running += it.value;
    return { ...it, from, to: running };
  });
  const allPoints = bars.flatMap(b => [b.from, b.to, 0]);
  const maxVal = Math.max(...allPoints);
  const minVal = Math.min(...allPoints);
  const span = Math.max(maxVal - minVal, 1);
  const H = 110;
  const yOf = (v) => H - ((v - minVal) / span) * H;

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      {bars.map((b) => {
        const top = Math.min(yOf(b.from), yOf(b.to));
        const height = Math.max(Math.abs(yOf(b.from) - yOf(b.to)), 2);
        const color = b.kind === 'total' ? 'var(--accent2)' : (b.value >= 0 ? 'var(--green)' : 'var(--red)');
        return (
          <div key={b.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text)', marginBottom: 4, whiteSpace: 'nowrap' }}>
              {b.kind === 'delta' ? fmtSignedCurrency(sym, b.value) : fmtCurrency(sym, b.value)}
            </div>
            <div style={{ position: 'relative', width: '100%', height: H }}>
              <div style={{
                position: 'absolute', left: '18%', right: '18%', top, height,
                background: color, borderRadius: 3, minHeight: 2,
              }} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6, textAlign: 'center', fontWeight: 600 }}>{b.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function FunnelStage({ stage, sym, salesValue, isFinal }) {
  const widthPct = salesValue > 0 ? Math.max(14, Math.min(100, (stage.value / salesValue) * 100)) : 100;
  const pctOfSales = salesValue > 0 ? (stage.value / salesValue) * 100 : 0;
  const color = isFinal ? 'var(--green)' : 'var(--accent2)';
  return (
    <div style={{
      width: `${widthPct}%`, minWidth: 160, background: `${color}1a`, border: `1px solid ${color}`,
      borderRadius: 10, padding: '14px 20px', textAlign: 'center',
    }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{stage.label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--mono)', color: 'var(--text)', marginTop: 2 }}>{fmtCurrency(sym, stage.value)}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{pctOfSales.toFixed(1)}% of Sales</div>
    </div>
  );
}

function Connector({ label, amount, sym }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '2px 0' }}>
      <div style={{ width: 1, height: 10, background: 'var(--border2)' }} />
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--mono)' }}>
        {fmtCurrency(sym, -Math.abs(amount))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13, color: 'var(--border2)', lineHeight: 1 }}>▾</div>
    </div>
  );
}

export default function MoneyFunnel({ from, to }) {
  const { data, loading, error } = useApi('/api/money-funnel', { from, to });

  if (loading) return <div style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>Loading money funnel…</div>;
  if (error) return <div style={{ color: 'var(--red)', fontSize: 13, padding: '20px 0' }}>{error}</div>;
  if (!data) return null;

  const sym = data.currency_symbol;
  const salesValue = data.funnel[0]?.value || 0;

  return (
    <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 14, padding: '22px 26px' }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Money Funnel</div>
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, maxWidth: 640 }}>
          Sales ({fmtDate(data.current.from)}–{fmtDate(data.current.to)}) broken down by price, volume and mix vs.
          the equal-length period right before it ({fmtDate(data.prior.from)}–{fmtDate(data.prior.to)}), then
          walked down to Profit through Cost of Goods (COGS, selling fees, storage &amp; all OPEX) and Marketing.
        </p>
      </div>

      <SalesBridge bridge={data.sales_bridge} sym={sym} />

      <div style={{ height: 1, background: 'var(--border)', margin: '22px 0' }} />

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {data.funnel.map((stage, i) => (
          <React.Fragment key={stage.id}>
            {i > 0 && <Connector label={stage.removed_label} amount={stage.removed} sym={sym} />}
            <FunnelStage stage={stage} sym={sym} salesValue={salesValue} isFinal={i === data.funnel.length - 1} />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
