import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';

const fmtDisplay = (n) => parseFloat(n || 0).toFixed(2);
const today = () => new Date().toISOString().split('T')[0];

const CURRENCIES = ['GBP', 'USD', 'EUR'];
const SYMBOL = { GBP: '£', USD: '$', EUR: '€' };
// Common business timezones, not the full ~400 IANA list - covers the major commerce hubs.
const TIMEZONES = [
  'UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Rome', 'Europe/Amsterdam', 'Europe/Warsaw', 'Europe/Athens', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Sao_Paulo', 'America/Mexico_City',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore',
  'Asia/Tokyo', 'Asia/Seoul', 'Australia/Sydney', 'Pacific/Auckland',
];
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
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
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
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12 }}>
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

// ── COGS CSV Download / Upload ───────────────────────────────────────────────
function CogsCsvTools({ onRefresh }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true); setError(null); setResult(null);
    try {
      const text = await file.text();
      const resp = await fetch('/api/settings/cogs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: text,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Import failed');
      setResult(data);
      onRefresh?.();
    } catch (e) { setError(e.message); }
    setUploading(false);
  };

  const btnStyle = { padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--font)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <a href="/api/settings/cogs/export" style={btnStyle}>↓ Download CSV</a>
        <button onClick={() => fileInputRef.current?.click()} disabled={uploading} style={{ ...btnStyle, cursor: uploading ? 'not-allowed' : 'pointer', opacity: uploading ? 0.6 : 1 }}>
          {uploading ? 'Uploading…' : '↑ Upload CSV'}
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleFile} style={{ display: 'none' }} />
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {result && (
        <div style={{ fontSize: 12, color: 'var(--green)', textAlign: 'right' }}>
          ✓ {result.inserted} added, {result.updated} updated{result.skipped ? `, ${result.skipped} skipped` : ''}
          {result.errors?.length > 0 && <span style={{ color: 'var(--red)' }}> · {result.errors.length} error{result.errors.length > 1 ? 's' : ''}</span>}
        </div>
      )}
      {result?.errors?.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--red)', maxWidth: 340, textAlign: 'right' }}>
          {result.errors.slice(0, 5).map((e, i) => <div key={i}>Row {e.row} ({e.sku}): {e.error}</div>)}
          {result.errors.length > 5 && <div>…and {result.errors.length - 5} more</div>}
        </div>
      )}
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
  const currentSym = SYMBOL[row.cogs_currency] || '£';
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
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--accent2)' }}>{currentSym}{fmtDisplay(row.unit_cogs)}</div>
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

// ── Company Information ─────────────────────────────────────────────────
const COMPANY_FIELDS = [
  { key: 'client_name',     label: 'Company Name',      placeholder: 'e.g. Gritty Blenders Ltd', textarea: false },
  { key: 'company_address', label: 'Address',            placeholder: 'Registered business address', textarea: true },
  { key: 'company_id',      label: 'Company ID / NIF',   placeholder: 'Company registration number / NIF', textarea: false },
  { key: 'vat_number',      label: 'VAT Number',         placeholder: 'e.g. GB123456789 (leave blank if not VAT registered)', textarea: false },
];

