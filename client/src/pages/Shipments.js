import React, { useState, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';

const fmtN = (n) => parseInt(n || 0).toLocaleString('en-GB');
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
const fmtRelative = (iso) => {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

// Amazon's own v0 shipment status lifecycle - grouped into a coarser color signal since not
// every status is equally interesting to glance at (a few working/pending states share amber).
const STATUS_GROUPS = {
  WORKING: { label: 'Working', color: 'var(--muted)' },
  SHIPPED: { label: 'Shipped', color: '#fbbf24' },
  IN_TRANSIT: { label: 'In Transit', color: '#fbbf24' },
  DELIVERED: { label: 'Delivered', color: '#7c6af7' },
  CHECKED_IN: { label: 'Checked In', color: '#7c6af7' },
  RECEIVING: { label: 'Receiving', color: '#7c6af7' },
  CLOSED: { label: 'Closed', color: '#34d399' },
  CANCELLED: { label: 'Cancelled', color: '#f87171' },
  DELETED: { label: 'Deleted', color: '#f87171' },
  ERROR: { label: 'Error', color: '#f87171' },
};
const statusInfo = (s) => STATUS_GROUPS[s] || { label: s || 'Unknown', color: 'var(--muted)' };

const COLS = [
  { key: 'shipment_name', label: 'Shipment', width: '1fr' },
  { key: 'destination_fc', label: 'Destination FC', width: '140px' },
  { key: 'shipment_status', label: 'Status', width: '130px' },
  { key: 'confirmed_need_by_date', label: 'Need-By Date', width: '130px' },
  { key: 'units_shipped', label: 'Units Shipped', width: '120px' },
  { key: 'units_received', label: 'Units Received', width: '120px' },
];
const TABLE_GRID = 'minmax(180px,1fr) 140px 130px 130px 120px 120px';
const TABLE_MIN_WIDTH = 180 + 140 + 130 + 130 + 120 + 120;

export default function Shipments() {
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'open' | status key

  const { data, loading } = useApi('/api/shipments');
  const rows = data?.rows || [];
  const sync = data?.sync;

  const filteredRows = useMemo(() => {
    if (statusFilter === 'all') return rows;
    if (statusFilter === 'open') return rows.filter(r => !['CLOSED', 'CANCELLED', 'DELETED'].includes(r.shipment_status));
    return rows.filter(r => r.shipment_status === statusFilter);
  }, [rows, statusFilter]);

  const totals = useMemo(() => {
    return filteredRows.reduce((t, r) => {
      t.shipped += r.units_shipped || 0;
      t.received += r.units_received || 0;
      return t;
    }, { shipped: 0, received: 0 });
  }, [filteredRows]);

  return (
    <div style={{ padding: isMobile ? '16px' : '28px 32px', display: 'flex', flexDirection: 'column', gap: isMobile ? 18 : 24 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Shipments</h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Inbound FBA shipment pipeline, by shipment</p>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          {sync ? (
            <>
              Last synced {fmtRelative(sync.last_synced_at)}
              {sync.status === 'error' && <span style={{ color: '#f87171', marginLeft: 8 }}>· sync error: {sync.last_error}</span>}
            </>
          ) : 'Not synced yet'}
        </div>
      </div>

      {/* Status filter */}
      <div style={{ display: 'flex', gap: 4, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: 3, width: 'fit-content', flexWrap: 'wrap' }}>
        {[
          { id: 'all', label: 'All' },
          { id: 'open', label: 'Open' },
          ...Object.keys(STATUS_GROUPS).map(k => ({ id: k, label: STATUS_GROUPS[k].label })),
        ].map(s => (
          <button key={s.id} onClick={() => setStatusFilter(s.id)}
            style={{ padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600, border: 'none', background: statusFilter === s.id ? 'var(--accent)20' : 'transparent', color: statusFilter === s.id ? 'var(--accent2)' : 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font)' }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Totals */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--accent)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: TABLE_MIN_WIDTH, display: 'grid', gridTemplateColumns: TABLE_GRID }}>
            <div style={{ padding: '14px 8px', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>Shipments</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>({filteredRows.length})</span>
            </div>
            <div />
            <div />
            <div />
            <div style={{ padding: '14px 8px', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)' }}>{fmtN(totals.shipped)}</span>
            </div>
            <div style={{ padding: '14px 8px', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtN(totals.received)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: TABLE_MIN_WIDTH }}>
            <div style={{ display: 'grid', gridTemplateColumns: TABLE_GRID, borderBottom: '1px solid var(--border)', background: 'var(--bg3)' }}>
              {COLS.map(col => (
                <div key={col.key} style={{ padding: '11px 8px', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                  {col.label}
                </div>
              ))}
            </div>

            {loading && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}
            {!loading && !filteredRows.length && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No shipments synced yet</div>}

            {!loading && filteredRows.map((row, i) => {
              const isOpen = expanded === row.shipment_id;
              const status = statusInfo(row.shipment_status);
              return (
                <React.Fragment key={row.shipment_id}>
                  <div
                    onClick={() => setExpanded(isOpen ? null : row.shipment_id)}
                    style={{
                      display: 'grid', gridTemplateColumns: TABLE_GRID, cursor: 'pointer',
                      borderBottom: (isOpen || i < filteredRows.length - 1) ? '1px solid var(--border)' : 'none',
                      borderLeft: isOpen ? '3px solid #34d399' : '3px solid transparent',
                      background: isOpen ? '#ffffff05' : 'transparent',
                      transition: 'background 0.1s, border-color 0.15s',
                    }}
                    onMouseEnter={e => !isOpen && (e.currentTarget.style.background = '#ffffff03')}
                    onMouseLeave={e => !isOpen && (e.currentTarget.style.background = 'transparent')}>

                    <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0, overflow: 'hidden' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.shipment_name || row.shipment_id}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>{row.shipment_id}</div>
                    </div>
                    <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                      <span style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>{row.destination_fc || '—'}</span>
                    </div>
                    <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 4, background: status.color + '20', color: status.color }}>{status.label}</span>
                    </div>
                    <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                      <span style={{ fontSize: 13, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtDate(row.confirmed_need_by_date)}</span>
                    </div>
                    <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                      <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--mono)' }}>{fmtN(row.units_shipped)}</span>
                    </div>
                    <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                      <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtN(row.units_received)}</span>
                    </div>
                  </div>

                  {isOpen && (
                    <div style={{ padding: '4px 8px 16px 24px', borderBottom: i < filteredRows.length - 1 ? '1px solid var(--border)' : 'none', background: '#ffffff03' }}>
                      {!row.items.length ? (
                        <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>No line-item detail synced for this shipment</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                          {row.items.map(item => (
                            <div key={item.sku} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 100px', gap: 8, padding: '6px 8px', fontSize: 12, borderRadius: 6 }}>
                              <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {item.product_title || item.sku}
                              </span>
                              <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtN(item.quantity_shipped)} shipped</span>
                              <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmtN(item.quantity_received)} received</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
