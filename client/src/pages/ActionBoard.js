import React, { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';

const STAGES = [
  { id: 'todo', label: 'To Do', color: '#f87171' },
  { id: 'doing', label: 'Doing', color: '#fbbf24' },
  { id: 'done', label: 'Done', color: '#34d399' },
];

const fmtMoney = (sym, n) => `${sym}${Math.round(Math.abs(parseFloat(n || 0))).toLocaleString('en-GB')}`;
const pctColor = (p) => p >= 66 ? '#34d399' : p >= 33 ? '#fbbf24' : '#f87171';
const fmtKpi = (v, unit) => unit === '%' ? `${parseFloat(v).toFixed(1)}%` : `${Math.round(parseFloat(v)).toLocaleString('en-GB')} ${unit || ''}`.trim();
const fmtAgo = (iso) => {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
};

async function postCard(id, body) {
  const resp = await fetch(`/api/action-board/cards/${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.error || 'Request failed'); }
  return resp.json();
}
async function revertCard(id) {
  const resp = await fetch(`/api/action-board/cards/${id}/revert`, { method: 'POST' });
  if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.error || 'Request failed'); }
  return resp.json();
}

function Card({ card, onMove, onDismiss, onUndismiss, onRevert, dragEnabled }) {
  const [busy, setBusy] = useState(false);
  const impact = card.effective_impact ?? card.impact_amount;
  const hasImpactOverride = card.impact_amount_override !== null && card.impact_amount_override !== undefined;
  const pct = Math.round(parseFloat(card.pct_complete || 0));
  const stageIdx = STAGES.findIndex(s => s.id === card.stage);
  const wrap = async (fn) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };

  return (
    <div
      draggable={dragEnabled}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(card.id)); }}
      style={{
        background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 10,
        padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
        cursor: dragEnabled ? 'grab' : 'default', opacity: busy ? 0.6 : card.dismissed ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{card.title}</div>
        <div style={{ flexShrink: 0, textAlign: 'right' }}>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: 'var(--mono)', color: '#f87171' }}>
            {fmtMoney(card.currency_symbol, impact)}
          </div>
          <div style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>/ month{hasImpactOverride ? ' · edited' : ''}</div>
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>{card.description}</div>

      {card.kpi_name && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
            <span>{card.kpi_name}: <span style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{fmtKpi(card.kpi_value, card.kpi_unit)}</span></span>
            <span>target <span style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{fmtKpi(card.kpi_target, card.kpi_unit)}</span></span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--bg)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: pctColor(pct), transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>{pct}% of the way there</div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {card.user_override && (
            <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 10, background: '#7c6af720', color: 'var(--accent2)', fontWeight: 700, letterSpacing: '0.03em' }}>YOU MOVED THIS</span>
          )}
          {!card.user_override && (
            <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 10, background: '#ffffff0c', color: 'var(--muted)', fontWeight: 700, letterSpacing: '0.03em' }}>AI</span>
          )}
          {card.dismissed && (
            <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 10, background: '#f8717120', color: '#f87171', fontWeight: 700, letterSpacing: '0.03em' }}>DISMISSED</span>
          )}
          <span style={{ fontSize: 9, color: 'var(--muted)' }}>detected {fmtAgo(card.first_detected_at)}</span>
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          {!dragEnabled && !card.dismissed && (
            <>
              <button disabled={stageIdx <= 0} onClick={() => wrap(() => onMove(card.id, STAGES[stageIdx - 1].id))}
                title="Move back" style={pillBtnStyle(stageIdx <= 0)}>←</button>
              <button disabled={stageIdx >= STAGES.length - 1} onClick={() => wrap(() => onMove(card.id, STAGES[stageIdx + 1].id))}
                title="Move forward" style={pillBtnStyle(stageIdx >= STAGES.length - 1)}>→</button>
            </>
          )}
          {card.dismissed ? (
            <button onClick={() => wrap(() => onUndismiss(card.id))} style={pillBtnStyle(false)}>Undismiss</button>
          ) : (
            <button onClick={() => wrap(() => onDismiss(card.id))} style={pillBtnStyle(false)} title="Hide this card">Dismiss</button>
          )}
          {(card.user_override || card.dismissed || hasImpactOverride) && (
            <button onClick={() => wrap(() => onRevert(card.id))} style={{ ...pillBtnStyle(false), color: 'var(--accent2)' }} title="Undo every manual change, back to the AI's own suggestion">
              ↺ Revert to AI
            </button>
          )}
        </div>
      </div>
      {card.override_note && (
        <div style={{ fontSize: 11, color: 'var(--accent2)', fontStyle: 'italic', borderTop: '1px solid var(--border)', paddingTop: 8 }}>“{card.override_note}”</div>
      )}
    </div>
  );
}

function pillBtnStyle(disabled) {
  return {
    fontSize: 11, padding: '4px 9px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--bg2)', color: disabled ? 'var(--muted)' : 'var(--text)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1, fontFamily: 'var(--font)',
  };
}

export default function ActionBoard() {
  const isMobile = useIsMobile();
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [reevaluating, setReevaluating] = useState(false);
  const [dragOverStage, setDragOverStage] = useState(null);
  const [actionError, setActionError] = useState(null);
  const { data, loading, error, refetch } = useApi('/api/action-board/cards', includeDismissed ? { include_dismissed: 'true' } : {});

  const cards = data?.cards || [];
  const byStage = useMemo(() => {
    const m = { todo: [], doing: [], done: [] };
    for (const c of cards) {
      if (c.dismissed && !includeDismissed) continue;
      (m[c.stage] || m.todo).push(c);
    }
    return m;
  }, [cards, includeDismissed]);

  const runGuarded = async (fn) => {
    try { setActionError(null); await fn(); await refetch(); }
    catch (e) { setActionError(e.message); }
  };
  const onMove = (id, stage) => runGuarded(() => postCard(id, { stage }));
  const onDismiss = (id) => runGuarded(() => postCard(id, { dismissed: true }));
  const onUndismiss = (id) => runGuarded(() => postCard(id, { dismissed: false }));
  const onRevert = (id) => runGuarded(() => revertCard(id));

  const reevaluateNow = async () => {
    setReevaluating(true);
    try { setActionError(null); await fetch('/api/action-board/reevaluate', { method: 'POST' }); await refetch(); }
    catch (e) { setActionError(e.message); }
    finally { setReevaluating(false); }
  };

  const dragEnabled = !isMobile;

  return (
    <div style={{ padding: isMobile ? '16px' : '28px 32px', display: 'flex', flexDirection: 'column', gap: isMobile ? 18 : 24, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>AI Action Board</h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
            Business problems with a real £ cost, ranked by impact — re-prioritized daily{data?.generated_at ? `, last run ${fmtAgo(data.generated_at)}` : ''}.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={includeDismissed} onChange={e => setIncludeDismissed(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: 'var(--accent)', cursor: 'pointer' }} />
            Show dismissed
          </label>
          <button onClick={reevaluateNow} disabled={reevaluating} style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--accent)20',
            color: 'var(--accent2)', fontWeight: 600, fontSize: 12, cursor: reevaluating ? 'not-allowed' : 'pointer', fontFamily: 'var(--font)',
          }}>
            {reevaluating ? 'Re-running…' : '↻ Re-run now'}
          </button>
        </div>
      </div>

      {actionError && (
        <div style={{ fontSize: 12, color: '#f87171', background: '#f8717115', border: '1px solid #f8717140', borderRadius: 8, padding: '8px 12px' }}>{actionError}</div>
      )}

      {loading && <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading board…</div>}
      {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}

      {!loading && !error && (
        <div style={{ display: 'flex', gap: 16, flex: 1, overflowX: 'auto', paddingBottom: 8 }}>
          {STAGES.map(stage => {
            const stageCards = byStage[stage.id] || [];
            const total = stageCards.reduce((s, c) => s + parseFloat(c.effective_impact ?? c.impact_amount ?? 0), 0);
            const sym = stageCards[0]?.currency_symbol || '£';
            return (
              <div
                key={stage.id}
                onDragOver={(e) => { if (dragEnabled) { e.preventDefault(); setDragOverStage(stage.id); } }}
                onDragLeave={() => setDragOverStage(null)}
                onDrop={(e) => {
                  if (!dragEnabled) return;
                  e.preventDefault();
                  setDragOverStage(null);
                  const id = parseInt(e.dataTransfer.getData('text/plain'), 10);
                  if (id) onMove(id, stage.id);
                }}
                style={{
                  flex: '1 1 0', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 10,
                  background: dragOverStage === stage.id ? 'var(--accent)10' : 'transparent',
                  border: dragOverStage === stage.id ? '1px dashed var(--accent)' : '1px dashed transparent',
                  borderRadius: 12, padding: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: stage.color }} />
                    <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{stage.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{stageCards.length}</span>
                  </div>
                  {total > 0 && <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtMoney(sym, total)}/mo</span>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
                  {stageCards.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: '24px 0' }}>Nothing here</div>
                  )}
                  {stageCards.map(card => (
                    <Card key={card.id} card={card} onMove={onMove} onDismiss={onDismiss} onUndismiss={onUndismiss} onRevert={onRevert} dragEnabled={dragEnabled && !card.dismissed} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