function CompanyInfoSettings({ config, vatRates, onRefresh }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (config && form === null) {
      setForm({
        client_name: config.client_name || '',
        company_address: config.company_address || '',
        company_id: config.company_id || '',
        vat_number: config.vat_number || '',
        company_country: config.company_country || '',
      });
    }
  }, [config, form]);

  if (!form) return null;

  const handleChange = (key, val) => { setForm(f => ({ ...f, [key]: val })); setSaved(false); };

  const allKeys = [...COMPANY_FIELDS.map(f => f.key), 'company_country'];
  const dirty = allKeys.some(k => form[k] !== (config?.[k] || ''));

  const handleSave = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const resp = await fetch('/api/settings/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await resp.json();
      if (data.ok) { setSaved(true); onRefresh?.(); }
      else setError(data.error || 'Save failed');
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const vatRegistered = !!(form.vat_number && form.vat_number.trim());

  return (
    <div>
      <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Company Information</h2>
      <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 16 }}>
        Used to identify your business on generated reports and exports. VAT-registration status
        (below) is derived from whether a VAT number is on file — if set, all reporting switches
        to VAT-exclusive figures using the rates configured in VAT Rates.
      </p>

      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 16 }}>
          {COMPANY_FIELDS.map(f => (
            <div key={f.key} style={f.textarea ? { gridColumn: '1 / -1' } : undefined}>
              <label style={labelStyle}>{f.label}</label>
              {f.textarea ? (
                <textarea value={form[f.key]} onChange={e => handleChange(f.key, e.target.value)} placeholder={f.placeholder} rows={2}
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font)' }} />
              ) : (
                <input type="text" value={form[f.key]} onChange={e => handleChange(f.key, e.target.value)} placeholder={f.placeholder} style={inputStyle} />
              )}
            </div>
          ))}
          <div>
            <label style={labelStyle}>Company Country</label>
            <select value={form.company_country} onChange={e => handleChange('company_country', e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="">Select…</option>
              {(vatRates || []).map(r => <option key={r.country_code} value={r.country_code}>{r.country_name}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '10px 14px', borderRadius: 8, background: vatRegistered ? 'var(--accent)15' : 'var(--bg3)', border: '1px solid ' + (vatRegistered ? 'var(--accent)' : 'var(--border)') }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: vatRegistered ? 'var(--green)' : 'var(--muted)', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>
            VAT registered: <strong>{vatRegistered ? 'Yes' : 'No'}</strong>
            {vatRegistered
              ? ' — sales and fees are reported VAT-exclusive across the dashboard.'
              : ' — no VAT number on file, so figures are reported VAT-inclusive (full income).'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
          {saved && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ Saved</span>}
          {error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{error}</span>}
          <button onClick={handleSave} disabled={saving || !dirty}
            style={{ padding: '9px 22px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid ' + (dirty ? 'var(--accent)' : 'var(--border)'), background: dirty ? 'var(--accent)' : 'transparent', color: dirty ? '#fff' : 'var(--muted)', cursor: dirty ? 'pointer' : 'not-allowed', fontFamily: 'var(--font)', transition: 'all 0.15s' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── VAT Rates ────────────────────────────────────────────────────────────
function VatRatesSettings({ vatRates, onRefresh }) {
  const [editing, setEditing] = useState({}); // { [code]: rateString }
  const [newRow, setNewRow] = useState({ code: '', name: '', rate: '' });
  const [savingCode, setSavingCode] = useState(null);
  const [error, setError] = useState(null);

  const rows = vatRates || [];

  const saveRate = async (code, name, rate) => {
    const r = parseFloat(rate);
    if (!code || !name || isNaN(r)) { setError('Country code, name, and a numeric rate are required'); return; }
    setSavingCode(code); setError(null);
    try {
      const resp = await fetch(`/api/settings/vat-rates/${encodeURIComponent(code)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country_name: name, standard_rate: r }),
      });
      const data = await resp.json();
      if (data.ok) {
        setEditing(e => { const n = { ...e }; delete n[code]; return n; });
        setNewRow({ code: '', name: '', rate: '' });
        onRefresh?.();
      } else setError(data.error || 'Save failed');
    } catch (e) { setError(e.message); }
    setSavingCode(null);
  };

  const removeRate = async (code) => {
    setSavingCode(code); setError(null);
    try {
      const resp = await fetch(`/api/settings/vat-rates/${encodeURIComponent(code)}`, { method: 'DELETE' });
      const data = await resp.json();
      if (data.ok) onRefresh?.();
      else setError(data.error || 'Delete failed');
    } catch (e) { setError(e.message); }
    setSavingCode(null);
  };

  return (
    <div>
      <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>VAT Rates</h2>
      <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 16 }}>
        Standard VAT rate per country. For VAT-registered accounts, sales are stripped of VAT
        using the rate for the order's destination country; fees are stripped using your own
        Company Country's rate (Amazon/Shopify charge VAT on fees based on where you're
        established, not the customer).
      </p>

      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 24px' }}>
        {error && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>{error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 110px 80px', gap: 8, fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <span>Code</span><span>Country</span><span>Rate %</span><span></span>
        </div>
        {rows.map(r => {
          const isEditing = editing[r.country_code] !== undefined;
          return (
            <div key={r.country_code} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 110px 80px', gap: 8, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{r.country_code}</span>
              <span style={{ fontSize: 13 }}>{r.country_name}</span>
              {isEditing ? (
                <input type="number" step="0.01" min="0" max="100" value={editing[r.country_code]}
                  onChange={e => setEditing(ed => ({ ...ed, [r.country_code]: e.target.value }))}
                  style={{ ...inputStyle, padding: '5px 8px' }} />
              ) : (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{parseFloat(r.standard_rate).toFixed(2)}%</span>
              )}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                {isEditing ? (
                  <button onClick={() => saveRate(r.country_code, r.country_name, editing[r.country_code])} disabled={savingCode === r.country_code}
                    style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>✓</button>
                ) : (
                  <button onClick={() => setEditing(ed => ({ ...ed, [r.country_code]: String(r.standard_rate) }))}
                    style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}>Edit</button>
                )}
                <button onClick={() => removeRate(r.country_code)} disabled={savingCode === r.country_code}
                  style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--red)', cursor: 'pointer' }}>×</button>
              </div>
            </div>
          );
        })}
        <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 110px 80px', gap: 8, alignItems: 'center', padding: '10px 0 4px' }}>
          <input type="text" maxLength={2} placeholder="GB" value={newRow.code} onChange={e => setNewRow(n => ({ ...n, code: e.target.value.toUpperCase() }))} style={{ ...inputStyle, padding: '5px 8px', textTransform: 'uppercase' }} />
          <input type="text" placeholder="Country name" value={newRow.name} onChange={e => setNewRow(n => ({ ...n, name: e.target.value }))} style={{ ...inputStyle, padding: '5px 8px' }} />
          <input type="number" step="0.01" min="0" max="100" placeholder="20.00" value={newRow.rate} onChange={e => setNewRow(n => ({ ...n, rate: e.target.value }))} style={{ ...inputStyle, padding: '5px 8px' }} />
          <button onClick={() => saveRate(newRow.code, newRow.name, newRow.rate)} disabled={savingCode === newRow.code}
            style={{ fontSize: 11, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>Add</button>
        </div>
      </div>
    </div>
  );
}

// ── Reporting subtab ───────────────────────────────────────────────────────
function TimezoneSettings({ config, onRefresh }) {
  const [timezone, setTimezone] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (config?.timezone && timezone === null) setTimezone(config.timezone);
  }, [config, timezone]);

  const handleSave = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const resp = await fetch('/api/settings/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone }),
      });
      const data = await resp.json();
      if (data.ok) { setSaved(true); onRefresh?.(); }
      else setError(data.error || 'Save failed');
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const dirty = timezone !== null && timezone !== config?.timezone;

  return (
    <div>
      <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Reporting Timezone</h2>
      <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 16 }}>
        All orders and refunds are dated against this timezone — it decides which calendar day
        and month an order or refund falls into throughout the dashboard, not just the display.
      </p>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={labelStyle}>Timezone</label>
            <select value={timezone || ''} onChange={e => { setTimezone(e.target.value); setSaved(false); }}
              style={{ ...inputStyle, cursor: 'pointer', maxWidth: 320, marginTop: 4 }}>
              {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>)}
            </select>
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
    </div>
  );
}

function ReportingSettings() {
  const { data: config, refetch } = useApi('/api/settings/config');
  const { data: vatRates, refetch: refetchVatRates } = useApi('/api/settings/vat-rates');
  const [currency, setCurrency] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

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

  const dirty = currency !== null && currency !== config?.reporting_currency;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Reporting Currency</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          All revenue, margin, and cash flow figures will be displayed in this currency.
          COGS entered in other currencies will be converted at the exchange rate on the order date.
          Revenues are recorded in GBP — conversion uses daily ECB rates synced automatically.
        </p>
      </div>

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

      <TimezoneSettings config={config} onRefresh={refetch} />
      <CompanyInfoSettings config={config} vatRates={vatRates} onRefresh={refetch} />
      <VatRatesSettings vatRates={vatRates} onRefresh={refetchVatRates} />
    </div>
  );
}
export default function Settings() {
  const isMobile = useIsMobile();
  const [subtab, setSubtab] = useState('cogs');
  const [brandFilter, setBrandFilter] = useState('');
  const [parentFilter, setParentFilter] = useState('');
  const { data: skus, loading, error, refetch } = useApi('/api/settings/cogs');
  const { data: brandsData } = useApi('/api/brands');

  const filteredSkus = useMemo(() => {
    if (!skus) return [];
    return skus.filter(r =>
      (!brandFilter || r.brand === brandFilter) &&
      (!parentFilter || r.parent_asin === parentFilter)
    );
  }, [skus, brandFilter, parentFilter]);

  return (
    <div style={{ padding: isMobile ? '16px' : '28px 32px', display: 'flex', flexDirection: 'column', gap: isMobile ? 18 : 24, maxWidth: 1100 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Settings</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Configure costs, channels, and cash flow assumptions</p>
      </div>

      {/* Subtabs */}
      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', paddingBottom: 16, flexWrap: 'wrap' }}>
        {SUBTABS.map(tab => (
          <button key={tab.id} onClick={() => !tab.soon && setSubtab(tab.id)}
            style={{ padding: '7px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid ' + (subtab === tab.id ? 'var(--accent2)' : 'var(--border)'), background: subtab === tab.id ? 'var(--accent2)20' : 'transparent', color: subtab === tab.id ? 'var(--accent2)' : 'var(--muted)', cursor: tab.soon ? 'not-allowed' : 'pointer', fontFamily: 'var(--font)', transition: 'all 0.15s', opacity: tab.soon ? 0.4 : 1 }}>
            {tab.label}{tab.soon && <span style={{ marginLeft: 6, fontSize: 9, letterSpacing: '0.08em' }}>SOON</span>}
          </button>
        ))}
      </div>

      {subtab === 'cogs' && (
        <div>
          <div style={{ marginBottom: 16, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Cost of Goods Sold</h2>
              <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                Enter landed cost per unit for each SKU. Each entry has an effective date range — COGS for an order is matched to the range covering its order date.
                Refunds are credited at the COGS of the original order date, not the refund date.
                Need to enter a lot of costs at once? Download the CSV, fill it in Excel, and upload it back.
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10, flexShrink: 0 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                {brandsData?.brands?.length > 0 && (
                  <select value={brandFilter} onChange={e => setBrandFilter(e.target.value)}
                    style={{ background: 'var(--bg2)', border: '1px solid ' + (brandFilter ? 'var(--accent)' : 'var(--border)'), borderRadius: 8, padding: '7px 12px', color: brandFilter ? 'var(--accent2)' : 'var(--muted)', fontSize: 12, fontFamily: 'var(--font)', cursor: 'pointer', fontWeight: 600 }}>
                    <option value="">All Brands</option>
                    {brandsData.brands.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                )}
                {brandsData?.parent_asins?.length > 0 && (
                  <select value={parentFilter} onChange={e => setParentFilter(e.target.value)}
                    style={{ background: 'var(--bg2)', border: '1px solid ' + (parentFilter ? 'var(--accent)' : 'var(--border)'), borderRadius: 8, padding: '7px 12px', color: parentFilter ? 'var(--accent2)' : 'var(--muted)', fontSize: 12, fontFamily: 'var(--font)', cursor: 'pointer', fontWeight: 600 }}>
                    <option value="">All Parent ASINs</option>
                    {brandsData.parent_asins.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                )}
              </div>
              <CogsCsvTools onRefresh={refetch} />
            </div>
          </div>
          {loading && <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--muted)' }}>Loading SKUs…</div>}
          {error && <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--red)' }}>{error}</div>}
          {!loading && !error && filteredSkus?.length === 0 && (
            <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--muted)' }}>
              {brandFilter || parentFilter ? 'No SKUs match this filter' : 'No SKUs found'}
            </div>
          )}
          {!loading && filteredSkus?.map(row => <CogsRow key={row.sku} row={row} onRefresh={refetch} />)}
        </div>
      )}
      {subtab === 'reporting' && <ReportingSettings />}
    </div>
  );
}
