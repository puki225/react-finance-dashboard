import React, { useState, useMemo } from 'react';
import KpiCard from '../components/KpiCard';
import DateRangePicker, { getRange } from '../components/DateRangePicker';
import { useApi } from '../hooks/useApi';

const makeFmt = (symbol = '£') => (n) => symbol + parseFloat(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN = (n) => parseInt(n || 0).toLocaleString('en-GB');
const fmtPct = (n) => parseFloat(n || 0).toFixed(1) + '%';

const CHANNELS = [{ id: 'all', label: 'All' }, { id: 'shopify', label: 'Shopify' }, { id: 'amazon', label: 'Amazon' }];
const channelBtn = (active) => ({
  padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
  border: '1px solid ' + (active ? 'var(--accent2)' : 'var(--border)'),
  background: active ? 'var(--accent2)20' : 'transparent',
  color: active ? 'var(--accent2)' : 'var(--muted)',
  cursor: 'pointer', fontFamily: 'var(--font)', letterSpacing: '0.04em', transition: 'all 0.15s',
});

const channelBadge = (ch) => {
  const map = {
    both:    { bg: '#7c6af720', color: '#a78bfa', label: 'Both'    },
    shopify: { bg: '#7c6af720', color: '#a78bfa', label: 'Shopify' },
    amazon:  { bg: '#fbbf2420', color: '#fbbf24', label: 'Amazon'  },
  };
  const s = map[ch] || map.shopify;
  return <span style={{ padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: s.bg, color: s.color, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{s.label}</span>;
};

const COLS = [
  { key: 'expand',           label: '',          sortable: false, width: '36px' },
  { key: 'product_title',    label: 'Product',   sortable: false, width: '1fr'  },
  { key: 'units_sold',       label: 'Units',     sortable: true,  width: '10%'  },
  { key: 'gross_sales',      label: 'Revenue',   sortable: true,  width: '11%'  },
  { key: 'gross_margin_pct', label: 'Margin %',  sortable: true,  width: '8%'   },
  { key: 'profit_pct',       label: 'Profit %',  sortable: false, width: '8%'   },
  { key: 'gross_profit',     label: 'Profit £',  sortable: true,  width: '9%'   },
  { key: 'roi',              label: 'ROI',       sortable: false, width: '7%'   },
  { key: 'acos',             label: 'ACOS',      sortable: false, width: '11%'  },
  { key: 'channels',         label: 'Channel',   sortable: false, width: '7%'   },
];

function PnlPanel({ sku, from, to, sym, country, channel }) {
  // Normalise channel: 'both' and undefined → 'all'
  const ch = (!channel || channel === 'both') ? 'all' : channel;
  const params = { from, to, channel: ch, ...(country ? { country } : {}) };
  const { data, loading } = useApi(`/api/product-breakdown/pnl/${encodeURIComponent(sku)}`, params);
  const [view, setView] = useState('total'); // 'total' | 'unit'

  if (loading) return <div style={{ padding: '20px', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (!data) return null;

  const s = data.currency_symbol || sym || '£';
  const netRev = parseFloat(data.revenue.net_revenue || 0);
  const units = data.units || 1;

  const divide = (n) => view === 'unit' ? parseFloat(n || 0) / Math.max(units, 1) : parseFloat(n || 0);
  const pct = (n) => netRev !== 0 ? (parseFloat(n || 0) / Math.abs(netRev) * 100) : 0;

  const fmtVal = (n, isBase) => {
    const v = divide(n);
    const p = pct(n);
    const color = v < 0 ? 'var(--red)' : isBase ? 'var(--text)' : v === 0 ? 'var(--muted)' : 'var(--text)';
    const pctColor = Math.abs(p) < 0.01 ? 'var(--muted)' : p < 0 ? '#f8717180' : '#6b6b80';
    const display = v < 0 ? `−${s}${Math.abs(v).toFixed(2)}` : `${s}${v.toFixed(2)}`;
    const pctDisplay = `(${p >= 0 ? '' : ''}${p.toFixed(1)}%)`;
    return (
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color, whiteSpace: 'nowrap' }}>
        {display} <span style={{ fontSize: 10, color: pctColor }}>{pctDisplay}</span>
      </span>
    );
  };

  const Row = ({ label, value, bold, indent, isBase }) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', padding: '5px 0', borderBottom: '1px solid var(--border)', paddingLeft: indent ? 16 : 0, alignItems: 'center' }}>
      <span style={{ fontSize: bold ? 13 : 12, fontWeight: bold ? 700 : 400, color: bold ? 'var(--text)' : 'var(--muted)' }}>{label}</span>
      {fmtVal(value, isBase)}
    </div>
  );

  const SectionHeader = ({ label }) => (
    <div style={{ padding: '10px 0 4px', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>{label}</div>
  );

  const profit = divide(data.gross_profit);
  const profitPct = pct(data.gross_profit);

  return (
    <div style={{ padding: '16px 20px', maxWidth: 500 }}>
      {/* Toggle */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {['total', 'unit'].map(v => (
          <button key={v} onClick={() => setView(v)}
            style={{ padding: '4px 14px', borderRadius: 6, fontSize: 11, fontWeight: 600, border: '1px solid ' + (view === v ? 'var(--accent)' : 'var(--border)'), background: view === v ? 'var(--accent)20' : 'transparent', color: view === v ? 'var(--accent2)' : 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s' }}>
            {v === 'total' ? 'Total' : 'Per Unit'}
          </button>
        ))}
        <span style={{ fontSize: 10, color: 'var(--muted)', alignSelf: 'center', marginLeft: 8 }}>% of net revenue</span>
      </div>

      <SectionHeader label="Revenue" />
      <Row label="Gross Revenue" value={data.revenue.gross_sales} bold isBase />
      {parseFloat(data.revenue.discounts) !== 0 && <Row label="Discounts / Promos" value={data.revenue.discounts} indent />}
      {parseFloat(data.revenue.refunds) !== 0 && <Row label="Refunds" value={data.revenue.refunds} indent />}
      <Row label="Net Revenue" value={data.revenue.net_revenue} bold />

      {data.has_fees && <>
        <SectionHeader label="Commissions & Fees" />
        {parseFloat(data.fees.commission) !== 0 && <Row label="Commission" value={data.fees.commission} indent />}
        {parseFloat(data.fees.fba_fulfillment) !== 0 && <Row label="FBA Fulfillment" value={data.fees.fba_fulfillment} indent />}
        {parseFloat(data.fees.fixed_closing) !== 0 && <Row label="Fixed Closing Fee" value={data.fees.fixed_closing} indent />}
        {parseFloat(data.fees.variable_closing) !== 0 && <Row label="Variable Closing Fee" value={data.fees.variable_closing} indent />}
        {parseFloat(data.fees.digital_services) !== 0 && <Row label="Digital Services" value={data.fees.digital_services} indent />}
        {parseFloat(data.fees.giftwrap) !== 0 && <Row label="Giftwrap Chargeback" value={data.fees.giftwrap} indent />}
        {parseFloat(data.fees.shipping_chargeback) !== 0 && <Row label="Shipping Chargeback" value={data.fees.shipping_chargeback} indent />}
        <Row label="Total Fees" value={data.fees.total} bold />
      </>}

      {data.has_cogs && <>
        <SectionHeader label="Cost of Goods" />
        {parseFloat(data.cogs.standard) !== 0 && <Row label="Standard COGS" value={data.cogs.standard} indent />}
        {parseFloat(data.cogs.freight) !== 0 && <Row label="Freight" value={data.cogs.freight} indent />}
        {parseFloat(data.cogs.demurrage) !== 0 && <Row label="Demurrage / Duties" value={data.cogs.demurrage} indent />}
        {parseFloat(data.cogs.quality) !== 0 && <Row label="Quality / Inspection" value={data.cogs.quality} indent />}
        {parseFloat(data.cogs.other) !== 0 && <Row label="Other COGS" value={data.cogs.other} indent />}
        <Row label="Total COGS" value={data.cogs.total} bold />
      </>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', padding: '10px 12px', marginTop: 10, borderRadius: 8, background: profit >= 0 ? '#34d39920' : '#f8717120', border: '1px solid ' + (profit >= 0 ? '#34d39940' : '#f8717140'), alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}>Gross Profit</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: profit >= 0 ? 'var(--green)' : 'var(--red)', whiteSpace: 'nowrap' }}>
          {profit < 0 ? `−${s}${Math.abs(profit).toFixed(2)}` : `${s}${profit.toFixed(2)}`}
          {' '}<span style={{ fontSize: 11, fontWeight: 400 }}>({profitPct.toFixed(1)}%)</span>
        </span>
      </div>
    </div>
  );
}

// Country flag via flagcdn.com (reliable cross-platform rendering)
const CountryFlag = ({ code }) => {
  if (!code || code === 'Unknown') return <span style={{ fontSize: 16 }}>🌐</span>;
  const lower = code.toLowerCase();
  return <img src={`https://flagcdn.com/20x15/${lower}.png`} alt={code} style={{ width: 20, height: 15, borderRadius: 2, objectFit: 'cover', flexShrink: 0 }} onError={e => { e.target.style.display = 'none'; }} />;
};

function CountryDropdown({ sku, from, to, channel, fmt, fmtPct, sym }) {
  const { data, loading } = useApi('/api/product-breakdown/countries', { sku, from, to, channel });
  const [openPnl, setOpenPnl] = useState(null);

  // Merge rows by country — blend amazon + shopify into one row per country
  const blended = useMemo(() => {
    if (!data?.length) return [];
    const map = new Map();
    for (const r of data) {
      const key = r.country;
      if (!map.has(key)) {
        map.set(key, { ...r, channels: new Set([r.channel]) });
      } else {
        const existing = map.get(key);
        existing.channels.add(r.channel);
        existing.units_sold    = (parseInt(existing.units_sold) + parseInt(r.units_sold));
        existing.gross_sales   = (parseFloat(existing.gross_sales) + parseFloat(r.gross_sales)).toFixed(2);
        existing.net_revenue   = (parseFloat(existing.net_revenue) + parseFloat(r.net_revenue)).toFixed(2);
        existing.gross_profit  = (parseFloat(existing.gross_profit) + parseFloat(r.gross_profit)).toFixed(2);
        existing.total_fees    = (parseFloat(existing.total_fees) + parseFloat(r.total_fees)).toFixed(2);
        existing.total_cogs    = (parseFloat(existing.total_cogs) + parseFloat(r.total_cogs)).toFixed(2);
        existing.has_cogs      = existing.has_cogs || r.has_cogs;
      }
    }
    // Recompute margin on blended figures
    return [...map.values()].map(r => {
      const net  = parseFloat(r.net_revenue);
      const prof = parseFloat(r.gross_profit);
      const pct  = net > 0 ? (prof / net * 100).toFixed(1) : '0.0';
      return { ...r, gross_margin_pct: pct, profit_pct: pct, channel: [...r.channels].join('+') };
    }).sort((a, b) => parseFloat(b.gross_sales) - parseFloat(a.gross_sales));
  }, [data]);

  if (loading) return <div style={{ padding: '12px 0', color: 'var(--muted)', fontSize: 12 }}>Loading…</div>;
  if (!blended.length) return <div style={{ padding: '12px 0', color: 'var(--muted)', fontSize: 12 }}>No data</div>;

  const GRID = '1fr 90px 100px 80px 80px 90px 70px 110px 100px';

  return (
    <div>
      {/* Sub-header */}
      <div style={{ display: 'grid', gridTemplateColumns: GRID, padding: '6px 0 4px', borderBottom: '1px solid var(--border)', marginBottom: 2 }}>
        {['Country', 'Units', 'Revenue', 'Margin %', 'Profit %', 'Profit £', 'ROI', 'ACOS', ''].map((h, i) => (
          <span key={i} style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 8px' }}>{h}</span>
        ))}
      </div>

      {blended.map((c, i) => (
        <div key={i}>
          <div style={{ display: 'grid', gridTemplateColumns: GRID, padding: '7px 0', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
            {/* Country */}
            <div style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <CountryFlag code={c.country} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{c.country}</span>
            </div>
            {/* Units */}
            <div style={{ padding: '0 8px', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{fmtN(c.units_sold)}</div>
            {/* Revenue */}
            <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--accent2)', fontWeight: 700 }}>{fmt(c.gross_sales)}</span>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmt(c.net_revenue)}</span>
            </div>
            {/* Margin % */}
            <div style={{ padding: '0 8px' }}>
              {c.has_cogs
                ? <span style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 700, color: parseFloat(c.gross_margin_pct) >= 20 ? 'var(--green)' : parseFloat(c.gross_margin_pct) >= 10 ? 'var(--amber)' : 'var(--red)' }}>{fmtPct(c.gross_margin_pct)}</span>
                : <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>}
            </div>
            {/* Profit % */}
            <div style={{ padding: '0 8px' }}>
              {c.has_cogs
                ? <span style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 700, color: parseFloat(c.profit_pct) >= 15 ? 'var(--green)' : parseFloat(c.profit_pct) >= 5 ? 'var(--amber)' : 'var(--red)' }}>{fmtPct(c.profit_pct)}</span>
                : <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>}
            </div>
            {/* Profit £ */}
            <div style={{ padding: '0 8px' }}>
              {c.has_cogs
                ? <span style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 700, color: parseFloat(c.gross_profit) >= 0 ? 'var(--text)' : 'var(--red)' }}>{fmt(c.gross_profit)}</span>
                : <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>}
            </div>
            {/* ROI */}
            <div style={{ padding: '0 8px', fontSize: 11, color: 'var(--muted)' }}>—</div>
            {/* ACOS */}
            <div style={{ padding: '0 8px', fontSize: 11, color: 'var(--muted)' }}>—</div>
            {/* Breakdown */}
            <div style={{ padding: '0 8px' }}>
              <button onClick={() => setOpenPnl(openPnl === i ? null : i)}
                style={{ padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, border: '1px solid ' + (openPnl === i ? 'var(--accent)' : 'var(--border)'), background: openPnl === i ? 'var(--accent)20' : 'var(--bg3)', color: openPnl === i ? 'var(--accent2)' : 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s', whiteSpace: 'nowrap' }}>
                Breakdown
              </button>
            </div>
          </div>
          {openPnl === i && (
            <div style={{ borderBottom: '1px solid var(--border)', background: '#ffffff02' }}>
              <PnlPanel sku={sku} from={from} to={to} sym={sym} country={c.country} channel={channel} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ProductBreakdown() {
  const [range, setRange] = useState(() => {
    try { const s = localStorage.getItem('gb_prod_range'); return s ? JSON.parse(s) : getRange({ days: 30 }); } catch { return getRange({ days: 30 }); }
  });
  const [channel, setChannel] = useState(() => localStorage.getItem('gb_prod_channel') || 'all');
  const [sort, setSort] = useState(() => localStorage.getItem('gb_prod_sort') || 'gross_sales');
  const [dir, setDir] = useState(() => localStorage.getItem('gb_prod_dir') || 'desc');
  const [expandedSku, setExpandedSku] = useState(null);
  const [expandedPnl, setExpandedPnl] = useState(null);
  const [brandFilter, setBrandFilter] = useState('');
  const [parentFilter, setParentFilter] = useState('');

  const handleRange = (r) => { setRange(r); localStorage.setItem('gb_prod_range', JSON.stringify(r)); };
  const handleChannel = (c) => { setChannel(c); localStorage.setItem('gb_prod_channel', c); };
  const params = { ...range, channel, sort, dir, ...(brandFilter ? { brand: brandFilter } : {}), ...(parentFilter ? { parent_asin: parentFilter } : {}) };

  const { data: rows, loading } = useApi('/api/product-breakdown', params);
  const { data: config } = useApi('/api/settings/config');
  const { data: brandsData } = useApi('/api/brands');

  const sym = { GBP: '£', USD: '$', EUR: '€' }[config?.reporting_currency] || '£';
  const fmt = useMemo(() => makeFmt(sym), [sym]);

  const totals = useMemo(() => {
    if (!rows?.length) return {};
    return {
      units_sold:      rows.reduce((s, r) => s + parseInt(r.units_sold || 0), 0),
      gross_sales:     rows.reduce((s, r) => s + parseFloat(r.gross_sales || 0), 0),
      total_discounts: rows.reduce((s, r) => s + parseFloat(r.total_discounts || 0), 0),
      total_refunded:  rows.reduce((s, r) => s + parseFloat(r.total_refunded || 0), 0),
      net_revenue:     rows.reduce((s, r) => s + parseFloat(r.net_revenue || 0), 0),
      gross_profit:    rows.reduce((s, r) => s + parseFloat(r.gross_profit || 0), 0),
      skus:            rows.length,
    };
  }, [rows]);

  const totalMargin = totals.net_revenue > 0 ? (totals.gross_profit / totals.net_revenue * 100) : 0;

  const handleSort = (key) => {
    if (sort === key) {
      const newDir = dir === 'desc' ? 'asc' : 'desc';
      setDir(newDir); localStorage.setItem('gb_prod_dir', newDir);
    } else {
      setSort(key); setDir('desc');
      localStorage.setItem('gb_prod_sort', key); localStorage.setItem('gb_prod_dir', 'desc');
    }
  };

  const SortIcon = ({ col }) => {
    if (sort !== col) return <span style={{ opacity: 0.3, fontSize: 9 }}>↕</span>;
    return <span style={{ color: 'var(--accent2)', fontSize: 9 }}>{dir === 'desc' ? '↓' : '↑'}</span>;
  };

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Product Breakdown</h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Revenue, margin and profit by SKU across all channels</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
            {CHANNELS.map(c => (
              <button key={c.id} onClick={() => handleChannel(c.id)} style={channelBtn(channel === c.id)}>{c.label}</button>
            ))}
          </div>
          {brandsData?.brands?.length > 0 && (
            <select value={brandFilter} onChange={e => setBrandFilter(e.target.value)}
              style={{ background: 'var(--bg2)', border: '1px solid ' + (brandFilter ? 'var(--accent)' : 'var(--border)'), borderRadius: 8, padding: '6px 12px', color: brandFilter ? 'var(--accent2)' : 'var(--muted)', fontSize: 12, fontFamily: 'var(--font)', cursor: 'pointer', fontWeight: 600 }}>
              <option value="">All Brands</option>
              {brandsData.brands.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          {brandsData?.parent_asins?.length > 0 && (
            <select value={parentFilter} onChange={e => setParentFilter(e.target.value)}
              style={{ background: 'var(--bg2)', border: '1px solid ' + (parentFilter ? 'var(--accent)' : 'var(--border)'), borderRadius: 8, padding: '6px 12px', color: parentFilter ? 'var(--accent2)' : 'var(--muted)', fontSize: 12, fontFamily: 'var(--font)', cursor: 'pointer', fontWeight: 600 }}>
              <option value="">All Parent ASINs</option>
              {brandsData.parent_asins.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          <DateRangePicker value={range} onChange={handleRange} />
        </div>
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
        <KpiCard label="SKUs" value={totals.skus} type="number" color="#7c6af7" />
        <KpiCard label="Units Sold" value={totals.units_sold} type="number" color="#fbbf24" />
        <KpiCard label="Gross Revenue" value={totals.gross_sales} type="currency" color="#7c6af7" symbol={sym} />
        <KpiCard label="Net Revenue" value={totals.net_revenue} type="currency" color="#34d399" symbol={sym} />
        <KpiCard label="Gross Profit" value={totals.gross_profit} type="currency" color="#34d399" symbol={sym} />
        <KpiCard label="Gross Margin" value={totalMargin} type="percent" color={totalMargin > 20 ? '#34d399' : '#f87171'} />
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {/* Header row */}
        <div style={{ display: 'grid', gridTemplateColumns: '36px minmax(0,1fr) 90px 100px 80px 80px 90px 70px 110px 100px', borderBottom: '1px solid var(--border)', background: 'var(--bg3)' }}>
          <div />
          {COLS.filter(c => c.key !== 'expand').map(col => (
            <div key={col.key} onClick={() => col.sortable && handleSort(col.key)}
              style={{ padding: '11px 8px', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: col.sortable ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none', color: sort === col.key ? 'var(--accent2)' : 'var(--muted)' }}>
              {col.label} {col.sortable && <SortIcon col={col.key} />}
            </div>
          ))}
        </div>

        {loading && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}
        {!loading && !rows?.length && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No products found for this period</div>}

        {!loading && rows?.map((row, i) => {
          const expanded = expandedSku === row.sku;
          const netRev = parseFloat(row.net_revenue || 0);
          const grossProfit = parseFloat(row.gross_profit || 0);
          const marginPct = parseFloat(row.gross_margin_pct || 0);
          const profitPct = parseFloat(row.profit_pct || 0);
          const hasCogs = parseFloat(row.total_cogs || 0) > 0;

          return (
            <div key={row.sku} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none', borderLeft: expanded ? '3px solid #34d399' : '3px solid transparent', transition: 'border-color 0.15s' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '36px minmax(0,1fr) 90px 100px 80px 80px 90px 70px 110px 100px', background: expanded ? '#ffffff05' : 'transparent', transition: 'background 0.1s' }}
                onMouseEnter={e => !expanded && (e.currentTarget.style.background = '#ffffff03')}
                onMouseLeave={e => !expanded && (e.currentTarget.style.background = 'transparent')}>

                {/* Expand toggle */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <button onClick={() => setExpandedSku(expanded ? null : row.sku)}
                    style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid ' + (expanded ? '#34d399' : 'var(--border)'), background: expanded ? '#34d39920' : 'var(--bg3)', color: expanded ? '#34d399' : 'var(--muted)', cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 }}>
                    {expanded ? '−' : '+'}
                  </button>
                </div>
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {row.image_url ? <img src={row.image_url} alt={row.sku} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 16, opacity: 0.2 }}>◉</span>}
                  </div>
                  <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.product_title}>{row.product_title || row.sku}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.sku}</div>
                    {row.asin && <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.asin}</div>}
                  </div>
                </div>

                {/* Units */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--mono)' }}>{fmtN(row.units_sold)}</span>
                  {row.units_refunded > 0 && (
                    <span style={{ fontSize: 11, color: 'var(--red)', fontFamily: 'var(--mono)' }}>
                      −{fmtN(row.units_refunded)} ({parseFloat(row.units_refunded / row.units_sold * 100).toFixed(0)}%)
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>— organic</span>
                  <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>— ppc</span>
                </div>

                {/* Revenue */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmt(row.gross_sales)}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{fmt(row.net_revenue)}</span>
                </div>

                {/* Margin % */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
                  {hasCogs ? (
                    <>
                      <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--mono)', color: marginPct >= 20 ? 'var(--green)' : marginPct >= 10 ? 'var(--amber)' : 'var(--red)' }}>{fmtPct(marginPct)}</span>
                      <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>gross</span>
                    </>
                  ) : <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>}
                </div>

                {/* Profit % */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
                  {hasCogs ? (
                    <>
                      <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--mono)', color: profitPct >= 15 ? 'var(--green)' : profitPct >= 5 ? 'var(--amber)' : 'var(--red)' }}>{fmtPct(profitPct)}</span>
                      <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>net</span>
                    </>
                  ) : <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>}
                </div>

                {/* Profit £ */}
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  {hasCogs ? (
                    <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--mono)', color: grossProfit >= 0 ? 'var(--text)' : 'var(--red)' }}>{fmt(grossProfit)}</span>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>No COGS</span>
                  )}
                </div>

                {/* ROI */}
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span>
                </div>

                {/* ACOS */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>TACOS: —</span>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>ROAS: —</span>
                </div>

                {/* Channel + Breakdown button */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'center' }}>
                  {channelBadge(row.channels)}
                  <button
                    onClick={() => { setExpandedPnl(expandedPnl === row.sku ? null : row.sku); setExpandedSku(null); }}
                    style={{ padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, border: '1px solid ' + (expandedPnl === row.sku ? 'var(--accent)' : 'var(--border)'), background: expandedPnl === row.sku ? 'var(--accent)20' : 'var(--bg3)', color: expandedPnl === row.sku ? 'var(--accent2)' : 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s', whiteSpace: 'nowrap' }}>
                    Breakdown
                  </button>
                </div>
              </div>

              {/* Country expansion */}
              {expandedSku === row.sku && (
                <div style={{ padding: '12px 16px 16px 52px', borderTop: '1px solid var(--border)', background: '#ffffff03' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>Country Breakdown</div>
                  <CountryDropdown sku={row.sku} from={range.from} to={range.to} channel={channel} fmt={fmt} fmtPct={fmtPct} sym={sym} />
                </div>
              )}

              {/* P&L breakdown panel */}
              {expandedPnl === row.sku && (
                <div style={{ borderTop: '1px solid var(--border)', background: '#ffffff03' }}>
                  <PnlPanel sku={row.sku} from={range.from} to={range.to} sym={sym} channel={row.channels} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
