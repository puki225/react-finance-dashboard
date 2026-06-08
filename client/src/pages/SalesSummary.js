import React, { useState, useMemo } from 'react';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import KpiCard from '../components/KpiCard';
import DateRangePicker, { getRange } from '../components/DateRangePicker';
import { useApi } from '../hooks/useApi';

const fmt = (n) => '£' + parseFloat(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// Returns a tick formatter that appends a short year (e.g. '25) when data spans multiple years
function makeFmtDate(data) {
  const years = new Set((data || []).map(d => d.period ? new Date(d.period).getFullYear() : null).filter(Boolean));
  const multiYear = years.size > 1;
  return (d) => {
    if (!d) return '';
    const date = new Date(d);
    const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    if (!multiYear) return day;
    const yr = String(date.getFullYear()).slice(2);
    return day + " '" + yr;
  };
}

// Tooltip always shows full date including year
const fmtDateFull = (d) => {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

const COLORS = ['#7c6af7', '#34d399', '#fbbf24', '#f87171'];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#1a1a24', border: '1px solid #ffffff18', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 11, color: '#6b6b80', marginBottom: 6 }}>{fmtDateFull(label)}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ fontSize: 13, fontFamily: 'var(--mono)', color: p.color }}>
          {p.name}: {fmt(p.value)}
        </div>
      ))}
    </div>
  );
};

const GatewayTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value || 0), 0);
  return (
    <div style={{ background: '#1a1a24', border: '1px solid #ffffff18', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 11, color: '#6b6b80', marginBottom: 6 }}>{fmtDateFull(label)}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ fontSize: 12, fontFamily: 'var(--mono)', color: p.color }}>
          {p.name}: {fmt(p.value)}
        </div>
      ))}
      <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)', borderTop: '1px solid #ffffff18', marginTop: 6, paddingTop: 6 }}>
        Total: {fmt(total)}
      </div>
    </div>
  );
};

function pivotGatewayData(rows) {
  const map = {};
  const keys = new Set();
  for (const row of rows) {
    if (!map[row.period]) map[row.period] = { period: row.period };
    map[row.period][row.gateway] = parseFloat(row.revenue || 0);
    keys.add(row.gateway);
  }
  return { data: Object.values(map).sort((a, b) => a.period > b.period ? 1 : -1), keys: [...keys] };
}

