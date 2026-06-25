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
  { key: 'product_title', label: 'Product',        sortable: false, width: '22%' },
  { key: 'units_sold',    label: 'Units',           sortable: true,  width: '10%' },
  { key: 'gross_sales',   label: 'Revenue',         sortable: true,  width: '11%' },
  { key: 'gross_profit',  label: 'Profit £',        sortable: true,  width: '9%'  },
  { key: 'gross_margin_pct', label: 'Margin %',     sortable: true,  width: '8%'  },
  { key: 'profit_pct',    label: 'Profit %',        sortable: false, width: '8%'  },
  { key: 'roi',           label: 'ROI',             sortable: false, width: '7%'  },
  { key: 'acos',          label: 'ACOS',            sortable: false, width: '11%' },
  { key: 'channels',      label: 'Channel',         sortable: false, width: '7%'  },
  { key: 'country',       label: 'Countries',       sortable: false, width: '7%'  },
];

function CountryDropdown({ sku, from, to, channel }) {
  const { data, loading } = useApi('/api/product-breakdown/countries', { sku, from, to, channel });
  if (loading) return <span style={{ fontSize: 11, color: 'var(--muted)' }}>Loading…</span>;
  if (!data?.length) return <span style={{ fontSize: 11, color: 'var(--muted)' }}>No data</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 12, paddingBottom: 4 }}>
      {data.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', minWidth: 28, fontFamily: 'var(--mono)' }}>{c.country}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{fmtN(c.units_sold)} units</span>
          {channelBadge(c.channel)}
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
        <div style={{ display: 'grid', gridTemplateColumns: COLS.map(c => c.width).join(' '), borderBottom: '1px solid var(--border)', padding: '0 16px', background: 'var(--bg3)' }}>
          {COLS.map(col => (
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
            <div key={row.sku} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div style={{ display: 'grid', gridTemplateColumns: COLS.map(c => c.width).join(' '), padding: '0 16px', background: expanded ? '#ffffff05' : 'transparent', transition: 'background 0.1s' }}
                onMouseEnter={e => !expanded && (e.currentTarget.style.background = '#ffffff03')}
                onMouseLeave={e => !expanded && (e.currentTarget.style.background = 'transparent')}>

                {/* Product */}
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {row.image_url ? <img src={row.image_url} alt={row.sku} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 16, opacity: 0.2 }}>◉</span>}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.product_title}>{row.product_title || row.sku}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>{row.sku}</div>
                    {row.asin && <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{row.asin}</div>}
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

                {/* Profit £ */}
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  {hasCogs ? (
                    <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--mono)', color: grossProfit >= 0 ? 'var(--text)' : 'var(--red)' }}>{fmt(grossProfit)}</span>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>No COGS</span>
                  )}
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

                {/* Channel */}
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  {channelBadge(row.channels)}
                </div>

                {/* Countries */}
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  <button onClick={() => setExpandedSku(expanded ? null : row.sku)}
                    style={{ background: expanded ? 'var(--accent)20' : 'var(--bg3)', border: '1px solid ' + (expanded ? 'var(--accent)' : 'var(--border)'), borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 600, color: expanded ? 'var(--accent2)' : 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s' }}>
                    {expanded ? 'Hide ▲' : '▼'}
                  </button>
                </div>
              </div>

              {/* Country expansion */}
              {expanded && (
                <div style={{ padding: '0 16px 14px', marginLeft: COLS[0].width, borderTop: '1px solid var(--border)', background: '#ffffff03' }}>
                  <CountryDropdown sku={row.sku} from={range.from} to={range.to} channel={channel} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
