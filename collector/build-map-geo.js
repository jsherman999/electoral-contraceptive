#!/usr/bin/env node
// Builds site/geo/us-map.json for the 3D map (site/map.html): every state outline, plus county shapes for
// the states on the board. Source: the us-atlas package's counties-10m.json (Census cartographic
// boundaries at 1:10,000,000, ISC license).
//
//   npm pack us-atlas@3.0.1 && tar xzf us-atlas-3.0.1.tgz
//   node collector/build-map-geo.js package/counties-10m.json
//
// County shapes are keyed by geoCountyKey(name), the same key the map computes from each precinct's
// county, and the script reports any 2024-baseline county that has no shape.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { geoCountyKey } from '../site/js/shared/normalize.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) {
  console.error('usage: node collector/build-map-geo.js <path to us-atlas counties-10m.json>');
  process.exit(1);
}

const FIPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC',
  '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT',
  '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT',
  '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY',
};

const topo = JSON.parse(fs.readFileSync(src, 'utf8'));
const [sx, sy] = topo.transform.scale;
const [tx, ty] = topo.transform.translate;
const r3 = (v) => Math.round(v * 1000) / 1000;

// TopoJSON arcs are quantized and delta-encoded.
const arcs = topo.arcs.map((arc) => {
  let x = 0;
  let y = 0;
  return arc.map(([dx, dy]) => {
    x += dx;
    y += dy;
    return [r3(x * sx + tx), r3(y * sy + ty)];
  });
});

function ring(ids) {
  const pts = [];
  for (const i of ids) {
    const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
    for (let k = pts.length ? 1 : 0; k < a.length; k++) {
      const p = a[k];
      const q = pts[pts.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
    }
  }
  return pts;
}

function geometry(g) {
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.arcs.map(ring) };
  if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: g.arcs.map((p) => p.map(ring)) };
  return null;
}

const board = JSON.parse(fs.readFileSync(path.join(root, 'site/board.json'), 'utf8'));
const boardStates = new Set(Object.keys(board.races).map((id) => id.slice(0, 2)));

const states = topo.objects.states.geometries
  .filter((g) => FIPS[g.id])
  .map((g) => ({ type: 'Feature', properties: { st: FIPS[g.id], name: g.properties.name }, geometry: geometry(g) }));

const counties = [];
const keys = {};
for (const g of topo.objects.counties.geometries) {
  const st = FIPS[g.id.slice(0, 2)];
  if (!st || !boardStates.has(st)) continue;
  // Virginia's independent cities share names with counties (Richmond city / Richmond County).
  const name = st === 'VA' && Number(g.id.slice(2)) >= 500 ? `${g.properties.name} city` : g.properties.name;
  const k = geoCountyKey(name);
  (keys[st] ||= new Set()).add(k);
  counties.push({ type: 'Feature', properties: { st, k, name, fips: g.id }, geometry: geometry(g) });
}

// Report baseline counties without a shape (their precincts are placed at the state's center instead).
for (const st of [...boardStates].sort()) {
  const f = path.join(root, 'baseline', `${st.toLowerCase()}.json.gz`);
  if (!fs.existsSync(f)) continue;
  const b = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  const names = [...new Set(b.precincts.map((p) => p[0]))];
  const missing = names.filter((n) => !keys[st]?.has(geoCountyKey(n)));
  console.log(`${st}: ${names.length - missing.length}/${names.length} counties matched${missing.length ? ` (no shape: ${missing.join(', ')})` : ''}`);
}

const out = {
  source: 'us-atlas 3.0.1 counties-10m (US Census Bureau cartographic boundaries)',
  states: { type: 'FeatureCollection', features: states },
  counties: { type: 'FeatureCollection', features: counties },
};
const file = path.join(root, 'site/geo/us-map.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out));
console.log(`wrote ${path.relative(root, file)}: ${states.length} states, ${counties.length} counties, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
