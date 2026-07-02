import React, { useState, useMemo } from 'react';
import DateRangePicker, { getRange } from '../components/DateRangePicker';
import { useApi } from '../hooks/useApi';

const GROUPS = ['day', 'week', 'month', 'year'];
const FULFILLMENT = [{ id: 'all', label: 'All' }, { id: 'FBA', label: 'FBA' }, { id: 'FBM', label: 'FBM' }];
const ORDER_TYPE = [{ id: 'all', label: 'All' }, { id: 'B2B', label: 'B2B' }, { id: 'B2C', label: 'B2C' }];

const toggleBtn = (active) => ({
  padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
  border: '1px solid ' + (active ? 'var(--accent2)' : 'var(--border)'),
  background: active ? 'var(--accent2)20' : 'transparent',
  color: active ? 'var(--accent2)' : 'var(--muted)',
  cursor: 'pointer', fontFamily: 'var(--font)', letterSpacing: '0.04em', transition: 'all 0.15s',
});

// Every cost/fee-like field returned by /api/pnl is pre-signed negative (an outflow) — see
// server/index.js buildPeriodRow. This formatter just renders the sign consistently: a leading
// "−" and red colour for negative, plain text for zero/positive.
const makeSignedFmt = (symbol = '£') => (n) => {
  const v = parseFloat(n || 0);
  const abs = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (v < 0 ? '−' : '') + symbol + abs;
};
const fmtNum = (n) => parseInt(n || 0, 10).toLocaleString('en-GB');
const fmtPct = (n) => parseFloat(n || 0).toFixed(1) + '%';

