import React, { useMemo, useState } from 'react';
import DateRangePicker, { getRange } from '../components/DateRangePicker';
import { useApi } from '../hooks/useApi';

const fmtMoney = (n, sym = '£') => {
  const v = parseFloat(n || 0);
  const abs = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '−' : '') + sym + abs;
};
const fmtDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

// Materiality threshold for flagging a period - a gap smaller than this (in £ or %, whichever
// is more lenient) is treated as normal timing/rounding noise, not a real discrepancy.
const GAP_ABS_THRESHOLD = 15;
const GAP_PCT_THRESHOLD = 3;

function isMaterial(gap, gapPct) {
  const g = Math.abs(parseFloat(gap || 0));
  const p = gapPct === null || gapPct === undefined ? null : Math.abs(parseFloat(gapPct));
  if (g < GAP_ABS_THRESHOLD) return false;
  if (p !== null && p < GAP_PCT_THRESHOLD) return false;
  return true;
}

// Refunds and Fees join to Amazon's own settlement event IDs exactly - a gap there is a real
// data problem worth flagging. Sales only joins by date-range approximation (amazon_order_lines
// has no financial_event_group_id column), so it naturally jitters period-to-period as orders
// near a boundary shift between periods depending on shipment lag - that's expected noise, not
// a signal, so it's deliberately excluded from the materiality check driving the page's flagging.
function feeGap(o) {
  const gap = parseFloat(o.ours.fees) - parseFloat(o.amazon.fees);
  const base = Math.abs(parseFloat(o.amazon.fees));
  return { gap, pct: base !== 0 ? (gap / base) * 100 : null };
}
function refundGap(o) {
  const gap = parseFloat(o.ours.refunds) - parseFloat(o.amazon.refunds);
  const base = Math.abs(parseFloat(o.amazon.refunds));
  return { gap, pct: base !== 0 ? (gap / base) * 100 : null };
}
function isMaterialRow(o) {
  const f = feeGap(o), r = refundGap(o);
  return isMaterial(f.gap, f.pct) || isMaterial(r.gap, r.pct);
}

const cardStyle = {
  background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px',
  flex: 1, minWidth: 220,
};
const cardLabel = { fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 };
const cardValue = { fontSize: 24, fontWeight: 700, fontFamily: 'var(--mono)' };

