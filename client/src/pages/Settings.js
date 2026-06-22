import React, { useState, useCallback, useEffect } from 'react';
import { useApi } from '../hooks/useApi';

const fmtDisplay = (n) => parseFloat(n || 0).toFixed(2);
const today = () => new Date().toISOString().split('T')[0];

const CURRENCIES = ['GBP', 'USD', 'EUR'];
const SYMBOL = { GBP: '£', USD: '$', EUR: '€' };
const COGS_FIELDS = [
  { key: 'cogs_standard',  label: 'Standard COGS',       placeholder: 'Manufacturing / unit cost' },
  { key: 'cogs_freight',   label: 'Freight',              placeholder: 'Shipping / logistics per unit' },
  { key: 'cogs_demurrage', label: 'Demurrage / Duties',   placeholder: 'Import duties, demurrage fees' },
  { key: 'cogs_quality',   label: 'Quality / Inspection', placeholder: 'QC, inspection costs per unit' },
  { key: 'cogs_other',     label: 'Other',                placeholder: 'Any other landed cost' },
];
const SUBTABS = [
  { id: 'cogs',      label: 'COGS' },
  { id: 'reporting', label: 'Reporting' },
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

function emptyForm(currency = 'GBP') {
  return { cogs_standard: '', cogs_freight: '', cogs_demurrage: '', cogs_quality: '', cogs_other: '', cogs_currency: currency, effective_from: today(), notes: '' };
}

// ── History popup ──────────────────────────────────────────────────────────
function HistoryPopup({ sku, productName, onClose, onRefresh }) {
  const { data: history, loading, refetch } = useApi(`/api/settings/cogs/${encodeURIComponent(sku)}/history`);
  const [editingId, setEditingId] = useState(null);
  const [editValues, setEditValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const startEdit = (entry) => {
    setEditingId(entry.id);
    setEditValues({
      effective_from:  entry.effective_from?.split('T')[0] || '',
      effective_to:    entry.effective_to?.split('T')[0] || '',
      cogs_standard:   entry.cogs_standard  || 0,
      cogs_freight:    entry.cogs_freight   || 0,
      cogs_demurrage:  entry.cogs_demurrage || 0,
      cogs_quality:    entry.cogs_quality   || 0,
      cogs_other:      entry.cogs_other     || 0,
      cogs_currency:   entry.cogs_currency  || 'GBP',
      notes:           entry.notes          || '',
    });
    setError(null);
  };

  const saveEdit = async () => {
    setSaving(true); setError(null);
    try {
      const resp = await fetch(`/api/settings/cogs/entry/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editValues),
      });
      const data = await resp.json();
      if (data.ok) { setEditingId(null); refetch(); onRefresh(); }
      else setError(data.error || 'Save failed');
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const sym = (currency) => SYMBOL[currency] || '£';

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000080', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 800, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>COGS History</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{productName} · {sku}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading && <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>}
          {!loading && !history?.length && <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>No COGS entries yet.</div>}
          {!loading && history?.map((entry, i) => {
            const isEditing = editingId === entry.id;
            const currency = isEditing ? editValues.cogs_currency : (entry.cogs_currency || 'GBP');
            return (
              <div key={entry.id} style={{ borderBottom: i < history.length - 1 ? '1px solid var(--border)' : 'none', padding: '16px 24px' }}>
                {isEditing ? (
                  // Edit mode
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                      <div>
                        <label style={labelStyle}>Effective From</label>
                        <input type="date" value={editValues.effective_from} onChange={e => setEditValues(v => ({ ...v, effective_from: e.target.value }))} style={inputStyle} />
                      </div>
                      <div>
                        <label style={labelStyle}>Effective To (blank = open)</label>
                        <input type="date" value={editValues.effective_to} onChange={e => setEditValues(v => ({ ...v, effective_to: e.target.value }))} style={inputStyle} />
                      </div>
                      <div>
                        <label style={labelStyle}>Currency</label>
                        <select value={editValues.cogs_currency} onChange={e => setEditValues(v => ({ ...v, cogs_currency: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
                          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
                      {COGS_FIELDS.map(f => (
                        <div key={f.key}>
                          <label style={labelStyle}>{f.label}</label>
                          <div style={{ position: 'relative' }}>
                            <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{sym(editValues.cogs_currency)}</span>
                            <input type="number" step="0.0001" min="0" value={editValues[f.key]} onChange={e => setEditValues(v => ({ ...v, [f.key]: e.target.value }))} style={{ ...inputStyle, paddingLeft: 20 }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div>
                      <label style={labelStyle}>Notes</label>
                      <input type="text" value={editValues.notes} onChange={e => setEditValues(v => ({ ...v, notes: e.target.value }))} placeholder="Optional note" style={inputStyle} />
                    </div>
                    {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={saveEdit} disabled={saving} style={{ padding: '7px 18px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: 'var(--accent)', border: 'none', color: '#fff', cursor: 'pointer' }}>{saving ? 'Saving…' : 'Save'}</button>
                      <button onClick={() => setEditingId(null)} style={{ padding: '7px 18px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  // View mode
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--mono)', color: entry.effective_to ? 'var(--muted)' : 'var(--green)' }}>
                          {entry.effective_from?.split('T')[0]} → {entry.effective_to?.split('T')[0] || 'present'}
                        </span>
                        {!entry.effective_to && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#34d39920', color: 'var(--green)', fontWeight: 700 }}>CURRENT</span>}
                        <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg3)', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{entry.cogs_currency}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                        {COGS_FIELDS.map(f => (
                          <div key={f.key} style={{ fontSize: 12 }}>
                            <span style={{ color: 'var(--muted)' }}>{f.label}: </span>
                            <span style={{ fontFamily: 'var(--mono)', color: parseFloat(entry[f.key]) > 0 ? 'var(--text)' : 'var(--muted)' }}>{sym(currency)}{fmtDisplay(entry[f.key])}</span>
                          </div>
                        ))}
                      </div>
                      {entry.notes && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{entry.notes}</div>}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--accent2)', marginBottom: 4 }}>{sym(currency)}{fmtDisplay(entry.unit_cogs)}</div>
                      <button onClick={() => startEdit(entry)} style={{ padding: '5px 14px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font)' }}>Edit</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── COGS Row ───────────────────────────────────────────────────────────────
function CogsRow({ row, onRefresh }) {
  const [form, setForm] = useState(emptyForm(row.cogs_currency || 'GBP'));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [error, setError]   = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const total = COGS_FIELDS.reduce((s, f) => s + parseFloat(form[f.key] || 0), 0);
  const sym = SYMBOL[form.cogs_currency] || '£';
  const hasExistingCogs = parseFloat(row.unit_cogs) > 0;

  const handleChange = (key, val) => { setForm(v => ({ ...v, [key]: val })); setSaved(false); };

  const handleSave = async () => {
    if (!form.effective_from) { setError('Effective from date is required'); return; }
    setSaving(true); setError(null);
    try {
      const resp = await fetch(`/api/settings/cogs/${encodeURIComponent(row.sku)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await resp.json();
      if (data.ok) { setSaved(true); setForm(emptyForm(form.cogs_currency)); onRefresh(); }
      else setError(data.error || 'Save failed');
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const dirty = COGS_FIELDS.some(f => parseFloat(form[f.key] || 0) > 0);

  return (
    <>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 12 }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 14 }}>
          {row.image_url
            ? <img src={row.image_url} alt={row.sku} style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', flexShrink: 0 }} />
            : <div style={{ width: 48, height: 48, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, opacity: 0.3, flexShrink: 0 }}>◉</div>
          }
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.product_name || row.sku}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>{row.sku}{row.asin ? ` · ${row.asin}` : ''}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            {hasExistingCogs && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>CURRENT COGS</div>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>£{fmtDisplay(row.unit_cogs)}</div>
              </div>
            )}
            <button
              onClick={() => setShowHistory(true)}
              style={{ padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font)', whiteSpace: 'nowrap' }}
            >
              History {row.entry_count > 0 ? `(${row.entry_count})` : ''}
            </button>
          </div>
        </div>

        {/* New entry form */}
        <div style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 12, letterSpacing: '0.04em' }}>
            {hasExistingCogs ? 'ADD NEW COGS ENTRY' : 'SET INITIAL COGS'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14, marginBottom: 14 }}>
            {/* Effective from date */}
            <div>
              <label style={labelStyle}>Effective From</label>
              <input type="date" value={form.effective_from} onChange={e => handleChange('effective_from', e.target.value)} style={inputStyle} />
            </div>
            {/* Currency */}
            <div>
              <label style={labelStyle}>Currency</label>
              <select value={form.cogs_currency} onChange={e => handleChange('cogs_currency', e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {/* Cost fields */}
            {COGS_FIELDS.map(field => (
              <div key={field.key}>
                <label style={labelStyle}>{field.label}</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)', pointerEvents: 'none' }}>{sym}</span>
                  <input type="number" step="0.0001" min="0" value={form[field.key]} onChange={e => handleChange(field.key, e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 22 }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                </div>
              </div>
            ))}
            {/* Notes */}
            <div>
              <label style={labelStyle}>Notes</label>
              <input type="text" value={form.notes} onChange={e => handleChange('notes', e.target.value)} placeholder="Optional" style={inputStyle} />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {dirty && <span style={{ fontSize: 13, fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>Total: {sym}{fmtDisplay(total)} / unit</span>}
              {error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{error}</span>}
              {saved && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ Entry saved</span>}
            </div>
            <button onClick={handleSave} disabled={saving || !dirty}
              style={{ padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid ' + (dirty ? 'var(--accent)' : 'var(--border)'), background: dirty ? 'var(--accent)' : 'transparent', color: dirty ? '#fff' : 'var(--muted)', cursor: dirty ? 'pointer' : 'not-allowed', fontFamily: 'var(--font)', transition: 'all 0.15s', opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : hasExistingCogs ? 'Add Entry' : 'Set COGS'}
            </button>
          </div>
        </div>
      </div>

      {showHistory && <HistoryPopup sku={row.sku} productName={row.product_name || row.sku} onClose={() => setShowHistory(false)} onRefresh={onRefresh} />}
    </>
  );
}

// ── Reporting subtab ───────────────────────────────────────────────────────
function ReportingSettings() {
  const { data: config } = useApi('/api/settings/config');
  const [currency, setCurrency] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  useEffect(() => {
    if (config?.reporting_currency && currency === null) setCurrency(config.reporting_currency);
  }, [config, currency]);

  const handleSave = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const resp = await fetch('/api/settings/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reporting_currency: currency }),
      });
      const data = await resp.json();
      if (data.ok) setSaved(true);
      else setError(data.error || 'Save failed');
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const handleSyncFx = async () => {
    setSyncing(true); setSyncResult(null);
    try {
      const resp = await fetch('/api/sync-fx', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daysBack: 730 }),
      });
      const data = await resp.json();
      setSyncResult(data.ok ? `✓ Synced ${data.synced} FX rates` : `Error: ${data.error}`);
    } catch (e) { setSyncResult(`Error: ${e.message}`); }
    setSyncing(false);
  };

  const dirty = currency !== null && currency !== config?.reporting_currency;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Reporting Currency</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          All revenue, margin, and cash flow figures will be displayed in this currency.
          COGS entered in other currencies will be converted at the exchange rate on the order date.
        </p>
      </div>

      {/* Currency selector */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={labelStyle}>Reporting Currency</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              {CURRENCIES.map(c => (
                <button key={c} onClick={() => { setCurrency(c); setSaved(false); }}
                  style={{ padding: '10px 24px', borderRadius: 8, fontSize: 14, fontWeight: 700, fontFamily: 'var(--mono)', border: '2px solid ' + (currency === c ? 'var(--accent)' : 'var(--border)'), background: currency === c ? 'var(--accent)20' : 'transparent', color: currency === c ? 'var(--accent2)' : 'var(--muted)', cursor: 'pointer', transition: 'all 0.15s' }}>
                  {c === 'GBP' ? '£ GBP' : c === 'USD' ? '$ USD' : '€ EUR'}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            {saved && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ Saved</span>}
            {error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{error}</span>}
            <button onClick={handleSave} disabled={saving || !dirty}
              style={{ padding: '9px 22px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid ' + (dirty ? 'var(--accent)' : 'var(--border)'), background: dirty ? 'var(--accent)' : 'transparent', color: dirty ? '#fff' : 'var(--muted)', cursor: dirty ? 'pointer' : 'not-allowed', fontFamily: 'var(--font)', transition: 'all 0.15s' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* FX Rates */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '24px' }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Exchange Rates</h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 16 }}>
          Historical GBP→USD and GBP→EUR rates are sourced from the Frankfurter API (ECB data).
          Rates are synced daily. Run a manual backfill to populate historical data.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={handleSyncFx} disabled={syncing}
            style={{ padding: '9px 22px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid var(--accent)', background: 'var(--accent)20', color: 'var(--accent2)', cursor: syncing ? 'not-allowed' : 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s', opacity: syncing ? 0.6 : 1 }}>
            {syncing ? 'Syncing…' : 'Backfill 2 Years of FX Rates'}
          </button>
          {syncResult && <span style={{ fontSize: 12, color: syncResult.startsWith('✓') ? 'var(--green)' : 'var(--red)' }}>{syncResult}</span>}
        </div>
      </div>
    </div>
  );
}
export default function Settings() {
  const [subtab, setSubtab] = useState('cogs');
  const { data: skus, loading, error, refetch } = useApi('/api/settings/cogs');

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1100 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Settings</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Configure costs, channels, and cash flow assumptions</p>
      </div>

      {/* Subtabs */}
      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
        {SUBTABS.map(tab => (
          <button key={tab.id} onClick={() => !tab.soon && setSubtab(tab.id)}
            style={{ padding: '7px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid ' + (subtab === tab.id ? 'var(--accent2)' : 'var(--border)'), background: subtab === tab.id ? 'var(--accent2)20' : 'transparent', color: subtab === tab.id ? 'var(--accent2)' : 'var(--muted)', cursor: tab.soon ? 'not-allowed' : 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s', opacity: tab.soon ? 0.4 : 1 }}>
            {tab.label}{tab.soon && <span style={{ marginLeft: 6, fontSize: 9, letterSpacing: '0.08em' }}>SOON</span>}
          </button>
        ))}
      </div>

      {subtab === 'cogs' && (
        <div>
          <div style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Cost of Goods Sold</h2>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              Enter landed cost per unit for each SKU. Each entry has an effective date range — COGS for an order is matched to the range covering its order date.
              Refunds are credited at the COGS of the original order date, not the refund date.
            </p>
          </div>
          {loading && <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--muted)' }}>Loading SKUs…</div>}
          {error && <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--red)' }}>{error}</div>}
          {!loading && skus?.map(row => <CogsRow key={row.sku} row={row} onRefresh={refetch} />)}
        </div>
      )}
      {subtab === 'reporting' && <ReportingSettings />}
    </div>
  );
}
