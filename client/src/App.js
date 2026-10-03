import React, { useState } from 'react';
import SalesSummary from './pages/SalesSummary';
import ProductBreakdown from './pages/ProductBreakdown';
import PnL from './pages/PnL';
import PVM from './pages/PVM';
import Inventory from './pages/Inventory';
import Shipments from './pages/Shipments';
import CashFlow from './pages/CashFlow';
import CashFlowProjection from './pages/CashFlowProjection';
import SalesForecast from './pages/SalesForecast';
import ActionBoard from './pages/ActionBoard';
import Settings from './pages/Settings';
import ChatWidget from './components/ChatWidget';
import { useIsMobile } from './hooks/useIsMobile';

// Grouped into sections for the sidebar - Settings is deliberately NOT one of these
// groups, it's rendered as its own pinned item at the bottom of the nav (see SETTINGS_ITEM
// below), separate from the day-to-day sections above it.
const NAV_SECTIONS = [
  {
    label: 'Overview',
    items: [
      { id: 'actionboard', label: 'Action Board', icon: '◆', active: true },
    ],
  },
  {
    label: 'Sales',
    items: [
      { id: 'sales',    label: 'Sales Summary',    icon: '◈', active: true },
      { id: 'products', label: 'Product Breakdown', icon: '◉', active: true },
    ],
  },
  {
    label: 'Profitability',
    items: [
      { id: 'pnl', label: 'P&L', icon: '◎', active: true },
      { id: 'pvm', label: 'PVM', icon: '◐', active: true },
    ],
  },
  {
    label: 'Operations',
    items: [
      { id: 'shipments', label: 'Shipments', icon: '◒', active: true },
      { id: 'inventory', label: 'Inventory', icon: '◑', active: true },
    ],
  },
  {
    label: 'Forecasting',
    items: [
      { id: 'salesforecast', label: 'Sales Forecast', icon: '◕', active: true },
      // 'cashrecon' (Cash Reconciliation) is deliberately left out of every section, not
      // just set active:false - that flag renders a grayed-out "SOON" row, which reads as
      // "not built yet" for a tab that's fully working and just hidden by request. Its
      // render branch below is untouched, so re-adding it to a section brings it straight
      // back.
      { id: 'cashflow', label: 'Cash Flow', icon: '◔', active: true },
    ],
  },
];
const SETTINGS_ITEM = { id: 'settings', label: 'Settings', icon: '◓', active: true };
// Flat lookup across every section plus Settings - used for the mobile top bar's current-
// tab label and nothing else, so it doesn't need to know about section grouping at all.
const ALL_NAV_ITEMS = [...NAV_SECTIONS.flatMap(s => s.items), SETTINGS_ITEM];

function Placeholder({ label }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--muted)' }}>
      <div style={{ fontSize: 48, opacity: 0.2 }}>◈</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 12 }}>Coming soon</div>
    </div>
  );
}

function NavButton({ item, active, collapsed, onClick }) {
  return (
    <button
      onClick={() => item.active && onClick(item.id)}
      title={collapsed ? item.label : ''}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: collapsed ? '10px 0' : '10px 12px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderRadius: 8,
        border: 'none',
        background: active ? 'var(--accent)20' : 'none',
        color: active ? 'var(--accent2)' : item.active ? 'var(--text)' : 'var(--muted)',
        cursor: item.active ? 'pointer' : 'not-allowed',
        fontSize: 13,
        fontWeight: active ? 600 : 400,
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
  );
}

export default function App() {
  const [active, setActive] = useState(() => localStorage.getItem('gb_active_tab') || 'sales');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobile = useIsMobile();
  // On mobile the sidebar is a full-width overlay drawer, not an icon rail — the desktop
  // collapse toggle doesn't apply there.
  const sidebarCollapsed = isMobile ? false : collapsed;
  const activeLabel = ALL_NAV_ITEMS.find(n => n.id === active)?.label || '';

  const handleNav = (id) => {
    setActive(id);
    localStorage.setItem('gb_active_tab', id);
    if (isMobile) setMobileOpen(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', height: '100vh', overflow: 'hidden' }}>

      {/* Mobile top bar */}
      {isMobile && (
        <div style={{
          height: 52, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
          padding: '0 16px', background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        }}>
          <button onClick={() => setMobileOpen(true)} style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: 20, cursor: 'pointer', padding: 4, lineHeight: 1 }}>
            ☰
          </button>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{activeLabel}</span>
        </div>
      )}

      {/* Mobile backdrop — closes the drawer on tap-outside */}
      {isMobile && mobileOpen && (
        <div onClick={() => setMobileOpen(false)} style={{ position: 'fixed', inset: 0, background: '#00000080', zIndex: 999 }} />
      )}

      {/* Sidebar */}
      <div style={{
        width: sidebarCollapsed ? 64 : 220,
        background: 'var(--bg2)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        transition: isMobile ? 'transform 0.2s ease' : 'width 0.2s ease',
        flexShrink: 0,
        overflow: 'hidden',
        ...(isMobile ? {
          position: 'fixed', top: 0, left: 0, height: '100vh', zIndex: 1000,
          transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)',
        } : {}),
      }}>
        {/* Logo */}
        <div style={{ padding: sidebarCollapsed ? '20px 16px' : '20px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 64 }}>
          {!sidebarCollapsed && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Finance</div>
              <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Dashboard</div>
            </div>
          )}
          <button onClick={() => (isMobile ? setMobileOpen(false) : setCollapsed(!collapsed))} style={{
            background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, padding: 4, borderRadius: 4,
            marginLeft: sidebarCollapsed ? 'auto' : 0,
          }}>
            {isMobile ? '×' : (collapsed ? '▶' : '◀')}
          </button>
        </div>

        {/* Nav sections */}
        <nav style={{ flex: 1, padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
          {NAV_SECTIONS.map(section => (
            <div key={section.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {!sidebarCollapsed && (
                <div style={{ padding: '0 12px', marginBottom: 6, fontSize: 13, fontWeight: 700, color: 'var(--text)', letterSpacing: '0.04em', textTransform: 'uppercase', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                  {section.label}
                </div>
              )}
              {section.items.map(item => (
                <NavButton key={item.id} item={item} active={active === item.id} collapsed={sidebarCollapsed} onClick={handleNav} />
              ))}
            </div>
          ))}
        </nav>

        {/* Settings — pinned at the bottom of the nav, separate from the sections above it */}
        <div style={{ padding: '8px', borderTop: '1px solid var(--border)' }}>
          <NavButton item={SETTINGS_ITEM} active={active === SETTINGS_ITEM.id} collapsed={sidebarCollapsed} onClick={handleNav} />
        </div>

        {/* Bottom: channel indicator */}
        {!sidebarCollapsed && (
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
        {active === 'actionboard' && <ActionBoard />}
        {active === 'sales'     && <SalesSummary />}
        {active === 'products'  && <ProductBreakdown />}
        {active === 'pnl'       && <PnL />}
        {active === 'pvm'       && <PVM />}
        {active === 'inventory' && <Inventory />}
        {active === 'shipments' && <Shipments />}
        {active === 'salesforecast' && <SalesForecast />}
        {active === 'cashrecon' && <CashFlow />}
        {active === 'cashflow'  && <CashFlowProjection />}
        {active === 'settings'  && <Settings />}
      </div>

      {/* Rendered as a sibling of the tab content, not inside it, so the conversation
          survives switching tabs instead of unmounting/remounting every time. */}
      <ChatWidget />
    </div>
  );
}