export default function CashFlow() {
  const [range, setRange] = useState(() => {
    try { const s = localStorage.getItem('gb_cashflow_range'); return s ? JSON.parse(s) : getRange({ days: 90 }); } catch { return getRange({ days: 90 }); }
  });
  const handleRange = (r) => { setRange(r); localStorage.setItem('gb_cashflow_range', JSON.stringify(r)); };

  const { data, loading } = useApi('/api/cash-reconciliation', range);
  const sym = data?.currency_symbol || '£';
  const rows = data?.rows || [];
  const summary = data?.summary || null;

  const materialCount = useMemo(() => rows.filter(isMaterialRow).length, [rows]);
  const summaryFeeGap = summary ? feeGap(summary) : null;
  const summaryRefundGap = summary ? refundGap(summary) : null;
  const summaryMaterial = summary ? isMaterialRow(summary) : false;

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Cash Reconciliation</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 780 }}>
          Amazon-only, per settlement period (bi-weekly). Compares what Amazon actually reported for
          each closed payout period against our own synced data for the same window — settled fees
          and non-cancelled orders only. Figures here are raw/VAT-inclusive on both sides (this is a
          literal-cash check, not the VAT-exclusive reporting view used elsewhere). Excludes COGS,
          Shopify, and Amazon's reserve/carry-over balance mechanics — this is about "does our fee/
          revenue data match what got paid," not a full cash-flow statement.
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <DateRangePicker value={range} onChange={handleRange} />
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
      ) : !rows.length ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
          No closed settlement periods in this range yet.
        </div>
      ) : (
        <>
          {/* Fees and Refunds join to Amazon's exact settlement event IDs - these are the real
              signal. Sales/Net are shown separately below as informational, since Sales is only
              date-approximated and its natural noise would otherwise swamp a genuine fee problem. */}
          {summary && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ ...cardStyle, borderColor: isMaterial(summaryFeeGap.gap, summaryFeeGap.pct) ? 'var(--red)' : 'var(--green)' }}>
                <div style={cardLabel}>Fees Gap (precise)</div>
                <div style={{ ...cardValue, color: isMaterial(summaryFeeGap.gap, summaryFeeGap.pct) ? 'var(--red)' : 'var(--green)' }}>
                  {fmtMoney(summaryFeeGap.gap, sym)} {summaryFeeGap.pct !== null && <span style={{ fontSize: 14, fontWeight: 600 }}>({summaryFeeGap.pct.toFixed(2)}%)</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  Amazon {fmtMoney(summary.amazon.fees, sym)} vs ours {fmtMoney(summary.ours.fees, sym)}, over {summary.periods} settled periods
                </div>
              </div>
              <div style={{ ...cardStyle, borderColor: isMaterial(summaryRefundGap.gap, summaryRefundGap.pct) ? 'var(--red)' : 'var(--green)' }}>
                <div style={cardLabel}>Refunds Gap (precise)</div>
                <div style={{ ...cardValue, color: isMaterial(summaryRefundGap.gap, summaryRefundGap.pct) ? 'var(--red)' : 'var(--green)' }}>
                  {fmtMoney(summaryRefundGap.gap, sym)} {summaryRefundGap.pct !== null && <span style={{ fontSize: 14, fontWeight: 600 }}>({summaryRefundGap.pct.toFixed(2)}%)</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  Amazon {fmtMoney(summary.amazon.refunds, sym)} vs ours {fmtMoney(summary.ours.refunds, sym)}
                </div>
              </div>
              <div style={cardStyle}>
                <div style={cardLabel}>Sales Gap (approximate)</div>
                <div style={cardValue}>
                  {fmtMoney((parseFloat(summary.ours.sales) - parseFloat(summary.amazon.sales)).toFixed(2), sym)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  Date-approximated, not exact — see note below. Not used for flagging.
                </div>
              </div>
            </div>
          )}

          <div style={{ padding: '10px 14px', borderRadius: 8, background: summaryMaterial ? 'var(--red)15' : 'var(--green)15', border: '1px solid ' + (summaryMaterial ? 'var(--red)' : 'var(--green)'), fontSize: 13, color: summaryMaterial ? 'var(--red)' : 'var(--green)' }}>
            {summaryMaterial
              ? `${materialCount} of ${rows.length} periods show a Fees or Refunds gap over the £${GAP_ABS_THRESHOLD}/${GAP_PCT_THRESHOLD}% materiality threshold — see flagged rows below.`
              : `No material gap in Fees or Refunds across ${rows.length} settled periods — our data matches what Amazon actually paid out.`}
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead>
                <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                  {['Period', 'Paid', 'Amazon Sales', 'Amazon Refunds', 'Amazon Fees', 'Our Sales', 'Our Refunds', 'Our Fees', 'Fees Gap', 'Refunds Gap'].map((h, i) => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: i === 0 || i === 1 ? 'left' : 'right', fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const fg = feeGap(r), rg = refundGap(r);
                  const feeMaterial = isMaterial(fg.gap, fg.pct);
                  const refundMaterial = isMaterial(rg.gap, rg.pct);
                  const material = feeMaterial || refundMaterial;
                  return (
                    <tr key={r.financial_event_group_id} style={{ borderBottom: '1px solid var(--border)', background: material ? 'var(--red)08' : 'transparent' }}>
                      <td style={{ padding: '9px 12px', fontSize: 12 }}>
                        {fmtDate(r.period_start)} → {fmtDate(r.period_end)}
                        {r.has_unsettled_fees && <span title="This period includes order lines with estimated (not yet settled) fees" style={{ marginLeft: 6, fontSize: 10, color: '#fbbf24' }}>EST</span>}
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: 12, color: 'var(--muted)' }}>{fmtDate(r.fund_transfer_date)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtMoney(r.amazon.sales, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtMoney(r.amazon.refunds, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtMoney(r.amazon.fees, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--muted)' }}>{fmtMoney(r.ours.sales, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtMoney(r.ours.refunds, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtMoney(r.ours.fees, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 700, color: feeMaterial ? 'var(--red)' : 'var(--green)' }}>
                        {fmtMoney(fg.gap.toFixed(2), sym)}{fg.pct !== null && ` (${fg.pct.toFixed(1)}%)`}
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 700, color: refundMaterial ? 'var(--red)' : 'var(--green)' }}>
                        {fmtMoney(rg.gap.toFixed(2), sym)}{rg.pct !== null && ` (${rg.pct.toFixed(1)}%)`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
            "Our Sales" is approximated by order date falling within each settlement period's
            window (Amazon's own sales figure is tied to exact settlement events we don't currently
            store a link to per order line) — individual periods can show natural noise here as
            orders near a period boundary shift between periods depending on shipment lag. Refunds
            and Fees are matched to the exact settlement period via Amazon's own event IDs, so
            those are precise. The summary cards above sum across the whole selected range, which
            cancels out most of that per-period noise.
          </p>
        </>
      )}
    </div>
  );
}
