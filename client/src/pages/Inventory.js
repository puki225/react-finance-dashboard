import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';

const fmtN = (n) => parseInt(n || 0).toLocaleString('en-GB');
const makeFmt = (symbol = '£') => (n) => symbol + parseFloat(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// snapshot_date values are month-starts ("YYYY-MM-01") for backfilled history and plain dates
// for live daily snapshots - pinned to UTC so labels can't shift a day in behind-UTC timezones.
const fmtTick = (d) => { if (!d) return ''; const date = new Date(d); return date.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }); };
const fmtDateFull = (d) => { if (!d) return ''; return new Date(d).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };

// Same auto-scale pattern as SalesSummary's revenue trend chart - a tight-fitting domain
// (10% padding, rounded to a clean step) instead of Recharts' default [0, auto], which forces
// a zero baseline and flattens the visible variation for a series that never gets near zero.
function computeDomain(data, key) {
  if (!data?.length) return ['auto', 'auto'];
  let min = Infinity, max = -Infinity;
  for (const row of data) { const v = parseFloat(row[key] || 0); if (v < min) min = v; if (v > max) max = v; }
  if (!isFinite(min) || !isFinite(max)) return ['auto', 'auto'];
  const pad = (max - min) * 0.1 || max * 0.1 || 10;
  const step = max > 1000 ? 100 : max > 100 ? 10 : 1;
  return [Math.max(0, Math.floor((min - pad) / step) * step), Math.ceil((max + pad) / step) * step];
}

function HoverTooltip({ tip }) {
  if (!tip) return null;
  return createPortal(
    <div style={{
      position: 'fixed', top: tip.top, left: tip.left, zIndex: 9999, maxWidth: 320,
      background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6,
      padding: '6px 10px', fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.35)', pointerEvents: 'none',
    }}>
      {tip.text}
    </div>,
    document.body
  );
}

const amazonUrl = (asin) => asin ? `https://www.amazon.co.uk/dp/${asin}` : null;

function ProductImage({ row, onEnter, onLeave }) {
  const url = amazonUrl(row.asin);
  const Tag = url ? 'a' : 'div';
  const linkProps = url ? { href: url, target: '_blank', rel: 'noopener noreferrer', onClick: (e) => e.stopPropagation() } : {};
  return (
    <Tag
      {...linkProps}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ width: 48, height: 48, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: url ? 'pointer' : 'default', textDecoration: 'none' }}
    >
      {row.image_url ? <img src={row.image_url} alt={row.sku} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 18, opacity: 0.2 }}>◉</span>}
    </Tag>
  );
}

const CustomTooltip = ({ active, payload, label, fmt, name }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#1a1a24', border: '1px solid #ffffff18', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 11, color: '#6b6b80', marginBottom: 6 }}>{fmtDateFull(label)}</div>
      <div style={{ fontSize: 13, fontFamily: 'var(--mono)', color: payload[0].color }}>{name}: {fmt(payload[0].value)}</div>
    </div>
  );
};

// Amazon's aged-inventory surcharge kicks in at 271 days and steps up again at 365 - "at risk"
// (181-270) is the bucket about to fall into a charged tier, not yet charged itself.
const AGE_BUCKETS = [
  { key: 'age_0_90',    label: '0-90d',   status: 'safe' },
  { key: 'age_91_180',  label: '91-180d', status: 'safe' },
  { key: 'age_181_270', label: '181-270d', status: 'risk' },
  { key: 'age_271_365', label: '271-365d', status: 'critical' },
  { key: 'age_365_plus', label: '365d+',  status: 'critical' },
];
const STATUS_COLOR = { safe: '#34d399', risk: '#fbbf24', critical: '#f87171' };
const STATUS_LABEL = { safe: 'Safe', risk: 'At risk of surcharge', critical: 'Incurring surcharge' };

const AgingTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const bucket = AGE_BUCKETS.find(b => b.key === p.payload.key);
  return (
    <div style={{ background: '#1a1a24', border: '1px solid #ffffff18', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 11, color: '#6b6b80', marginBottom: 6 }}>{bucket?.label} · {STATUS_LABEL[bucket?.status]}</div>
      <div style={{ fontSize: 13, fontFamily: 'var(--mono)', color: STATUS_COLOR[bucket?.status] }}>{fmtN(p.value)} units</div>
    </div>
  );
};

const SellThroughTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div style={{ background: '#1a1a24', border: '1px solid #ffffff18', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 11, color: '#6b6b80', marginBottom: 6 }}>{fmtDateFull(label)}</div>
      <div style={{ fontSize: 13, fontFamily: 'var(--mono)', color: '#7c6af7' }}>Sell-through: {row.sell_through_pct}%</div>
      <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--muted)', marginTop: 2 }}>{fmtN(row.units_sold)} sold of {fmtN(row.units_on_hand)} on hand</div>
    </div>
  );
};

const COLS = [
  { key: 'product_title', label: 'Product',  width: '1fr' },
  { key: 'sellable',      label: 'Sellable',  width: '110px' },
  { key: 'inbound',       label: 'Inbound',   width: '110px' },
  { key: 'damaged',       label: 'Damaged',   width: '110px' },
  { key: 'other',         label: 'Other',     width: '110px' },
  { key: 'total',         label: 'Total',     width: '110px' },
];
const TABLE_GRID = 'minmax(160px,1fr) 110px 110px 110px 110px 110px';
const TABLE_MIN_WIDTH = 160 + 110 * 5;

export default function Inventory() {
  const isMobile = useIsMobile();
  const [sort, setSort] = useState('total');
  const [dir, setDir] = useState('desc');
  const [selectedSku, setSelectedSku] = useState(null);
  const [hoverTip, setHoverTip] = useState(null);

  const { data: rows, loading } = useApi('/api/inventory');
  const { data: history, loading: loadingHistory } = useApi('/api/inventory/history', selectedSku ? { sku: selectedSku } : {});
  const { data: sellThrough, loading: loadingSellThrough } = useApi('/api/inventory/sell-through', selectedSku ? { sku: selectedSku } : {});
  const { data: aging, loading: loadingAging } = useApi('/api/inventory/aging', selectedSku ? { sku: selectedSku } : {});

  const agingRows = useMemo(() => AGE_BUCKETS.map(b => ({ key: b.key, label: b.label, units: aging?.[b.key] || 0, status: b.status })), [aging]);

  const sym = history?.currency_symbol || '£';
  const fmtCurrency = useMemo(() => makeFmt(sym), [sym]);
  const historyRows = history?.rows || [];
  const selectedRow = selectedSku ? rows?.find(r => r.sku === selectedSku) : null;
  const unitsDomain = useMemo(() => computeDomain(historyRows, 'units'), [historyRows]);
  const valueDomain = useMemo(() => computeDomain(historyRows, 'value'), [historyRows]);
  const sellThroughDomain = useMemo(() => computeDomain(sellThrough || [], 'sell_through_pct'), [sellThrough]);

  const handleSort = (key) => {
    if (sort === key) setDir(dir === 'desc' ? 'asc' : 'desc');
    else { setSort(key); setDir('desc'); }
  };

  const SortIcon = ({ col }) => {
    if (sort !== col) return <span style={{ opacity: 0.3, fontSize: 9 }}>↕</span>;
    return <span style={{ color: 'var(--accent2)', fontSize: 9 }}>{dir === 'desc' ? '↓' : '↑'}</span>;
  };

  const sortedRows = useMemo(() => {
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

      {/* Charts - units and value are different scales, so two small-multiple charts
          rather than one dual-axis chart */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>
              Units {selectedRow ? `· ${selectedRow.sku}` : '· All SKUs'}
            </h2>
            {selectedSku && (
              <button onClick={() => setSelectedSku(null)} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font)' }}>
                Clear ×
              </button>
            )}
          </div>
          {loadingHistory ? (<div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={historyRows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradUnits" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7c6af7" stopOpacity={0.3} /><stop offset="100%" stopColor="#7c6af7" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                <XAxis dataKey="snapshot_date" tickFormatter={fmtTick} tick={{ fill: '#6b6b80', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtN} tick={{ fill: '#6b6b80', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} width={50} domain={unitsDomain} />
                <Tooltip content={<CustomTooltip fmt={fmtN} name="Units" />} />
                <Area type="monotone" dataKey="units" name="Units" stroke="#7c6af7" strokeWidth={2} fill="url(#gradUnits)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>
              Value {selectedRow ? `· ${selectedRow.sku}` : '· All SKUs'}
            </h2>
            {selectedSku && (
              <button onClick={() => setSelectedSku(null)} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font)' }}>
                Clear ×
              </button>
            )}
          </div>
          {loadingHistory ? (<div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={historyRows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradValue" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#34d399" stopOpacity={0.3} /><stop offset="100%" stopColor="#34d399" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                <XAxis dataKey="snapshot_date" tickFormatter={fmtTick} tick={{ fill: '#6b6b80', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtCurrency} tick={{ fill: '#6b6b80', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} width={70} domain={valueDomain} />
                <Tooltip content={<CustomTooltip fmt={fmtCurrency} name="Value" />} />
                <Area type="monotone" dataKey="value" name="Value" stroke="#34d399" strokeWidth={2} fill="url(#gradValue)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Aging and sell-through - also different scales (unit counts vs a %), so kept as
          separate small-multiples rather than combined onto one axis */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 20 }}>
            Inventory Aging {selectedRow ? `· ${selectedRow.sku}` : '· All SKUs'}
          </h2>
          {loadingAging ? (<div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={agingRows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#6b6b80', fontSize: 10, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={fmtN} tick={{ fill: '#6b6b80', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} width={50} />
                  <Tooltip content={<AgingTooltip />} />
                  <Bar dataKey="units" radius={[3, 3, 0, 0]}>
                    {agingRows.map((r, i) => <Cell key={i} fill={STATUS_COLOR[r.status]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 14 }}>
                {['safe', 'risk', 'critical'].map(s => (
                  <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_COLOR[s], flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{STATUS_LABEL[s]}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 20 }}>
            Sell-Through {selectedRow ? `· ${selectedRow.sku}` : '· All SKUs'}
          </h2>
          {loadingSellThrough ? (<div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={sellThrough || []} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradSellThrough" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7c6af7" stopOpacity={0.3} /><stop offset="100%" stopColor="#7c6af7" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                <XAxis dataKey="snapshot_date" tickFormatter={fmtTick} tick={{ fill: '#6b6b80', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => v + '%'} tick={{ fill: '#6b6b80', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} width={45} domain={sellThroughDomain} />
                <Tooltip content={<SellThroughTooltip />} />
                <Area type="monotone" dataKey="sell_through_pct" name="Sell-Through" stroke="#7c6af7" strokeWidth={2} fill="url(#gradSellThrough)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: TABLE_MIN_WIDTH }}>
            {/* Header row */}
            <div style={{ display: 'grid', gridTemplateColumns: TABLE_GRID, borderBottom: '1px solid var(--border)', background: 'var(--bg3)' }}>
              {COLS.map(col => (
                <div key={col.key} onClick={() => handleSort(col.key)}
                  style={{ padding: '11px 8px', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none', color: sort === col.key ? 'var(--accent2)' : 'var(--muted)' }}>
                  {col.label} <SortIcon col={col.key} />
                </div>
              ))}
            </div>

            {loading && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}
            {!loading && !sortedRows.length && <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No inventory data yet</div>}

            {!loading && sortedRows.map((row, i) => {
              const selected = selectedSku === row.sku;
              return (
                <div key={row.sku}
                  onClick={() => setSelectedSku(selected ? null : row.sku)}
                  style={{
                    display: 'grid', gridTemplateColumns: TABLE_GRID, cursor: 'pointer',
                    borderBottom: i < sortedRows.length - 1 ? '1px solid var(--border)' : 'none',
                    borderLeft: selected ? '3px solid #34d399' : '3px solid transparent',
                    background: selected ? '#ffffff05' : 'transparent',
                    transition: 'background 0.1s, border-color 0.15s',
                  }}
                  onMouseEnter={e => !selected && (e.currentTarget.style.background = '#ffffff03')}
                  onMouseLeave={e => !selected && (e.currentTarget.style.background = 'transparent')}>

                  <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, overflow: 'hidden' }}>
                    <ProductImage
                      row={row}
                      onEnter={e => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setHoverTip({ text: row.product_title || row.sku, top: r.bottom + 6, left: r.left });
                      }}
                      onLeave={() => setHoverTip(null)}
                    />
                    <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.sku}</div>
                      {/* Not a link - only the thumbnail navigates to Amazon. Clicking anywhere
                          else in the row (including here) selects it instead. Hover tooltip
                          still shows the full title on truncated rows. */}
                      <div
                        onMouseEnter={e => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setHoverTip({ text: row.product_title || row.sku, top: r.bottom + 6, left: r.left });
                        }}
                        onMouseLeave={() => setHoverTip(null)}
                        style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {row.product_title || row.asin || '—'}
                      </div>
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
              );
            })}
          </div>
        </div>
      </div>
      <HoverTooltip tip={hoverTip} />
    </div>
  );
}
