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

  const materialCount = useMemo(() => rows.filter(r => isMaterial(r.gap, r.gap_pct)).length, [rows]);
  const summaryMaterial = summary ? isMaterial(summary.gap, summary.gap_pct) : false;

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
          {/* Summary cards - the cumulative gap across the range is more trustworthy than any
              single period's Sales figure, which is only date-approximated (see note below). */}
          {summary && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div style={cardStyle}>
                <div style={cardLabel}>Amazon Reported (Net)</div>
                <div style={cardValue}>{fmtMoney(summary.amazon.net, sym)}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{summary.periods} settlement periods</div>
              </div>
              <div style={cardStyle}>
                <div style={cardLabel}>Ours (Net)</div>
                <div style={cardValue}>{fmtMoney(summary.ours.net, sym)}</div>
              </div>
              <div style={{ ...cardStyle, borderColor: summaryMaterial ? 'var(--red)' : 'var(--green)' }}>
                <div style={cardLabel}>Gap</div>
                <div style={{ ...cardValue, color: summaryMaterial ? 'var(--red)' : 'var(--green)' }}>
                  {fmtMoney(summary.gap, sym)} {summary.gap_pct !== null && <span style={{ fontSize: 14, fontWeight: 600 }}>({summary.gap_pct}%)</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  {summaryMaterial ? `No material gap over ${summary.periods} periods` : 'Within normal timing/rounding noise'}
                </div>
              </div>
            </div>
          )}

          {materialCount > 0 && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--red)15', border: '1px solid var(--red)', fontSize: 13, color: 'var(--red)' }}>
              {materialCount} of {rows.length} periods show a gap over the £{GAP_ABS_THRESHOLD}/{GAP_PCT_THRESHOLD}% materiality threshold — see flagged rows below.
            </div>
          )}

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead>
                <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                  {['Period', 'Paid', 'Amazon Sales', 'Amazon Refunds', 'Amazon Fees', 'Amazon Net', 'Our Sales', 'Our Refunds', 'Our Fees', 'Our Net', 'Gap'].map((h, i) => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: i === 0 || i === 1 ? 'left' : 'right', fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const material = isMaterial(r.gap, r.gap_pct);
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
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(r.amazon.net, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtMoney(r.ours.sales, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtMoney(r.ours.refunds, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtMoney(r.ours.fees, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(r.ours.net, sym)}</td>
                      <td style={{ padding: '9px 12px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 700, color: material ? 'var(--red)' : 'var(--green)' }}>
                        {fmtMoney(r.gap, sym)}{r.gap_pct !== null && ` (${r.gap_pct}%)`}
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
