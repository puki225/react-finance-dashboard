import React, { useState, useMemo } from 'react';
import KpiCard from '../components/KpiCard';
import DateRangePicker, { getRange } from '../components/DateRangePicker';
import { useApi } from '../hooks/useApi';

const fmt = (n) => '£' + parseFloat(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN = (n) => parseInt(n || 0).toLocaleString('en-GB');
const fmtPct = (a, b) => b > 0 ? ((parseFloat(a) / parseFloat(b)) * 100).toFixed(1) + '%' : '—';

const CHANNELS = [{ id: 'all', label: 'All' }, { id: 'shopify', label: 'Shopify' }, { id: 'amazon', label: 'Amazon' }];
const channelBtn = (active) => ({
  padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
  border: '1px solid ' + (active ? 'var(--accent2)' : 'var(--border)'),
  background: active ? 'var(--accent2)20' : 'transparent',
  color: active ? 'var(--accent2)' : 'var(--muted)',
  cursor: 'pointer', fontFamily: 'var(--font)', letterSpacing: '0.04em', transition: 'all 0.15s',
});

const COLS = [
  { key: 'product_title', label: 'Product', sortable: false, width: '28%' },
  { key: 'units_sold',    label: 'Units',   sortable: true,  width: '8%'  },
  { key: 'gross_sales',   label: 'Gross',   sortable: true,  width: '11%' },
  { key: 'total_discounts', label: 'Discounts', sortable: true, width: '10%' },
  { key: 'total_refunded', label: 'Refunds', sortable: true,  width: '11%' },
  { key: 'net_revenue',   label: 'Net Revenue', sortable: true, width: '11%' },
  { key: 'channels',      label: 'Channel', sortable: false, width: '8%'  },
  { key: 'country',       label: 'Country', sortable: false, width: '13%' },
];

const channelBadge = (ch) => {
  const map = {
    both:    { bg: '#7c6af720', color: '#a78bfa', label: 'Both'    },
    shopify: { bg: '#7c6af720', color: '#a78bfa', label: 'Shopify' },
    amazon:  { bg: '#fbbf2420', color: '#fbbf24', label: 'Amazon'  },
  };
  const s = map[ch] || map.shopify;
  return <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: s.bg, color: s.color, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{s.label}</span>;
};

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
          <span style={{ fontSize: 11, color: 'var(--green)', fontFamily: 'var(--mono)', marginLeft: 'auto' }}>{fmt(c.gross_sales)}</span>
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

  const handleRange = (r) => { setRange(r); localStorage.setItem('gb_prod_range', JSON.stringify(r)); };
  const handleChannel = (c) => { setChannel(c); localStorage.setItem('gb_prod_channel', c); };
  const params = { ...range, channel, sort, dir };

  const { data: rows, loading } = useApi('/api/product-breakdown', params);

  const totals = useMemo(() => {
    if (!rows?.length) return {};
    return {
      units_sold:      rows.reduce((s, r) => s + parseInt(r.units_sold || 0), 0),
      gross_sales:     rows.reduce((s, r) => s + parseFloat(r.gross_sales || 0), 0),
      total_discounts: rows.reduce((s, r) => s + parseFloat(r.total_discounts || 0), 0),
      total_refunded:  rows.reduce((s, r) => s + parseFloat(r.total_refunded || 0), 0),
      net_revenue:     rows.reduce((s, r) => s + parseFloat(r.net_revenue || 0), 0),
      skus:            rows.length,
    };
  }, [rows]);

  const handleSort = (key) => {
    if (sort === key) {
      const newDir = dir === 'desc' ? 'asc' : 'desc';
      setDir(newDir);
      localStorage.setItem('gb_prod_dir', newDir);
    } else {
      setSort(key);
      setDir('desc');
      localStorage.setItem('gb_prod_sort', key);
      localStorage.setItem('gb_prod_dir', 'desc');
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
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Revenue by SKU across all channels</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 4 }}>
            {CHANNELS.map(c => (
              <button key={c.id} onClick={() => handleChannel(c.id)} style={channelBtn(channel === c.id)}>{c.label}</button>
            ))}
          </div>
          <DateRangePicker value={range} onChange={handleRange} />
        </div>
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
        <KpiCard label="SKUs" value={totals.skus} type="number" color="#7c6af7" />
        <KpiCard label="Units Sold" value={totals.units_sold} type="number" color="#fbbf24" />
        <KpiCard label="Gross Revenue" value={totals.gross_sales} type="currency" color="#7c6af7" />
        <KpiCard label="Discounts" value={totals.total_discounts} type="currency" color="#fbbf24" />
        <KpiCard label="Refunds" value={totals.total_refunded} type="currency" color="#f87171" />
        <KpiCard label="Net Revenue" value={totals.net_revenue} type="currency" color="#34d399" />
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {/* Table header */}
        <div style={{ display: 'grid', gridTemplateColumns: COLS.map(c => c.width).join(' '), borderBottom: '1px solid var(--border)', padding: '0 20px' }}>
          {COLS.map(col => (
            <div
              key={col.key}
              onClick={() => col.sortable && handleSort(col.key)}
              style={{
                padding: '12px 8px', fontSize: 11, fontWeight: 600, color: 'var(--muted)',
                letterSpacing: '0.06em', textTransform: 'uppercase', cursor: col.sortable ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none',
                color: sort === col.key ? 'var(--accent2)' : 'var(--muted)',
              }}
            >
              {col.label} {col.sortable && <SortIcon col={col.key} />}
            </div>
          ))}
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        )}

        {/* Empty */}
        {!loading && !rows?.length && (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No products found for this period</div>
        )}

        {/* Rows */}
        {!loading && rows?.map((row, i) => {
          const expanded = expandedSku === row.sku;
          const refundPct = fmtPct(row.units_refunded, row.units_sold);
          return (
            <div
              key={row.sku}
              style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none' }}
            >
              {/* Main row */}
              <div
                style={{
                  display: 'grid', gridTemplateColumns: COLS.map(c => c.width).join(' '),
                  padding: '0 20px', transition: 'background 0.1s',
                  background: expanded ? '#ffffff05' : 'transparent',
                }}
                onMouseEnter={e => !expanded && (e.currentTarget.style.background = '#ffffff03')}
                onMouseLeave={e => !expanded && (e.currentTarget.style.background = 'transparent')}
              >
                {/* Product */}
                <div style={{ padding: '14px 8px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  {/* Image */}
                  <div style={{ width: 48, height: 48, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {row.image_url
                      ? <img src={row.image_url} alt={row.sku} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      : <span style={{ fontSize: 18, opacity: 0.2 }}>◉</span>
                    }
                  </div>
                  {/* SKU + ASIN */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }} title={row.product_title}>{row.product_title || row.sku}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{row.sku}</span>
                    {row.asin && <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{row.asin}</span>}
                  </div>
                </div>

                {/* Units */}
                <div style={{ padding: '14px 8px', display: 'flex', flexDirection: 'column', gap: 2, justifyContent: 'center' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--mono)' }}>{fmtN(row.units_sold)}</span>
                  {row.units_refunded > 0 && (
                    <span style={{ fontSize: 11, color: '#f87171', fontFamily: 'var(--mono)' }}>
                      −{fmtN(row.units_refunded)} ({refundPct})
                    </span>
                  )}
                </div>

                {/* Gross */}
                <div style={{ padding: '14px 8px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontFamily: 'var(--mono)', color: '#a78bfa' }}>{fmt(row.gross_sales)}</span>
                </div>

                {/* Discounts */}
                <div style={{ padding: '14px 8px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontFamily: 'var(--mono)', color: parseFloat(row.total_discounts) > 0 ? '#fbbf24' : 'var(--muted)' }}>
                    {parseFloat(row.total_discounts) > 0 ? `−${fmt(row.total_discounts)}` : '—'}
                  </span>
                </div>

                {/* Refunds */}
                <div style={{ padding: '14px 8px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontFamily: 'var(--mono)', color: parseFloat(row.total_refunded) > 0 ? '#f87171' : 'var(--muted)' }}>
                    {parseFloat(row.total_refunded) > 0 ? `−${fmt(row.total_refunded)}` : '—'}
                  </span>
                </div>

                {/* Net Revenue */}
                <div style={{ padding: '14px 8px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--mono)', color: parseFloat(row.net_revenue) < 0 ? '#f87171' : '#34d399' }}>
                    {fmt(row.net_revenue)}
                  </span>
                </div>

                {/* Channel */}
                <div style={{ padding: '14px 8px', display: 'flex', alignItems: 'center' }}>
                  {channelBadge(row.channels)}
                </div>

                {/* Country expand */}
                <div style={{ padding: '14px 8px', display: 'flex', alignItems: 'center' }}>
                  <button
                    onClick={() => setExpandedSku(expanded ? null : row.sku)}
                    style={{
                      background: expanded ? 'var(--accent)20' : 'var(--bg3)',
                      border: '1px solid ' + (expanded ? 'var(--accent)' : 'var(--border)'),
                      borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 600,
                      color: expanded ? 'var(--accent2)' : 'var(--muted)',
                      cursor: 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s',
                    }}
                  >
                    {expanded ? 'Hide ▲' : 'Countries ▼'}
                  </button>
                </div>
              </div>

              {/* Country expansion */}
              {expanded && (
                <div style={{
                  padding: '0 20px 16px', marginLeft: COLS[0].width,
                  borderTop: '1px solid var(--border)', background: '#ffffff03',
                }}>
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