function fmtPeriodLabel(period, group) {
  if (!period || period === '__total__') return 'Total';
  const d = new Date(period);
  if (group === 'year') return String(d.getFullYear());
  if (group === 'month') return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  if (group === 'week') return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// Prettify raw Amazon fee_type strings (e.g. "Subscription" / "FBAStorageFee") into readable labels
// without a hardcoded lookup table, since real fee_type values haven't been confirmed via sync yet.
function prettifyFeeType(ft) {
  if (!ft) return 'Unknown Fee';
  return ft.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function downloadCsv(periods, totals, group, accountFeeTypes, sym) {
  const cols = ['Line Item', ...periods.map(p => fmtPeriodLabel(p.period, group)), 'Total'];
  const rows = [];
  const pushRow = (label, key) => {
    rows.push([label, ...periods.map(p => getPath(p, key)), getPath(totals, key)]);
  };
  pushRow('Units Sold', 'units_sold');
  pushRow('Gross Sales', 'gross_sales');
  pushRow('Discounts / Promos', 'total_discounts');
  pushRow('Refunds', 'total_refunded');
  pushRow('Net Sales', 'net_sales');
  pushRow('Seller COGS', 'cogs.total');
  for (const ft of ['commission', 'fba_fulfillment', 'fixed_closing', 'variable_closing', 'digital_services', 'giftwrap', 'shipping_chargeback']) {
    if (parseFloat(getPath(totals, `fees.${ft}`) || 0) !== 0) pushRow('  ' + prettifyFeeType(ft), `fees.${ft}`);
  }
  for (const ft of accountFeeTypes) {
    if (parseFloat(getPath(totals, `account_fees.${ft}`) || 0) !== 0) pushRow('  ' + prettifyFeeType(ft), `account_fees.${ft}`);
  }
  pushRow('Total Fees', 'total_fees');
  pushRow('Adjustments', 'adjustments');
  pushRow('Gross Margin', 'gross_margin');
  pushRow('PPC Spend', 'ppc_cost');
  pushRow('Product Contribution', 'product_contribution');
  pushRow('Margin %', 'margin_pct');
  pushRow('ROI %', 'roi_pct');

  const csv = [cols.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `pnl_${group}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function PnL() {
  const [range, setRange] = useState(() => {
    try { const s = localStorage.getItem('gb_pnl_range'); return s ? JSON.parse(s) : getRange({ days: 90 }); } catch { return getRange({ days: 90 }); }
  });
  const [group, setGroup] = useState(() => localStorage.getItem('gb_pnl_group') || 'month');
  const [fulfillment, setFulfillment] = useState(() => localStorage.getItem('gb_pnl_fulfillment') || 'all');
  const [orderType, setOrderType] = useState(() => localStorage.getItem('gb_pnl_order_type') || 'all');
  const [search, setSearch] = useState('');
  const [feesExpanded, setFeesExpanded] = useState(true);

  const handleRange = (r) => { setRange(r); localStorage.setItem('gb_pnl_range', JSON.stringify(r)); };
  const handleGroup = (g) => { setGroup(g); localStorage.setItem('gb_pnl_group', g); };
  const handleFulfillment = (f) => { setFulfillment(f); localStorage.setItem('gb_pnl_fulfillment', f); };
  const handleOrderType = (o) => { setOrderType(o); localStorage.setItem('gb_pnl_order_type', o); };

  const params = {
    ...range, group,
    ...(fulfillment !== 'all' ? { fulfillment } : {}),
    ...(orderType !== 'all' ? { order_type: orderType } : {}),
    ...(search ? { search } : {}),
  };
  const { data, loading } = useApi('/api/pnl', params);

  const sym = data?.currency_symbol || '£';
  const fmt = useMemo(() => makeSignedFmt(sym), [sym]);
  const periods = data?.periods || [];
  const totals = data?.totals || {};
  const accountFeeTypes = data?.account_fee_types || [];

  const lineFeeRows = useMemo(() => (
    [
      ['commission', 'Commission'],
      ['fba_fulfillment', 'FBA Fulfillment'],
      ['fixed_closing', 'Fixed Closing Fee'],
      ['variable_closing', 'Variable Closing Fee'],
      ['digital_services', 'Digital Services'],
      ['giftwrap', 'Giftwrap Chargeback'],
      ['shipping_chargeback', 'Shipping Chargeback'],
    ].filter(([key]) => parseFloat(getPath(totals, `fees.${key}`) || 0) !== 0)
  ), [totals]);

  const accountFeeRows = useMemo(() => (
    accountFeeTypes.filter(ft => parseFloat(getPath(totals, `account_fees.${ft}`) || 0) !== 0)
  ), [accountFeeTypes, totals]);

  const hasAccountFeeData = accountFeeRows.length > 0;

  const colTemplate = `220px repeat(${periods.length}, minmax(100px, 1fr)) 140px`;
  const gridMinWidth = 220 + periods.length * 100 + 140;

  const Cell = ({ children, bold, muted, align = 'right', color }) => (
    <div style={{
      padding: '9px 10px', textAlign: align, fontSize: bold ? 13 : 12, fontWeight: bold ? 700 : 400,
      fontFamily: 'var(--mono)', color: color || (muted ? 'var(--muted)' : 'var(--text)'), whiteSpace: 'nowrap',
    }}>
      {children}
    </div>
  );

  const LabelCell = ({ children, bold, indent, onClick, expandable, expanded }) => (
    <div
      onClick={onClick}
      style={{
        padding: '9px 10px', fontSize: bold ? 13 : 12, fontWeight: bold ? 700 : 400,
        color: bold ? 'var(--text)' : 'var(--muted)', paddingLeft: indent ? 28 : 10,
        position: 'sticky', left: 0, background: 'var(--bg2)', display: 'flex', alignItems: 'center', gap: 6,
        cursor: expandable ? 'pointer' : 'default', userSelect: 'none', whiteSpace: 'nowrap',
      }}
    >
      {expandable && <span style={{ fontSize: 10, color: 'var(--accent2)', width: 10, display: 'inline-block' }}>{expanded ? '▾' : '▸'}</span>}
      {children}
    </div>
  );

  function ValueRow({ label, keyPath, kind = 'currency', bold, indent, highlight, onClick, expandable, expanded }) {
    const rowTotal = getPath(totals, keyPath);
    const fmtVal = (v) => kind === 'number' ? fmtNum(v) : kind === 'pct' ? fmtPct(v) : fmt(v);
    const colorFor = (v) => {
      if (kind === 'number') return 'var(--text)';
      const n = parseFloat(v || 0);
      if (kind === 'pct') return n >= 20 ? 'var(--green)' : n >= 0 ? 'var(--amber)' : 'var(--red)';
      return n < 0 ? 'var(--red)' : highlight ? 'var(--green)' : 'var(--text)';
    };
    return (
      <div style={{ display: 'grid', gridTemplateColumns: colTemplate, borderBottom: '1px solid var(--border)', background: highlight ? '#34d39908' : 'transparent' }}>
        <LabelCell bold={bold} indent={indent} onClick={onClick} expandable={expandable} expanded={expanded}>{label}</LabelCell>
        {periods.map((p, i) => (<Cell key={i} bold={bold} color={colorFor(getPath(p, keyPath))}>{fmtVal(getPath(p, keyPath))}</Cell>))}
        <Cell bold color={colorFor(rowTotal)}>{fmtVal(rowTotal)}</Cell>
      </div>
    );
  }

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>P&L</h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Account-wide profit &amp; loss, Amazon only — includes subscription, storage and other account-level fees</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
            {GROUPS.map(g => (<button key={g} onClick={() => handleGroup(g)} style={{ ...toggleBtn(group === g), textTransform: 'capitalize' }}>{g}</button>))}
          </div>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
            {FULFILLMENT.map(f => (<button key={f.id} onClick={() => handleFulfillment(f.id)} style={toggleBtn(fulfillment === f.id)}>{f.label}</button>))}
          </div>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
            {ORDER_TYPE.map(o => (<button key={o.id} onClick={() => handleOrderType(o.id)} style={toggleBtn(orderType === o.id)}>{o.label}</button>))}
          </div>
          <input
            value={search} onChange={e => setSearch(e.target.value)} placeholder="SKU / ASIN / Order ID"
            style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 12px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font)', width: 150 }}
          />
          <DateRangePicker value={range} onChange={handleRange} />
          <button
            onClick={() => downloadCsv(periods, totals, group, accountFeeTypes, sym)}
            disabled={!periods.length}
            style={{ padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1px solid var(--border)', background: 'var(--bg3)', color: periods.length ? 'var(--text)' : 'var(--muted)', cursor: periods.length ? 'pointer' : 'not-allowed', fontFamily: 'var(--font)' }}
          >
            Download CSV
          </button>
        </div>
      </div>

      {!loading && !hasAccountFeeData && (
        <div style={{ background: '#fbbf2412', border: '1px solid #fbbf2440', borderRadius: 10, padding: '12px 16px', fontSize: 12, color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15 }}>⚠</span>
          No account-level fee data yet (subscription, storage, coupons). Run the Amazon Finances sync to backfill this — until then, Fees below only reflect per-order charges.
        </div>
      )}

      {/* Grid */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: gridMinWidth }}>
            {/* Header row */}
            <div style={{ display: 'grid', gridTemplateColumns: colTemplate, background: 'var(--bg3)', borderBottom: '1px solid var(--border)' }}>
              <div style={{ padding: '11px 10px', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', position: 'sticky', left: 0, background: 'var(--bg3)' }}>Line Item</div>
              {periods.map((p, i) => (
                <div key={i} style={{ padding: '11px 10px', fontSize: 11, fontWeight: 600, textAlign: 'right', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{fmtPeriodLabel(p.period, group)}</div>
              ))}
              <div style={{ padding: '11px 10px', fontSize: 11, fontWeight: 700, textAlign: 'right', color: 'var(--accent2)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Total</div>
            </div>

            {loading && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}
            {!loading && !periods.length && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No data for this selection</div>}

            {!loading && periods.length > 0 && (
              <>
                <ValueRow label="Units Sold" keyPath="units_sold" kind="number" />
                <ValueRow label="Gross Sales" keyPath="gross_sales" bold />
                <ValueRow label="Discounts / Promos" keyPath="total_discounts" indent />
                <ValueRow label="Refunds" keyPath="total_refunded" indent />
                <ValueRow label="Net Sales" keyPath="net_sales" bold highlight />
                <ValueRow label="Seller COGS" keyPath="cogs.total" bold />

                <ValueRow
                  label="Fees" keyPath="total_fees" bold
                  expandable expanded={feesExpanded}
                  onClick={() => setFeesExpanded(s => !s)}
                />
                {feesExpanded && lineFeeRows.map(([key, label]) => (
                  <ValueRow key={key} label={label} keyPath={`fees.${key}`} indent />
                ))}
                {feesExpanded && accountFeeRows.map(ft => (
                  <ValueRow key={ft} label={prettifyFeeType(ft)} keyPath={`account_fees.${ft}`} indent />
                ))}

                <ValueRow label="Adjustments" keyPath="adjustments" bold />
                <ValueRow label="Gross Margin" keyPath="gross_margin" bold highlight />
                <ValueRow label="PPC Spend" keyPath="ppc_cost" indent />
                <ValueRow label="Product Contribution" keyPath="product_contribution" bold highlight />
                <ValueRow label="Margin %" keyPath="margin_pct" kind="pct" />
                <ValueRow label="ROI %" keyPath="roi_pct" kind="pct" />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
