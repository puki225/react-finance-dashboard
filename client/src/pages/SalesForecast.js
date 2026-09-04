import React, { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';

const fmtMoney = (n, sym = '£') => {
  const v = parseFloat(n || 0);
  const abs = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (v < 0 ? '−' : '') + sym + abs;
};
const fmtDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
const fmtDateFull = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

const STAGES = [
  { id: 'new', label: 'New', hex: '#6da7ec' },
  { id: 'growth', label: 'Growth', hex: '#2a78d6' },
  { id: 'mature', label: 'Mature', hex: '#1c5cab' },
  { id: 'plateau', label: 'Plateau', hex: 'var(--amber)' },
  { id: 'declining', label: 'Declining', hex: 'var(--red)' },
];
const stageMeta = (id) => STAGES.find(s => s.id === id) || { id, label: id || 'Unclassified', hex: 'var(--muted)' };

const cardStyle = {
  background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px',
};
const statCardStyle = { ...cardStyle, flex: 1, minWidth: 200, padding: '16px 18px' };
const cardLabel = { fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 };
const cardValue = { fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' };

// ─── Main chart: actual (solid) -> forecast (dashed) with uncertainty band ────────────────
function MainChart({ history, forecast, sym }) {
  const [hover, setHover] = useState(null);
  const W = 980, ML = 4, MR = 4, H = 220, XAXISH = 22;

  const days = useMemo(() => {
    const h = history.map(d => ({ date: d.date, value: parseFloat(d.revenue), actual: true }));
    const f = forecast.map(d => ({ date: d.date, value: parseFloat(d.revenue), low: parseFloat(d.low), high: parseFloat(d.high), actual: false }));
    return [...h, ...f];
  }, [history, forecast]);

  if (!days.length) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>No sales data yet.</div>;

  const todayIdx = history.length - 1;
  const N = days.length;
  const plotW = W - ML - MR;
  const slot = N > 1 ? plotW / (N - 1) : plotW;
  const x = (i) => ML + i * slot;

  const vals = days.map(d => d.actual ? d.value : (d.high ?? d.value));
  const lowVals = days.map(d => d.actual ? d.value : (d.low ?? d.value));
  const yMin = Math.min(...lowVals, 0) * (Math.min(...lowVals) < 0 ? 1.1 : 0.9);
  const yMax = Math.max(...vals) * 1.08 || 1;
  const y = (v) => H - ((v - yMin) / (yMax - yMin || 1)) * H;

  const ticks = [yMin, (yMin + yMax) / 2, yMax];

  let areaPath = '';
  if (todayIdx >= 0 && todayIdx < N - 1) {
    areaPath = `M${x(todayIdx)},${y(days[todayIdx].value)} `;
    for (let i = todayIdx; i < N; i++) areaPath += `L${x(i)},${y(days[i].high ?? days[i].value)} `;
    for (let i = N - 1; i >= todayIdx; i--) areaPath += `L${x(i)},${y(days[i].low ?? days[i].value)} `;
    areaPath += 'Z';
  }

  let actualPath = '';
  for (let i = 0; i <= todayIdx; i++) actualPath += (i === 0 ? 'M' : 'L') + x(i) + ',' + y(days[i].value) + ' ';
  let forecastPath = '';
  for (let i = Math.max(todayIdx, 0); i < N; i++) forecastPath += (i === Math.max(todayIdx, 0) ? 'M' : 'L') + x(i) + ',' + y(days[i].value) + ' ';

  const handleMove = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width * W;
    let i = Math.round((relX - ML) / slot);
    i = Math.max(0, Math.min(N - 1, i));
    setHover({ i, clientX: e.clientX, clientY: e.clientY });
  };

  const hoveredDay = hover ? days[hover.i] : null;

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H + XAXISH}`} width="100%" height={H + XAXISH} style={{ display: 'block', overflow: 'visible' }}
        onMouseMove={handleMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((v, idx) => {
          const yy = y(v);
          return (
            <g key={idx}>
              <line x1={ML} x2={W - MR} y1={yy} y2={yy} stroke="var(--border2)" strokeWidth={1} />
              <text x={ML} y={yy - 4} fontFamily="var(--mono)" fontSize={10} fill="var(--muted)">{sym}{Math.round(v / 1000)}K</text>
            </g>
          );
        })}
        {todayIdx >= 0 && todayIdx < N && (
          <>
            <line x1={x(todayIdx)} x2={x(todayIdx)} y1={0} y2={H} stroke="var(--border2)" strokeWidth={1} />
            <text x={x(todayIdx)} y={12} fontFamily="var(--mono)" fontSize={10} fill="var(--muted)" textAnchor="middle">Today</text>
          </>
        )}
        {areaPath && <path d={areaPath} fill="var(--accent)" opacity={0.12} />}
        <path d={actualPath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {forecastPath && <path d={forecastPath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="5,4" strokeLinejoin="round" strokeLinecap="round" />}
        {N > 0 && (
          <>
            <circle cx={x(N - 1)} cy={y(days[N - 1].value)} r={4} fill="var(--accent2)" stroke="var(--bg2)" strokeWidth={2} />
            <text x={x(N - 1) - 8} y={y(days[N - 1].value) - 10} fontFamily="var(--mono)" fontSize={11} fontWeight={500} fill="var(--text)" textAnchor="end">
              {fmtMoney(days[N - 1].value, sym)}/day
            </text>
          </>
        )}
        {[0, todayIdx > 0 ? todayIdx : null, N - 15 > todayIdx ? N - 15 : null, N - 1].filter(i => i !== null && i >= 0).map(i => (
          <text key={i} x={x(i)} y={H + 16} fontFamily="var(--mono)" fontSize={10} fill="var(--muted)"
            textAnchor={i === 0 ? 'start' : (i === N - 1 ? 'end' : 'middle')}>
            {fmtDate(days[i].date)}
          </text>
        ))}
        {hover && (
          <>
            <line x1={x(hover.i)} x2={x(hover.i)} y1={0} y2={H} stroke="var(--border2)" strokeWidth={1} />
            <circle cx={x(hover.i)} cy={y(days[hover.i].value)} r={4} fill="var(--accent2)" stroke="var(--bg2)" strokeWidth={2} />
          </>
        )}
      </svg>
      {hoveredDay && (
        <div style={{
          position: 'fixed', left: hover.clientX + 14, top: hover.clientY - 60, pointerEvents: 'none',
          background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 8, padding: '9px 11px',
          fontSize: 11, lineHeight: 1.6, boxShadow: '0 8px 24px #00000060', zIndex: 5, minWidth: 150,
        }}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
            {fmtDateFull(hoveredDay.date)}{!hoveredDay.actual && ' · forecast'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
            <span>Revenue</span><span style={{ fontFamily: 'var(--mono)', fontWeight: 500 }}>{fmtMoney(hoveredDay.value, sym)}</span>
          </div>
          {!hoveredDay.actual && hoveredDay.low !== undefined && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
              <span>Range</span><span style={{ fontFamily: 'var(--mono)', fontWeight: 500 }}>{fmtMoney(hoveredDay.low, sym)} – {fmtMoney(hoveredDay.high, sym)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Stage distribution — small ordinal bar chart ─────────────────────────────────────────
function StageChart({ skus }) {
  const counts = STAGES.map(s => ({ ...s, count: skus.filter(sk => sk.stage === s.id).length }));
  const unclassified = skus.filter(sk => !sk.stage).length;
  const W = 480, H = 130, ML = 4, MR = 4, XAXISH = 20;
  const all = unclassified ? [...counts, { id: null, label: 'Unclassified', hex: 'var(--muted)', count: unclassified }] : counts;
  const maxCount = Math.max(...all.map(c => c.count), 1) * 1.2;
  const plotW = W - ML - MR;
  const slot = plotW / all.length;
  const y = (v) => H - (v / maxCount) * H;
  const barW = Math.min(40, slot - 10);

  return (
    <svg viewBox={`0 0 ${W} ${H + XAXISH}`} width="100%" height={H + XAXISH} style={{ display: 'block', maxWidth: 480, overflow: 'visible' }}>
      <line x1={ML} x2={W - MR} y1={H} y2={H} stroke="var(--border2)" strokeWidth={1} />
      {all.map((s, i) => {
        const cx = ML + slot * i + slot / 2;
        const top = y(s.count);
        const r = s.count > 0 ? 4 : 0;
        const path = `M${cx - barW / 2},${H} L${cx - barW / 2},${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} L${cx + barW / 2 - r},${top} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} L${cx + barW / 2},${H} Z`;
        return (
          <g key={s.id || 'none'}>
            <path d={path} fill={s.hex} />
            <text x={cx} y={top - 8} fontFamily="var(--mono)" fontSize={11} fontWeight={500} fill="var(--text)" textAnchor="middle">{s.count}</text>
            <text x={cx} y={H + 15} fontFamily="var(--mono)" fontSize={10} fill="var(--muted)" textAnchor="middle">{s.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function SalesForecast() {
  const { data, loading, error, refetch } = useApi('/api/sales-forecast', { history_days: 60 });
  const [savingSku, setSavingSku] = useState(null);
  const sym = data?.currency_symbol || '£';
  const history = data?.history || [];
  const forecast = data?.forecast || [];
  const skus = data?.skus || [];
  const hasForecast = !!data?.has_forecast;

  const last30Total = useMemo(() => history.slice(-30).reduce((s, d) => s + parseFloat(d.revenue || 0), 0), [history]);
  const next30Total = useMemo(() => forecast.slice(0, 30).reduce((s, d) => s + parseFloat(d.revenue || 0), 0), [forecast]);
  const deltaPct = last30Total > 0 ? ((next30Total - last30Total) / last30Total) * 100 : null;
  const flaggedCount = useMemo(() => skus.filter(s => s.excluded_count > 0 || (s.stage === 'plateau' && !s.stage_override)).length, [skus]);

  const sortedSkus = useMemo(() => [...skus].sort((a, b) => parseFloat(b.next_30d_revenue || 0) - parseFloat(a.next_30d_revenue || 0)), [skus]);

  async function updateConfig(sku, body) {
    setSavingSku(sku);
    try {
      const res = await fetch(`/api/sales-forecast/config/${encodeURIComponent(sku)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed'); }
      refetch();
    } catch (e) {
      alert(e.message);
    } finally {
      setSavingSku(null);
    }
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Sales Forecast</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 780 }}>
          Per-SKU revenue forecast, segmented by growth stage, with seasonality and outlier
          exclusion. Set a manual stage override or flag a SKU end-of-life below — both are
          respected by the next nightly run. Feeds the Cash Flow tab's future-inflow assumption.
        </p>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
      ) : error ? (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--red)15', border: '1px solid var(--red)', fontSize: 13, color: 'var(--red)' }}>
          Failed to load: {error}
        </div>
      ) : (
        <>
          {!hasForecast && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--amber)15', border: '1px solid var(--amber)', fontSize: 13, color: 'var(--amber)' }}>
              No forecast has been generated yet — the nightly forecasting job hasn't run. Showing historical actuals only.
            </div>
          )}

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={statCardStyle}>
              <div style={cardLabel}>Last 30 days (actual)</div>
              <div style={cardValue}>{fmtMoney(last30Total, sym)}</div>
            </div>
            <div style={statCardStyle}>
              <div style={cardLabel}>Next 30 days (forecast)</div>
              <div style={{ ...cardValue, color: hasForecast ? 'var(--accent2)' : 'var(--muted)' }}>
                {hasForecast ? fmtMoney(next30Total, sym) : '—'}
              </div>
              {deltaPct !== null && hasForecast && (
                <div style={{ fontSize: 11, marginTop: 4, color: deltaPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}% vs trailing 30d
                </div>
              )}
            </div>
            <div style={statCardStyle}>
              <div style={cardLabel}>SKUs flagged</div>
              <div style={cardValue}>{flaggedCount}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Plateauing or with excluded outlier periods</div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Aggregate revenue — actual → forecast</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
              Solid = actual daily revenue. Dashed = projected. Shaded band = forecast uncertainty.
            </div>
            <MainChart history={history} forecast={forecast} sym={sym} />
            <div style={{ display: 'flex', gap: 16, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                <span style={{ width: 14, height: 2, background: 'var(--accent)' }} />Actual
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                <span style={{ width: 14, height: 0, borderTop: '2px dashed var(--accent)' }} />Forecast
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent)', opacity: 0.15, border: '1px solid var(--accent2)' }} />Uncertainty range
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>SKUs by growth stage</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
              Lifecycle stage drives which curve shape the model fits. Override below if the auto-classification looks wrong.
            </div>
            <StageChart skus={skus} />
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Per-SKU forecast</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
              Sorted by next-30d forecast. Stage and end-of-life are editable — changes apply on the next nightly run.
            </div>
            {!sortedSkus.length ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No SKUs with recent sales.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['SKU', 'Stage', 'End of life', 'Last 30d', 'Next 30d', 'Δ'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: i >= 3 ? 'right' : 'left', fontSize: 10, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSkus.map(s => {
                      const last30 = parseFloat(s.last_30d_revenue || 0);
                      const next30 = parseFloat(s.next_30d_revenue || 0);
                      const delta = last30 > 0 ? ((next30 - last30) / last30) * 100 : null;
                      const meta = stageMeta(s.stage);
                      const saving = savingSku === s.sku;
                      return (
                        <tr key={s.sku} style={{ borderBottom: '1px solid var(--border)', opacity: saving ? 0.5 : 1 }}>
                          <td style={{ padding: '9px 10px', fontSize: 12 }}>
                            <div style={{ fontWeight: 600 }}>{s.product_title || s.sku}</div>
                            <div style={{ fontSize: 10, color: 'var(--muted)' }}>{s.sku}</div>
                            {s.excluded_count > 0 && (
                              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                                ⚑ {s.excluded_count} period{s.excluded_count > 1 ? 's' : ''} excluded{s.last_exclusion_reason ? ` — ${s.last_exclusion_reason}` : ''}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '9px 10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: meta.hex }} />
                              <select
                                value={s.stage_override || ''}
                                disabled={saving}
                                onChange={e => updateConfig(s.sku, { stage_override: e.target.value || null })}
                                style={{ background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font)', padding: '4px 6px' }}
                              >
                                <option value="">Auto{s.auto_stage ? ` (${stageMeta(s.auto_stage).label})` : ''}</option>
                                {STAGES.map(st => <option key={st.id} value={st.id}>{st.label}</option>)}
                              </select>
                            </div>
                          </td>
                          <td style={{ padding: '9px 10px' }}>
                            <input
                              type="checkbox"
                              checked={!!s.is_end_of_life}
                              disabled={saving}
                              onChange={e => updateConfig(s.sku, { is_end_of_life: e.target.checked })}
                              style={{ width: 16, height: 16, cursor: 'pointer' }}
                            />
                          </td>
                          <td style={{ padding: '9px 10px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtMoney(last30, sym)}</td>
                          <td style={{ padding: '9px 10px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', color: hasForecast ? 'var(--text)' : 'var(--muted)' }}>
                            {hasForecast ? fmtMoney(next30, sym) : '—'}
                          </td>
                          <td style={{ padding: '9px 10px', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'right', color: delta === null ? 'var(--muted)' : (delta >= 0 ? 'var(--green)' : 'var(--red)') }}>
                            {hasForecast && delta !== null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