function computeDomain(data, keys) {
  if (!data || !data.length) return ['auto', 'auto'];
  let min = Infinity, max = -Infinity;
  for (const row of data) {
    for (const k of keys) {
      const v = parseFloat(row[k] || 0);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!isFinite(min) || !isFinite(max)) return ['auto', 'auto'];
  const pad = (max - min) * 0.1 || max * 0.1 || 100;
  const lo = Math.max(0, Math.floor((min - pad) / 100) * 100);
  const hi = Math.ceil((max + pad) / 100) * 100;
  return [lo, hi];
}

const PERIODS = ['day', 'week', 'month', 'year'];

export default function SalesSummary() {
  const [range, setRange] = useState(getRange({ days: 30 }));
  const [period, setPeriod] = useState('day');

  const { data: summary } = useApi('/api/summary', range);
  const { data: trend, loading: loadingTrend } = useApi('/api/revenue-trend', { ...range, period });
  const { data: gatewayRaw, loading: loadingGateway } = useApi('/api/gateway-trend', { ...range, period });
  const { data: gatewaySummary } = useApi('/api/gateway-split', range);
  const { data: fees } = useApi('/api/fees', range);
  const { data: recentOrders } = useApi('/api/recent-orders', { limit: 8 });

  const { data: gatewayData, keys: gatewayKeys } = useMemo(
    () => pivotGatewayData(gatewayRaw || []),
    [gatewayRaw]
  );

  const revenueDomain = useMemo(
    () => computeDomain(trend || [], ['gross_revenue', 'net_revenue']),
    [trend]
  );

  const fmtTick = useMemo(() => makeFmtDate(trend), [trend]);
  const fmtGatewayTick = useMemo(() => makeFmtDate(gatewayData), [gatewayData]);

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 28 }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Sales Summary</h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Shopify · All channels</p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        <KpiCard label="Gross Revenue" value={summary?.gross_revenue} type="currency" color="#7c6af7" />
        <KpiCard label="Net Revenue" value={summary?.net_revenue} type="currency" color="#34d399" />
        <KpiCard label="Orders" value={summary?.total_orders} type="number" color="#fbbf24" />
        <KpiCard label="Avg Order Value" value={summary?.avg_order_value} type="currency" color="#a78bfa" />
        <KpiCard label="Refund Rate" value={summary?.refund_rate} type="percent" color="#f87171" sub={String(summary?.refund_count || 0) + ' orders'} />
        <KpiCard label="Shopify Fees" value={fees?.total_fees} type="currency" color="#6b6b80" sub="paid payouts only" />
      </div>

      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>Revenue Trend</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            {PERIODS.map(p => (
              <button key={p} onClick={() => setPeriod(p)} style={{
                padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                border: '1px solid ' + (period === p ? 'var(--accent)' : 'var(--border)'),
                background: period === p ? 'var(--accent)' : 'transparent',
                color: period === p ? '#fff' : 'var(--muted)',
                cursor: 'pointer', fontFamily: 'var(--font)', letterSpacing: '0.06em',
                textTransform: 'uppercase'
              }}>{p}</button>
            ))}
          </div>
        </div>
        {loadingTrend ? (
          <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={trend || []} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="gradGross" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#7c6af7" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#7c6af7" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradNet" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
              <XAxis dataKey="period" tickFormatter={fmtTick} tick={{ fill: '#6b6b80', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={fmt} tick={{ fill: '#6b6b80', fontSize: 11, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} width={70} domain={revenueDomain} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="gross_revenue" name="Gross" stroke="#7c6af7" strokeWidth={2} fill="url(#gradGross)" />
              <Area type="monotone" dataKey="net_revenue" name="Net" stroke="#34d399" strokeWidth={2} fill="url(#gradNet)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 20 }}>Payment Gateway</h2>
          {loadingGateway ? (
            <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={gatewayData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" vertical={false} />
                  <XAxis dataKey="period" tickFormatter={fmtGatewayTick} tick={{ fill: '#6b6b80', fontSize: 10, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={fmt} tick={{ fill: '#6b6b80', fontSize: 10, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} width={55} />
                  <Tooltip content={<GatewayTooltip />} />
                  {gatewayKeys.map((key, i) => (
                    <Bar key={key} dataKey={key} name={key.replace(/_/g, ' ')} stackId="a" fill={COLORS[i % COLORS.length]} radius={i === gatewayKeys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 14 }}>
                {(gatewaySummary || []).map((g, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>{g.gateway?.replace(/_/g, ' ')}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{fmt(g.revenue)} · {g.orders} orders</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 20 }}>Order Volume</h2>
          {loadingTrend ? (
            <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={trend || []} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" vertical={false} />
                <XAxis dataKey="period" tickFormatter={fmtTick} tick={{ fill: '#6b6b80', fontSize: 10, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#6b6b80', fontSize: 10, fontFamily: 'DM Mono' }} axisLine={false} tickLine={false} width={30} />
                <Tooltip contentStyle={{ background: '#1a1a24', border: '1px solid #ffffff18', borderRadius: 8, fontFamily: 'DM Mono', fontSize: 12 }} />
                <Bar dataKey="orders" name="Orders" fill="#fbbf24" radius={[3, 3, 0, 0]} opacity={0.85} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)' }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>Recent Orders</h2>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Order', 'Date', 'Status', 'Fulfilment', 'Gross', 'Net', 'Gateway', 'Country'].map(h => (
                <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(recentOrders || []).map((o, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--border)', transition: 'background 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.background = '#ffffff05'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <td style={{ padding: '12px 16px', fontFamily: 'var(--mono)', fontSize: 13 }}>#{o.shopify_order_number}</td>
                <td style={{ padding: '12px 16px', fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{fmtDateFull(o.order_date)}</td>
                <td style={{ padding: '12px 16px' }}><span style={{ padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: o.financial_status === 'paid' ? '#34d39920' : o.financial_status === 'refunded' ? '#f8717120' : '#fbbf2420', color: o.financial_status === 'paid' ? '#34d399' : o.financial_status === 'refunded' ? '#f87171' : '#fbbf24' }}>{o.financial_status}</span></td>
                <td style={{ padding: '12px 16px' }}><span style={{ padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: o.fulfillment_status === 'fulfilled' ? '#34d39915' : '#6b6b8020', color: o.fulfillment_status === 'fulfilled' ? '#34d399' : 'var(--muted)' }}>{o.fulfillment_status || 'unfulfilled'}</span></td>
                <td style={{ padding: '12px 16px', fontFamily: 'var(--mono)', fontSize: 13 }}>{fmt(o.gross_revenue)}</td>
                <td style={{ padding: '12px 16px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--green)' }}>{fmt(o.net_revenue)}</td>
                <td style={{ padding: '12px 16px', fontSize: 12, color: 'var(--muted)', textTransform: 'capitalize' }}>{o.gateway?.replace(/_/g, ' ')}</td>
                <td style={{ padding: '12px 16px', fontSize: 12, color: 'var(--muted)' }}>{o.shipping_country || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
