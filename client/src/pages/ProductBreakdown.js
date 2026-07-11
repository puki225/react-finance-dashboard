import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import KpiCard from '../components/KpiCard';
import DateRangePicker, { getRange } from '../components/DateRangePicker';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';

// Native `title` tooltips have a fixed ~1s OS-level delay that can't be sped up, so the product
// title hover needs its own tiny implementation instead - a plain conditional render on
// mouseenter (no CSS transition/setTimeout) appears essentially instantly. Rendered via portal
// straight into document.body so it can't get clipped by the table's scroll/overflow-hidden
// containers, positioned from the hovered element's own bounding rect at hover time.
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

// Amazon is the account's UK marketplace throughout this dashboard - always link there when
// an ASIN is known, even for a "both channels" SKU (per explicit tie-break: Amazon wins).
// Shopify has no product handle/domain stored anywhere yet, so Shopify-only SKUs (no ASIN)
// get the tooltip but no link until that data exists.
const amazonUrl = (asin) => asin ? `https://www.amazon.co.uk/dp/${asin}` : null;

// Links out to Amazon when an ASIN is known (whichever channel(s) the SKU sold on); otherwise
// just a hover target for the tooltip, since there's no Shopify product link data yet.
function ProductImage({ row, onEnter, onLeave }) {
  const url = amazonUrl(row.asin);
  const Tag = url ? 'a' : 'div';
  const linkProps = url ? { href: url, target: '_blank', rel: 'noopener noreferrer' } : {};
  return (
    <Tag
      {...linkProps}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ width: 48, height: 48, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: url ? 'pointer' : 'help', textDecoration: 'none' }}
    >
      {row.image_url ? <img src={row.image_url} alt={row.sku} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 18, opacity: 0.2 }}>◉</span>}
    </Tag>
  );
}

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
  { key: 'expand',           label: '',                sortable: false, width: '36px' },
  { key: 'product_title',    label: 'Product',         sortable: false, width: '1fr'  },
  { key: 'units_sold',       label: 'Units',           sortable: true,  width: '10%'  },
  { key: 'gross_sales',      label: 'Revenue',         sortable: true,  width: '11%'  },
  { key: 'gross_margin_pct', label: 'Margin %',        sortable: true,  width: '8%'   },
  { key: 'product_contribution', label: 'Prod Contrib £', sortable: true, width: '10%'  },
  { key: 'roi',              label: 'ROI',             sortable: false, width: '7%'   },
  { key: 'acos',             label: 'ACOS',            sortable: false, width: '11%'  },
  { key: 'channels',         label: 'Channel',         sortable: false, width: '7%'   },
];
// Shared column template for the header + every row — the product column no longer needs to
// fit a long title (shown as a hover tooltip on the image instead), so it just needs room for
// the image + SKU/ASIN; the freed-up width goes to the numeric columns, which run bigger text.
const TABLE_GRID = '36px minmax(100px,1fr) 100px 110px 90px 110px 80px 120px 110px';
const TABLE_MIN_WIDTH = 36 + 100 + 100 + 110 + 90 + 110 + 80 + 120 + 110;

