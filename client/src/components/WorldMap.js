import React, { useMemo, useState } from 'react';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';

const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

// ISO 3166-1 numeric -> alpha-2, covering the countries a UK-based e-commerce
// seller is realistically going to ship to. world-atlas topojson keys features
// by numeric code; our shipping_country data is alpha-2, so we bridge here.
const NUMERIC_TO_ALPHA2 = {
  '826': 'GB', '840': 'US', '124': 'CA', '036': 'AU', '276': 'DE', '250': 'FR',
  '380': 'IT', '724': 'ES', '528': 'NL', '056': 'BE', '756': 'CH', '040': 'AT',
  '208': 'DK', '246': 'FI', '352': 'IS', '372': 'IE', '428': 'LV', '440': 'LT',
  '233': 'EE', '616': 'PL', '203': 'CZ', '703': 'SK', '348': 'HU', '642': 'RO',
  '100': 'BG', '300': 'GR', '620': 'PT', '752': 'SE', '578': 'NO', '643': 'RU',
  '156': 'CN', '392': 'JP', '410': 'KR', '356': 'IN', '554': 'NZ', '076': 'BR',
  '484': 'MX', '032': 'AR', '152': 'CL', '170': 'CO', '604': 'PE', '862': 'VE',
  '710': 'ZA', '818': 'EG', '566': 'NG', '404': 'KE', '792': 'TR', '682': 'SA',
  '784': 'AE', '376': 'IL', '586': 'PK', '050': 'BD', '360': 'ID', '458': 'MY',
  '702': 'SG', '764': 'TH', '704': 'VN', '608': 'PH', '344': 'HK', '158': 'TW',
  '191': 'HR', '705': 'SI', '070': 'BA', '807': 'MK', '498': 'MD', '804': 'UA',
  '112': 'BY', '442': 'LU', '470': 'MT', '196': 'CY', '020': 'AD', '492': 'MC',
  '674': 'SM', '336': 'VA', '438': 'LI',
};

// Alpha-2 -> ISO 3166-1 numeric, for looking a country up from our data
const ALPHA2_TO_NUMERIC = Object.fromEntries(Object.entries(NUMERIC_TO_ALPHA2).map(([n, a]) => [a, n]));

function countryName(alpha2) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(alpha2) || alpha2;
  } catch { return alpha2; }
}

// Floating tooltip that follows the cursor — mirrors the dark card style used by the
// Revenue Trend / Gateway tooltips elsewhere on Sales Summary.
function MapTooltip({ hover, fmt }) {
  if (!hover) return null;
  const { row, alpha2, x, y } = hover;
  const marginPct = parseFloat(row.gross_margin_pct || 0);
  const refundPct = parseFloat(row.refund_pct || 0);
  return (
    <div style={{
      position: 'fixed', left: x + 16, top: y + 16, zIndex: 1000, pointerEvents: 'none',
      background: '#1a1a24', border: '1px solid #ffffff18', borderRadius: 8, padding: '10px 14px', minWidth: 170,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <img src={`https://flagcdn.com/20x15/${alpha2.toLowerCase()}.png`} alt={alpha2} style={{ width: 16, height: 12, borderRadius: 2, objectFit: 'cover' }} onError={e => { e.target.style.display = 'none'; }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#e8e8f0' }}>{countryName(alpha2)}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontFamily: 'var(--mono)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}><span style={{ color: '#8b8ba0' }}>Gross Sales</span><span style={{ color: '#e8e8f0' }}>{fmt(row.gross_sales)}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}><span style={{ color: '#8b8ba0' }}>Net Sales</span><span style={{ color: '#34d399' }}>{fmt(row.net_revenue)}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}><span style={{ color: '#8b8ba0' }}>Refund Rate</span><span style={{ color: refundPct > 0 ? '#f87171' : '#8b8ba0' }}>{row.refund_pct}%</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}><span style={{ color: '#8b8ba0' }}>Gross Margin</span><span style={{ color: marginPct >= 20 ? '#34d399' : '#f87171' }}>{row.gross_margin_pct}%</span></div>
      </div>
    </div>
  );
}

export default function WorldMap({ data = [], fmt = (n) => n }) {
  const [hover, setHover] = useState(null);

  const byAlpha2 = useMemo(() => {
    const map = {};
    for (const row of data) {
      if (row.country && row.country !== 'Unknown') map[row.country.toUpperCase()] = row;
    }
    return map;
  }, [data]);

  const maxGross = useMemo(() => Math.max(1, ...data.map(r => parseFloat(r.gross_sales || 0))), [data]);

  return (
    <div style={{ position: 'relative' }}>
      <ComposableMap projectionConfig={{ scale: 148 }} style={{ width: '100%', height: 'auto' }}>
        <Geographies geography={GEO_URL}>
          {({ geographies }) =>
            geographies.map(geo => {
              const numeric = String(geo.id).padStart(3, '0');
              const alpha2 = NUMERIC_TO_ALPHA2[numeric];
              const row = alpha2 ? byAlpha2[alpha2] : null;
              const intensity = row ? 0.25 + 0.75 * (parseFloat(row.gross_sales) / maxGross) : 0;
              const fill = row ? `rgba(124, 106, 247, ${intensity.toFixed(2)})` : '#26263a';
              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill={fill}
                  stroke="#0d0d14"
                  strokeWidth={0.5}
                  style={{
                    default: { outline: 'none' },
                    hover: { outline: 'none', fill: row ? '#a78bfa' : '#33334a', cursor: row ? 'pointer' : 'default' },
                    pressed: { outline: 'none' },
                  }}
                  onMouseEnter={(evt) => { if (row) setHover({ row, alpha2, x: evt.clientX, y: evt.clientY }); }}
                  onMouseMove={(evt) => { if (row) setHover(h => (h ? { ...h, x: evt.clientX, y: evt.clientY } : h)); }}
                  onMouseLeave={() => setHover(null)}
                />
              );
            })
          }
        </Geographies>
      </ComposableMap>
      <MapTooltip hover={hover} fmt={fmt} />
    </div>
  );
}

export { countryName, ALPHA2_TO_NUMERIC };
