import React, { useState, useCallback } from 'react';
import { useApi } from '../hooks/useApi';

const fmt = (n) => parseFloat(n || 0).toFixed(4);
const fmtDisplay = (n) => parseFloat(n || 0).toFixed(2);

const CURRENCIES = ['GBP', 'USD', 'EUR'];
const COGS_FIELDS = [
  { key: 'cogs_standard',  label: 'Standard COGS', placeholder: 'Manufacturing / unit cost' },
  { key: 'cogs_freight',   label: 'Freight',        placeholder: 'Shipping / logistics per unit' },
  { key: 'cogs_demurrage', label: 'Demurrage / Duties', placeholder: 'Import duties, demurrage fees' },
  { key: 'cogs_quality',   label: 'Quality / Inspection', placeholder: 'QC, inspection costs per unit' },
  { key: 'cogs_other',     label: 'Other',          placeholder: 'Any other landed cost' },
];

const SUBTABS = [
  { id: 'cogs',      label: 'COGS' },
  { id: 'cashflow',  label: 'Cash Flow', soon: true },
  { id: 'channels',  label: 'Channels',  soon: true },
];

const inputStyle = {
  background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6,
  padding: '7px 10px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--mono)',
  width: '100%', outline: 'none', transition: 'border-color 0.15s',
};

const labelStyle = {
  fontSize: 11, fontWeight: 600, color: 'var(--muted)',
  letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4, display: 'block',
};

function CogsRow({ row, onSave }) {
  const [values, setValues] = useState({
    cogs_standard:  row.cogs_standard  || 0,
    cogs_freight:   row.cogs_freight   || 0,
    cogs_demurrage: row.cogs_demurrage || 0,
    cogs_quality:   row.cogs_quality   || 0,
    cogs_other:     row.cogs_other     || 0,
    cogs_currency:  row.cogs_currency  || 'GBP',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [error, setError]   = useState(null);

  const total = COGS_FIELDS.reduce((s, f) => s + parseFloat(values[f.key] || 0), 0);

  const handleChange = (key, val) => {
    setValues(v => ({ ...v, [key]: val }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true); setError(null);
    try {
      const resp = await fetch(`/api/settings/cogs/${encodeURIComponent(row.sku)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await resp.json();
      if (data.ok) { setSaved(true); onSave(row.sku, data.unit_cogs); }
      else setError(data.error || 'Save failed');
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const dirty = COGS_FIELDS.some(f => parseFloat(values[f.key] || 0) !== parseFloat(row[f.key] || 0))
    || values.cogs_currency !== (row.cogs_currency || 'GBP');

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 12 }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 14 }}>
        {row.image_url
          ? <img src={row.image_url} alt={row.sku} style={{ width: 40, height: 40, objectFit: 'contain', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)' }} />
          : <div style={{ width: 40, height: 40, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, opacity: 0.3 }}>◉</div>
        }
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--mono)' }}>{row.sku}</div>
          {row.asin && <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{row.asin}</div>}
          <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.product_name}</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>TOTAL COGS / UNIT</div>
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--mono)', color: total > 0 ? 'var(--accent2)' : 'var(--muted)' }}>
            {values.cogs_currency === 'GBP' ? '£' : values.cogs_currency === 'USD' ? '$' : '€'}{fmtDisplay(total)}
          </div>
        </div>
      </div>

      {/* Cost inputs */}
      <div style={{ padding: '16px 20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, marginBottom: 16 }}>
          {COGS_FIELDS.map(field => (
            <div key={field.key}>
              <label style={labelStyle}>{field.label}</label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--muted)', fontFamily: 'var(--mono)', pointerEvents: 'none' }}>
                  {values.cogs_currency === 'GBP' ? '£' : values.cogs_currency === 'USD' ? '$' : '€'}
                </span>
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={values[field.key]}
                  onChange={e => handleChange(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  style={{ ...inputStyle, paddingLeft: 24 }}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
              </div>
            </div>
          ))}

          {/* Currency selector */}
          <div>
            <label style={labelStyle}>Currency</label>
            <select
              value={values.cogs_currency}
              onChange={e => handleChange('cogs_currency', e.target.value)}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{error}</span>}
          {saved && !dirty && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ Saved</span>}
          {!error && !saved && <span />}
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            style={{
              padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              border: '1px solid ' + (dirty ? 'var(--accent)' : 'var(--border)'),
              background: dirty ? 'var(--accent)' : 'transparent',
              color: dirty ? '#fff' : 'var(--muted)',
              cursor: dirty ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font)', transition: 'all 0.15s', opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Settings() {
  const [subtab, setSubtab] = useState('cogs');
  const { data: skus, loading, error, refetch } = useApi('/api/settings/cogs');
  const [localSkus, setLocalSkus] = useState(null);

  const rows = localSkus || skus;

  const handleSave = useCallback((sku, unit_cogs) => {
    setLocalSkus(prev => (prev || skus || []).map(r =>
      r.sku === sku ? { ...r, unit_cogs } : r
    ));
  }, [skus]);

  const subtabBtn = (id) => ({
    padding: '7px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
    border: '1px solid ' + (subtab === id ? 'var(--accent2)' : 'var(--border)'),
    background: subtab === id ? 'var(--accent2)20' : 'transparent',
    color: subtab === id ? 'var(--accent2)' : 'var(--muted)',
    cursor: 'pointer', fontFamily: 'var(--font)', letterSpacing: '0.04em', transition: 'all 0.15s',
    opacity: 1,
  });

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1100 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Settings</h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Configure costs, channels, and cash flow assumptions</p>
        </div>
      </div>

      {/* Subtabs */}
      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
        {SUBTABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => !tab.soon && setSubtab(tab.id)}
            style={{ ...subtabBtn(tab.id), opacity: tab.soon ? 0.4 : 1, cursor: tab.soon ? 'not-allowed' : 'pointer', position: 'relative' }}
          >
            {tab.label}
            {tab.soon && <span style={{ marginLeft: 6, fontSize: 9, letterSpacing: '0.08em', color: 'var(--muted)' }}>SOON</span>}
          </button>
        ))}
      </div>

      {/* COGS subtab */}
      {subtab === 'cogs' && (
        <div>
          <div style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Cost of Goods Sold</h2>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              Enter landed cost per unit for each SKU. All components sum to <strong style={{ color: 'var(--text)' }}>unit_cogs</strong>, used in P&L margin calculations.
              Values are stored in the selected currency and converted to GBP at the time of reporting.
            </p>
          </div>

          {loading && (
            <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading SKUs…</div>
          )}
          {error && (
            <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--red)', fontSize: 13 }}>{error}</div>
          )}
          {!loading && rows?.map(row => (
            <CogsRow key={row.sku} row={row} onSave={handleSave} />
          ))}
        </div>
      )}
    </div>
  );
}
