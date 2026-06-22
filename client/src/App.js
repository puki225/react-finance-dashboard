import React, { useState } from 'react';
import SalesSummary from './pages/SalesSummary';
import ProductBreakdown from './pages/ProductBreakdown';
import Settings from './pages/Settings';

const NAV = [
  { id: 'sales',     label: 'Sales Summary',      icon: '◈', active: true },
  { id: 'products',  label: 'Product Breakdown',   icon: '◉', active: true },
  { id: 'pnl',       label: 'P&L',                 icon: '◎', active: false },
  { id: 'pvm',       label: 'PVM',                 icon: '◐', active: false },
  { id: 'inventory', label: 'Inventory',            icon: '◑', active: false },
  { id: 'cashflow',  label: 'Cash Flow',            icon: '◒', active: false },
  { id: 'settings',  label: 'Settings',             icon: '◓', active: true },
];

const SYNC_COLORS = { success: '#34d399', error: '#f87171', idle: '#6b6b80' };

function Placeholder({ label }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--muted)' }}>
      <div style={{ fontSize: 48, opacity: 0.2 }}>◈</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 12 }}>Coming soon</div>
    </div>
  );
}

export default function App() {
  const [active, setActive] = useState(() => localStorage.getItem('gb_active_tab') || 'sales');
  const [collapsed, setCollapsed] = useState(false);

  const handleNav = (id) => {
    setActive(id);
    localStorage.setItem('gb_active_tab', id);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>

      {/* Sidebar */}
      <div style={{
        width: collapsed ? 64 : 220,
        background: 'var(--bg2)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 0.2s ease',
        flexShrink: 0,
        overflow: 'hidden',
      }}>
        {/* Logo */}
        <div style={{ padding: collapsed ? '20px 16px' : '20px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 64 }}>
          {!collapsed && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Finance</div>
              <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Dashboard</div>
            </div>
          )}
          <button onClick={() => setCollapsed(!collapsed)} style={{
            background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, padding: 4, borderRadius: 4,
            marginLeft: collapsed ? 'auto' : 0,
          }}>
            {collapsed ? '▶' : '◀'}
          </button>
        </div>

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV.map(item => (
            <button
              key={item.id}
              onClick={() => item.active && handleNav(item.id)}
              title={collapsed ? item.label : ''}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: collapsed ? '10px 0' : '10px 12px',
                justifyContent: collapsed ? 'center' : 'flex-start',
                borderRadius: 8,
                border: 'none',
                background: active === item.id ? 'var(--accent)20' : 'none',
                color: active === item.id ? 'var(--accent2)' : item.active ? 'var(--text)' : 'var(--muted)',
                cursor: item.active ? 'pointer' : 'not-allowed',
                fontSize: 13,
                fontWeight: active === item.id ? 600 : 400,
                fontFamily: 'var(--font)',
                transition: 'all 0.15s',
                width: '100%',
                opacity: item.active ? 1 : 0.4,
                letterSpacing: '0.01em',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontSize: 16, flexShrink: 0 }}>{item.icon}</span>
              {!collapsed && <span>{item.label}</span>}
              {!collapsed && !item.active && <span style={{ marginLeft: 'auto', fontSize: 9, letterSpacing: '0.08em', color: 'var(--muted)' }}>SOON</span>}
            </button>
          ))}
        </nav>

        {/* Bottom: channel indicator */}
        {!collapsed && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Channels</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, background: '#7c6af720', color: 'var(--accent2)', fontWeight: 600 }}>Shopify</span>
              <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, background: '#fbbf2420', color: '#fbbf24', fontWeight: 600 }}>Amazon</span>
            </div>
          </div>
        )}
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
        {active === 'sales'     && <SalesSummary />}
        {active === 'products'  && <ProductBreakdown />}
        {active === 'pnl'       && <Placeholder label="P&L" />}
        {active === 'pvm'       && <Placeholder label="PVM Analysis" />}
        {active === 'inventory' && <Placeholder label="Inventory" />}
        {active === 'cashflow'  && <Placeholder label="Cash Flow & Working Capital" />}
        {active === 'settings'  && <Settings />}
      </div>
    </div>
  );
}
