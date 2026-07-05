import React, { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';

const fmtN = (n) => parseInt(n || 0).toLocaleString('en-GB');

function ProductImage({ sku, imageUrl }) {
  return (
    <div style={{ width: 48, height: 48, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {imageUrl ? <img src={imageUrl} alt={sku} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 18, opacity: 0.2 }}>◉</span>}
    </div>
  );
}

const COLS = [
  { key: 'product_title', label: 'Product',  sortable: false, width: '1fr' },
  { key: 'sellable',      label: 'Sellable',  sortable: true,  width: '110px' },
  { key: 'inbound',       label: 'Inbound',   sortable: true,  width: '110px' },
  { key: 'damaged',       label: 'Damaged',   sortable: true,  width: '110px' },
  { key: 'other',         label: 'Other',     sortable: true,  width: '110px' },
  { key: 'total',         label: 'Total',     sortable: true,  width: '110px' },
];
const TABLE_GRID = 'minmax(160px,1fr) 110px 110px 110px 110px 110px';
const TABLE_MIN_WIDTH = 160 + 110 * 5;

export default function Inventory() {
  const isMobile = useIsMobile();
  const [sort, setSort] = useState('total');
  const [dir, setDir] = useState('desc');
  const { data: rows, loading } = useApi('/api/inventory');

  const handleSort = (key) => {
    if (sort === key) setDir(dir === 'desc' ? 'asc' : 'desc');
    else { setSort(key); setDir('desc'); }
  };

  const SortIcon = ({ col }) => {
    if (sort !== col) return <span style={{ opacity: 0.3, fontSize: 9 }}>↕</span>;
    return <span style={{ color: 'var(--accent2)', fontSize: 9 }}>{dir === 'desc' ? '↓' : '↑'}</span>;
  };

  const sortedRows = React.useMemo(() => {
    if (!rows?.length) return [];
    const mult = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort === 'product_title') return (a.product_title || a.sku).localeCompare(b.product_title || b.sku) * mult;
      return (parseInt(a[sort] || 0) - parseInt(b[sort] || 0)) * mult;
    });
  }, [rows, sort, dir]);

  return (
    <div style={{ padding: isMobile ? '16px' : '28px 32px', display: 'flex', flexDirection: 'column', gap: isMobile ? 18 : 24 }}>

      {/* Header */}
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Inventory</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Latest FBA stock levels by SKU</p>
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: TABLE_MIN_WIDTH }}>
            {/* Header row */}
            <div style={{ display: 'grid', gridTemplateColumns: TABLE_GRID, borderBottom: '1px solid var(--border)', background: 'var(--bg3)' }}>
              {COLS.map(col => (
                <div key={col.key} onClick={() => col.sortable && handleSort(col.key)}
                  style={{ padding: '11px 8px', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: col.sortable ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none', color: sort === col.key ? 'var(--accent2)' : 'var(--muted)' }}>
                  {col.label} {col.sortable && <SortIcon col={col.key} />}
                </div>
              ))}
            </div>

            {loading && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}
            {!loading && !sortedRows.length && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No inventory data yet</div>}

            {!loading && sortedRows.map((row, i) => (
              <div key={row.sku} style={{ display: 'grid', gridTemplateColumns: TABLE_GRID, borderBottom: i < sortedRows.length - 1 ? '1px solid var(--border)' : 'none' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#ffffff03')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>

                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, overflow: 'hidden' }}>
                  <ProductImage sku={row.sku} imageUrl={row.image_url} />
                  <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.sku}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.product_title || row.asin || '—'}</div>
                  </div>
                </div>

                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--mono)' }}>{fmtN(row.sellable)}</span>
                </div>
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 15, fontFamily: 'var(--mono)', color: row.inbound > 0 ? 'var(--text)' : 'var(--muted)' }}>{fmtN(row.inbound)}</span>
                </div>
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 15, fontFamily: 'var(--mono)', color: row.damaged > 0 ? 'var(--red)' : 'var(--muted)' }}>{fmtN(row.damaged)}</span>
                </div>
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 15, fontFamily: 'var(--mono)', color: row.other > 0 ? 'var(--text)' : 'var(--muted)' }}>{fmtN(row.other)}</span>
                </div>
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtN(row.total)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