function PnlPanel({ sku, from, to, sym, country, channel }) {
  // Normalise channel: 'both' and undefined → 'all'
  const ch = (!channel || channel === 'both') ? 'all' : channel;
  const params = { from, to, channel: ch, ...(country ? { country } : {}) };
  const { data, loading, error } = useApi(`/api/product-breakdown/pnl/${encodeURIComponent(sku || '')}`, params);
  const [view, setView] = useState('total');

  if (loading) return <div style={{ padding: '20px', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (error) return <div style={{ padding: '20px', color: 'var(--red)', fontSize: 12 }}>Error loading breakdown</div>;
  if (!data || !data.revenue) return <div style={{ padding: '20px', color: 'var(--muted)', fontSize: 12 }}>No data</div>;

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
    const display = v < 0 ? `−${s}${Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${s}${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const pctDisplay = `(${p >= 0 ? '' : ''}${p.toFixed(1)}%)`;
    return (
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color, whiteSpace: 'nowrap' }}>
        {display} <span style={{ fontSize: 10, color: pctColor }}>{pctDisplay}</span>
      </span>
    );
  };

  const EstBadge = () => (
    <span title="Includes estimated Amazon fees, pending settlement via the Finances API" style={{ marginLeft: 6, padding: '1px 5px', borderRadius: 4, fontSize: 9, fontWeight: 700, background: '#fbbf2420', color: '#fbbf24', letterSpacing: '0.05em', verticalAlign: 'middle' }}>EST</span>
  );

  const Row = ({ label, value, bold, indent, isBase, est }) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', padding: '5px 0', borderBottom: '1px solid var(--border)', paddingLeft: indent ? 16 : 0, alignItems: 'center' }}>
      <span style={{ fontSize: bold ? 13 : 12, fontWeight: bold ? 700 : 400, color: bold ? 'var(--text)' : 'var(--muted)' }}>
        {label}
        {est && <EstBadge />}
      </span>
      {fmtVal(value, isBase)}
    </div>
  );

  const margin = divide(data.gross_margin);
  const marginPct = pct(data.gross_margin);
  const contribution = divide(data.product_contribution);
  const contributionPct = pct(data.product_contribution);

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

      <Row label="Gross Sales" value={data.revenue.gross_sales} bold isBase />
      {parseFloat(data.revenue.discounts) !== 0 && <Row label="Discounts / Promos" value={data.revenue.discounts} indent />}
      {parseFloat(data.revenue.refunds) !== 0 && <Row label="Refunds" value={data.revenue.refunds} indent />}
      <Row label="Net Sales" value={data.revenue.net_revenue} bold />

      {data.has_fees && <>
        {parseFloat(data.fees.commission) !== 0 && <Row label="Commission" value={data.fees.commission} indent />}
        {parseFloat(data.fees.commission_refunded) !== 0 && <Row label="Commission Refunded" value={data.fees.commission_refunded} indent />}
        {parseFloat(data.fees.fba_fulfillment) !== 0 && <Row label="FBA Fulfillment" value={data.fees.fba_fulfillment} indent />}
        {parseFloat(data.fees.mcf_fulfillment) !== 0 && <Row label="MCF Fulfillment" value={data.fees.mcf_fulfillment} indent />}
        {parseFloat(data.fees.fixed_closing) !== 0 && <Row label="Fixed Closing Fee" value={data.fees.fixed_closing} indent />}
        {parseFloat(data.fees.variable_closing) !== 0 && <Row label="Variable Closing Fee" value={data.fees.variable_closing} indent />}
        {parseFloat(data.fees.digital_services) !== 0 && <Row label="Digital Services" value={data.fees.digital_services} indent />}
        {parseFloat(data.fees.giftwrap) !== 0 && <Row label="Giftwrap Chargeback" value={data.fees.giftwrap} indent />}
        {parseFloat(data.fees.shipping_chargeback) !== 0 && <Row label="Shipping Chargeback" value={data.fees.shipping_chargeback} indent />}
        {parseFloat(data.fees.refund_admin_fee) !== 0 && <Row label="Refund Admin Fee" value={data.fees.refund_admin_fee} indent />}
        <Row label="Total Fees" value={data.fees.total} bold est={data.fees.has_estimated} />
      </>}

      {data.has_cogs && <>
        {parseFloat(data.cogs.standard) !== 0 && <Row label="Standard COGS" value={data.cogs.standard} indent />}
        {parseFloat(data.cogs.freight) !== 0 && <Row label="Freight" value={data.cogs.freight} indent />}
        {parseFloat(data.cogs.demurrage) !== 0 && <Row label="Demurrage / Duties" value={data.cogs.demurrage} indent />}
        {parseFloat(data.cogs.quality) !== 0 && <Row label="Quality / Inspection" value={data.cogs.quality} indent />}
        {parseFloat(data.cogs.other) !== 0 && <Row label="Other COGS" value={data.cogs.other} indent />}
        {parseFloat(data.cogs.returned) !== 0 && <Row label="Returns Credit" value={data.cogs.returned} indent />}
        <Row label="Total COGS" value={data.cogs.total} bold />
      </>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', padding: '10px 12px', marginTop: 10, borderRadius: 8, background: margin >= 0 ? '#34d39920' : '#f8717120', border: '1px solid ' + (margin >= 0 ? '#34d39940' : '#f8717140'), alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: margin >= 0 ? 'var(--green)' : 'var(--red)' }}>Gross Margin{data.fees.has_estimated && <EstBadge />}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: margin >= 0 ? 'var(--green)' : 'var(--red)', whiteSpace: 'nowrap' }}>
          {margin < 0 ? `−${s}${Math.abs(margin).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${s}${margin.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          {' '}<span style={{ fontSize: 11, fontWeight: 400 }}>({marginPct.toFixed(1)}%)</span>
        </span>
      </div>

      {data.has_ppc && <>
        <Row label="Ad Spend" value={data.ppc.spend} bold />
      </>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', padding: '10px 12px', marginTop: 10, borderRadius: 8, background: contribution >= 0 ? '#34d39920' : '#f8717120', border: '1px solid ' + (contribution >= 0 ? '#34d39940' : '#f8717140'), alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: contribution >= 0 ? 'var(--green)' : 'var(--red)' }}>Product Contribution{data.fees.has_estimated && <EstBadge />}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: contribution >= 0 ? 'var(--green)' : 'var(--red)', whiteSpace: 'nowrap' }}>
          {contribution < 0 ? `−${s}${Math.abs(contribution).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${s}${contribution.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          {' '}<span style={{ fontSize: 11, fontWeight: 400 }}>({contributionPct.toFixed(1)}%)</span>
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
      // Normalise to channelBadge's expected keys ('both' | 'shopify' | 'amazon') — a plain
      // '+'-joined string (e.g. "amazon+shopify") wouldn't match any of them and would
      // silently render as a mislabelled "Shopify" badge.
      const channel = r.channels.size > 1 ? 'both' : [...r.channels][0];
      return { ...r, gross_margin_pct: pct, profit_pct: pct, channel };
    }).sort((a, b) => parseFloat(b.gross_sales) - parseFloat(a.gross_sales));
  }, [data]);

  if (loading) return <div style={{ padding: '12px 0', color: 'var(--muted)', fontSize: 12 }}>Loading…</div>;
  if (!blended.length) return <div style={{ padding: '12px 0', color: 'var(--muted)', fontSize: 12 }}>No data</div>;

  const GRID = 'minmax(140px,1fr) 90px 100px 80px 80px 90px 70px 110px 90px 100px';
  const GRID_MIN_WIDTH = 140 + 90 + 100 + 80 + 80 + 90 + 70 + 110 + 90 + 100;

  return (
    <div style={{ overflowX: 'auto' }}>
     <div style={{ minWidth: GRID_MIN_WIDTH }}>
      {/* Sub-header */}
      <div style={{ display: 'grid', gridTemplateColumns: GRID, padding: '6px 0 4px', borderBottom: '1px solid var(--border)', marginBottom: 2 }}>
        {['Country', 'Units', 'Revenue', 'Margin %', 'Profit %', 'Profit £', 'ROI', 'ACOS', 'Channel', ''].map((h, i) => (
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
            {/* ROI — Product Contribution / COGS. At country level, gross_profit already is the
                contribution (no PPC deducted here, since ad spend isn't tracked per-country). */}
            <div style={{ padding: '0 8px' }}>
              {c.has_cogs && parseFloat(c.total_cogs) > 0
                ? (() => {
                    const roi = parseFloat(c.gross_profit) / parseFloat(c.total_cogs) * 100;
                    return <span style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 700, color: roi >= 100 ? 'var(--green)' : roi >= 40 ? 'var(--amber)' : 'var(--red)' }}>{fmtPct(roi)}</span>;
                  })()
                : <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>}
            </div>
            {/* ACOS */}
            <div style={{ padding: '0 8px', fontSize: 11, color: 'var(--muted)' }}>—</div>
            {/* Channel */}
            <div style={{ padding: '0 8px' }}>{channelBadge(c.channel)}</div>
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
    </div>
  );
}

function OrdersPanel({ sku, from, to, channel, fmt }) {
  const { data, loading, error } = useApi('/api/product-breakdown/orders', { sku, from, to, channel });
  const [tab, setTab] = useState('orders');

  if (loading) return <div style={{ padding: '20px', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (error) return <div style={{ padding: '20px', color: 'var(--red)', fontSize: 12 }}>Error loading orders</div>;

  const rows = tab === 'orders' ? (data?.orders || []) : (data?.refunds || []);

  const GRID = '110px 90px minmax(140px,1fr) 100px 90px 60px 90px 90px 90px';
  const GRID_MIN_WIDTH = 110 + 90 + 140 + 100 + 90 + 60 + 90 + 90 + 90;

  const statusColor = (status) => {
    const s = (status || '').toLowerCase();
    if (s.includes('cancel') || s.includes('refund')) return 'var(--red)';
    if (s.includes('ship') || s.includes('paid') || s.includes('fulfilled')) return 'var(--green)';
    return 'var(--muted)';
  };

  return (
    <div style={{ padding: '16px 20px' }}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {[['orders', 'Orders', data?.orders?.length], ['refunds', 'Refunds', data?.refunds?.length]].map(([id, label, count]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding: '5px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, border: '1px solid ' + (tab === id ? 'var(--accent)' : 'var(--border)'), background: tab === id ? 'var(--accent)20' : 'transparent', color: tab === id ? 'var(--accent2)' : 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s' }}>
            {label}{count > 0 ? ` (${count})` : ''}
          </button>
        ))}
      </div>

      {!rows.length && <div style={{ padding: '12px 0', color: 'var(--muted)', fontSize: 12 }}>No {tab} in this period</div>}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: GRID_MIN_WIDTH }}>
            <div style={{ display: 'grid', gridTemplateColumns: GRID, padding: '6px 0 4px', borderBottom: '1px solid var(--border)' }}>
              {['Date', 'Marketplace', 'Order ID', 'Status', 'Fulfillment', 'Qty', 'Net', 'VAT/Tax', 'Total'].map((h, i) => (
                <span key={i} style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 8px' }}>{h}</span>
              ))}
            </div>
            {rows.map((r, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: GRID, padding: '7px 0', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
                <div style={{ padding: '0 8px', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                  {r.order_date ? new Date(r.order_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                </div>
                <div style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CountryFlag code={r.marketplace} />
                </div>
                <div style={{ padding: '0 8px', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--accent2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.order_id}</div>
                <div style={{ padding: '0 8px', fontSize: 12, color: statusColor(r.status), fontWeight: 600 }}>{r.status || '—'}</div>
                <div style={{ padding: '0 8px', fontSize: 12, color: 'var(--muted)' }}>{r.fulfillment || '—'}</div>
                <div style={{ padding: '0 8px', fontSize: 12, fontFamily: 'var(--mono)' }}>{r.quantity ?? '—'}</div>
                <div style={{ padding: '0 8px', fontSize: 12, fontFamily: 'var(--mono)' }}>{fmt(r.net)}</div>
                <div style={{ padding: '0 8px', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmt(r.tax)}</div>
                <div style={{ padding: '0 8px', fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 700 }}>{fmt(r.total)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProductBreakdown() {
  const isMobile = useIsMobile();
  const [range, setRange] = useState(() => {
    try { const s = localStorage.getItem('gb_prod_range'); return s ? JSON.parse(s) : getRange({ days: 30 }); } catch { return getRange({ days: 30 }); }
  });
  const [channel, setChannel] = useState(() => localStorage.getItem('gb_prod_channel') || 'all');
  const [sort, setSort] = useState(() => localStorage.getItem('gb_prod_sort') || 'gross_sales');
  const [dir, setDir] = useState(() => localStorage.getItem('gb_prod_dir') || 'desc');
  const [expandedSku, setExpandedSku] = useState(null);
  const [expandedPnl, setExpandedPnl] = useState(null);
  const [expandedOrders, setExpandedOrders] = useState(null);
  const [hoverTip, setHoverTip] = useState(null);
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
      product_contribution: rows.reduce((s, r) => s + parseFloat(r.product_contribution ?? r.gross_profit ?? 0), 0),
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
    <div style={{ padding: isMobile ? '16px' : '28px 32px', display: 'flex', flexDirection: 'column', gap: isMobile ? 18 : 24 }}>

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
        <KpiCard label="Gross Margin" value={totalMargin} type="percent" color={totalMargin >= 20 ? '#34d399' : '#f87171'} />
        <KpiCard label="Prod Contrib £" value={totals.product_contribution} type="currency" color="#34d399" symbol={sym} />
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
       <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: TABLE_MIN_WIDTH }}>
        {/* Header row */}
        <div style={{ display: 'grid', gridTemplateColumns: TABLE_GRID, borderBottom: '1px solid var(--border)', background: 'var(--bg3)' }}>
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
          const marginPct = parseFloat(row.gross_margin_pct || 0);
          const productContribution = parseFloat(row.product_contribution ?? row.gross_profit ?? 0);
          const totalCogs = parseFloat(row.total_cogs || 0);
          const hasCogs = totalCogs > 0;
          // Product Breakdown ROI = Product Contribution / COGS (per-SKU, before OPEX is
          // allocated) — distinct from the P&L page's ROI, which is Profit / COGS.
          const roiPct = hasCogs ? (productContribution / totalCogs * 100) : 0;
          const hasPpc = parseFloat(row.ppc_cost || 0) > 0;
          const ppcUnits = parseInt(row.ppc_units || 0, 10);
          const organicUnits = Math.max(parseInt(row.units_sold || 0, 10) - ppcUnits, 0);

          return (
            <div key={row.sku} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none', borderLeft: expanded ? '3px solid #34d399' : '3px solid transparent', transition: 'border-color 0.15s' }}>
              <div style={{ display: 'grid', gridTemplateColumns: TABLE_GRID, background: expanded ? '#ffffff05' : 'transparent', transition: 'background 0.1s' }}
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
                  {/* Product title shows as a fast custom tooltip on hover instead of taking up
                      row space permanently — frees width/font size for the numeric columns.
                      Also links to Amazon when an ASIN is known. */}
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
                    {row.asin && <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.asin}</div>}
                  </div>
                </div>

                {/* Units */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)' }}>{fmtN(row.units_sold)}</span>
                  {row.units_refunded > 0 && (
                    <span style={{ fontSize: 12, color: 'var(--red)', fontFamily: 'var(--mono)' }}>
                      −{fmtN(row.units_refunded)} ({parseFloat(row.units_refunded / row.units_sold * 100).toFixed(0)}%)
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{fmtN(organicUnits)} organic</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{fmtN(ppcUnits)} ppc</span>
                </div>

                {/* Revenue */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{fmt(row.gross_sales)}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{fmt(row.net_revenue)}</span>
                </div>

                {/* Margin % */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
                  {hasCogs ? (
                    <>
                      <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)', color: marginPct >= 20 ? 'var(--green)' : marginPct >= 10 ? 'var(--amber)' : 'var(--red)' }}>{fmtPct(marginPct)}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>gross</span>
                    </>
                  ) : <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span>}
                </div>

                {/* Contribution £ */}
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  {hasCogs ? (
                    <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--mono)', color: productContribution >= 0 ? 'var(--text)' : 'var(--red)' }}>{fmt(productContribution)}</span>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>No COGS</span>
                  )}
                </div>

                {/* ROI */}
                <div style={{ padding: '13px 8px', display: 'flex', alignItems: 'center' }}>
                  {hasCogs ? (
                    <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--mono)', color: roiPct >= 100 ? 'var(--green)' : roiPct >= 40 ? 'var(--amber)' : 'var(--red)' }}>{fmtPct(roiPct)}</span>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span>
                  )}
                </div>

                {/* ACOS */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
                  {hasPpc ? (
                    <>
                      <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--mono)', color: parseFloat(row.acos) <= 15 ? 'var(--green)' : parseFloat(row.acos) <= 30 ? 'var(--amber)' : 'var(--red)' }}>{fmtPct(row.acos)}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>TACOS: {fmtPct(row.tacos)}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>ROAS: {row.roas}x</span>
                    </>
                  ) : <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span>}
                </div>

                {/* Channel + Breakdown button */}
                <div style={{ padding: '13px 8px', display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'center' }}>
                  {channelBadge(row.channels)}
                  <button
                    onClick={() => { setExpandedPnl(expandedPnl === row.sku ? null : row.sku); setExpandedSku(null); setExpandedOrders(null); }}
                    style={{ padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, border: '1px solid ' + (expandedPnl === row.sku ? 'var(--accent)' : 'var(--border)'), background: expandedPnl === row.sku ? 'var(--accent)20' : 'var(--bg3)', color: expandedPnl === row.sku ? 'var(--accent2)' : 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s', whiteSpace: 'nowrap' }}>
                    Breakdown
                  </button>
                  <button
                    onClick={() => { setExpandedOrders(expandedOrders === row.sku ? null : row.sku); setExpandedSku(null); setExpandedPnl(null); }}
                    style={{ padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, border: '1px solid ' + (expandedOrders === row.sku ? 'var(--accent)' : 'var(--border)'), background: expandedOrders === row.sku ? 'var(--accent)20' : 'var(--bg3)', color: expandedOrders === row.sku ? 'var(--accent2)' : 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s', whiteSpace: 'nowrap' }}>
                    Orders
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

              {/* Orders / Refunds panel */}
              {expandedOrders === row.sku && (
                <div style={{ borderTop: '1px solid var(--border)', background: '#ffffff03' }}>
                  <OrdersPanel sku={row.sku} from={range.from} to={range.to} channel={channel} fmt={fmt} />
                </div>
              )}
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
