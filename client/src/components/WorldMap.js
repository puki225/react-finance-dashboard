import React, { useMemo } from 'react';
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

export default function WorldMap({ data = [] }) {
  const byAlpha2 = useMemo(() => {
    const map = {};
    for (const row of data) {
      if (row.country && row.country !== 'Unknown') map[row.country.toUpperCase()] = row;
    }
    return map;
  }, [data]);

  const maxGross = useMemo(() => Math.max(1, ...data.map(r => parseFloat(r.gross_sales || 0))), [data]);

  return (
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
              >
                <title>
                  {row ? `${countryName(alpha2)}: ${row.units_sold} units` : (alpha2 ? countryName(alpha2) : '')}
                </title>
              </Geography>
            );
          })
        }
      </Geographies>
    </ComposableMap>
  );
}

export { countryName, ALPHA2_TO_NUMERIC };
