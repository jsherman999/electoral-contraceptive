// 2024 baselines: load baseline/<st>.json.gz and match live precincts to them.
//
// File format (written by build-baseline.js):
// { state, election, source, built,
//   precincts: [[county, precinct, presCells|null, houseCells|null, houseDistrict|null, batchFlag?], ...] }
// cells = { ED: [D, R, O], EV: [...], MAIL: [...], PROV: [...] } or { TOTAL: [...] }
//
// Batches. Many counties report some votes as countywide "batches" instead of by precinct: absentee,
// provisional, and early votes by voting site ("EV-SELMA", "ONE STOP 2"). Whether a county does this can
// change between 2024 and 2026, so matching works vote mode by vote mode:
//   * a mode the county reports in 2026 batches is compared at the county-batch level (all of a county's
//     2026 batches are merged into one unit, because early-vote site names change between elections);
//   * a mode the county reports by precinct in 2026 but batched in 2024 has the 2024 batch votes spread
//     back over the precincts (each party in proportion to its precinct vote);
//   * in a county split between districts, the 2024 batch is scaled by this race's share of each party's
//     2024 precinct vote in that county.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { countyKey, precinctKeys, isVirtualPrecinct } from '../../site/js/shared/normalize.js';

const cache = new Map();
const KINDS = ['pres', 'house'];

function sumInto(a, b) {
  a[0] += b[0];
  a[1] += b[1];
  a[2] += b[2];
  return a;
}
function addCells(into, cells) {
  if (!cells) return into;
  into ||= {};
  for (const [m, v] of Object.entries(cells)) sumInto((into[m] ||= [0, 0, 0]), v);
  return into;
}
function sumCells(cells) {
  const t = [0, 0, 0];
  if (cells) for (const v of Object.values(cells)) sumInto(t, v);
  return t;
}
const round1 = (x) => Math.round(x * 10) / 10;
const tot = (c) => (c ? c[0] + c[1] + c[2] : 0);

// ---------------------------------------------------------------- Michigan jurisdictions
// Michigan numbers precincts within each city or township. The 2024 files say
// "STERLING HEIGHTS CITY 12 Ward 0" / "SHELBY CHARTER TOWNSHIP 3 Ward 0", county sites (Clarity) say
// "Sterling Heights, Pct 12" / "Shelby Twp, Pct 3". Several townships consolidated and renumbered their
// precincts after 2024, so precinct numbers are only trusted where a jurisdiction kept the same set.
const miName = (s) =>
  String(s)
    .toUpperCase()
    .replace(/\bSAINT\b/g, 'ST')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 2024 baseline name -> { jur: "T:SHELBY", num: 3, ward: 0 } ("SOUTH HAVEN CITY 1 Ward 3" -> ward 3) */
export function miBaselineKey(name) {
  const m = String(name).match(/^(.*?)\s+(CHARTER\s+TOWNSHIP|CHARTER\s+TWP|TOWNSHIP|TWP|CITY|VILLAGE)\s+(\d+)(?:\s+WARD\s+(\d*)\S*)?$/i);
  if (!m) return null;
  const type = /CITY/i.test(m[2]) ? 'C' : /VILLAGE/i.test(m[2]) ? 'V' : 'T';
  return { jur: `${type}:${miName(m[1])}`, num: Number(m[3]), ward: Number(m[4]) || 0 };
}

/**
 * County-site name -> key. Clarity: "Shelby Twp, Pct 3", "Richmond City, Pct 1", "Grosse Pointe Shores 2".
 * Enhanced Voting: "City of Bangor, Precinct 1", "Charter Township of Clinton, Precinct 3".
 */
export function miLiveKey(name) {
  let s = String(name).trim();
  // "City of Lansing, Ward 1, Precinct 2": take the ward out before reading the jurisdiction
  let ward = 0;
  s = s.replace(/,?\s*\bWard\s+(\d+)\b\s*,?/i, (_, w) => {
    ward = Number(w);
    return ', ';
  });
  const of = s.match(/^(?:Charter\s+)?(City|Township|Twp|Village)\s+of\s+(.+?)(\s*,.*|\s+(?:Pct|Precinct|Prec)\b.*|\s+#?\d+)$/i);
  if (of) s = `${of[2]} ${of[1]}${of[3]}`;
  const m = s.match(/^(.*?)(?:\s+(Charter\s+Township|Charter\s+Twp|Township|Twp|City|Village))?\s*,?\s*(?:(?:Pct|Precinct|Prec)\.?\s*)?#?\s*0*(\d+)$/i);
  if (!m || !m[1].trim()) return null;
  const type = !m[2] || /CITY/i.test(m[2]) ? 'C' : /VILLAGE/i.test(m[2]) ? 'V' : 'T';
  return { jur: `${type}:${miName(m[1])}`, num: Number(m[3]), ward, label: `${m[1].trim()}${m[2] ? ` ${m[2]}` : ''}` };
}

export function loadBaseline(dir, st) {
  const key = `${dir}|${st}`;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(dir, `${st.toLowerCase()}.json.gz`);
  if (!fs.existsSync(file)) {
    cache.set(key, null);
    return null;
  }
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  const idx = { state: data.state, source: data.source, election: data.election, counties: new Map() };
  for (const [county, precinct, pres, house, hd, vflag] of data.precincts) {
    const ck = countyKey(county);
    let c = idx.counties.get(ck);
    if (!c) {
      c = { key: ck, name: county, exact: new Map(), alt: new Map(), real: 0, byDist: new Map(), pres: null, house: null, vpres: null, vhouse: null, rpres: [0, 0, 0], rhouse: [0, 0, 0], rmpres: null, rmhouse: null };
      idx.counties.set(ck, c);
    }
    const keys = precinctKeys(precinct);
    const rec = { county, precinct, pres, house, hd, keys, id: `${ck}|${keys[0] || precinct}`, virtual: vflag === undefined ? isVirtualPrecinct(precinct) : vflag === 1 };
    if (idx.state === 'MI' && !rec.virtual) {
      const mk = miBaselineKey(precinct);
      if (mk) {
        rec.mi = mk;
        c.miJur ||= new Map();
        if (!c.miJur.has(mk.jur)) c.miJur.set(mk.jur, []);
        c.miJur.get(mk.jur).push(rec);
      }
    }
    c.pres = addCells(c.pres, pres);
    c.house = addCells(c.house, house);
    if (rec.virtual) {
      c.vpres = addCells(c.vpres, pres);
      c.vhouse = addCells(c.vhouse, house);
    } else {
      c.real += 1;
      if (hd != null) c.byDist.set(Number(hd), (c.byDist.get(Number(hd)) || 0) + 1);
      c.rmpres = addCells(c.rmpres, pres);
      c.rmhouse = addCells(c.rmhouse, house);
      sumInto(c.rpres, sumCells(pres));
      sumInto(c.rhouse, sumCells(house));
    }
    if (keys[0]) {
      if (!c.exact.has(keys[0])) c.exact.set(keys[0], rec);
      else c.exact.set(keys[0], null); // ambiguous within the county
    }
    for (const k of keys.slice(1)) {
      const list = c.alt.get(k) || [];
      list.push(rec);
      c.alt.set(k, list);
    }
  }
  if (idx.state === 'TX') addTexasCountyCodeKeys(idx);
  cache.set(key, idx);
  return idx;
}

/**
 * Texas 2024 precinct names carry the county's number (alphabetical, 1-254) in front of the precinct:
 * Dallas (57) precinct 1004 is "571004", Harris (101) precinct 1 is "1010001". County sites say "1004".
 * Add the precinct number alone as a key, but only for counties where (nearly) every name starts with
 * the expected county number, so a wrong guess can't create false matches.
 */
function addTexasCountyCodeKeys(idx) {
  const counties = [...idx.counties.values()].sort((a, b) => a.name.localeCompare(b.name));
  counties.forEach((c, i) => {
    const code = String(i + 1);
    const recs = [];
    for (const r of c.exact.values()) if (r) recs.push(r);
    for (const list of c.alt.values()) for (const r of list) recs.push(r);
    const uniq = [...new Set(recs)].filter((r) => !r.virtual);
    if (!uniq.length) return;
    const hits = uniq.filter((r) => /^\d+$/.test(r.precinct) && r.precinct.startsWith(code) && r.precinct.length > code.length);
    if (hits.length < 0.9 * uniq.length) return;
    c.txCode = code;
    for (const r of hits) {
      const k = precinctKeys(r.precinct.slice(code.length))[0];
      if (k && !c.exact.has(k)) c.exact.set(k, r);
    }
  });
}

function findCounty(idx, county) {
  const ck = countyKey(county);
  if (idx.counties.has(ck)) return idx.counties.get(ck);
  for (const [k, c] of idx.counties) if (k.startsWith(ck) || ck.startsWith(k)) return c;
  return null;
}

/** Vote modes a batch unit carries, from its name and any votes already in it. */
function batchModes(u) {
  const s = String(u.p || '').toUpperCase();
  const m = new Set();
  if (/EARLY|ONE ?STOP|(^|[\s\-_])EV($|[\s\-_\d])|^EV|ADVANCE|IN[- ]PERSON ABS/.test(s)) m.add('EV');
  if (/ABSENTEE|MAIL|(^|[\s\-_])ABS($|[\s\-_])|UOCAVA|OVERSEAS/.test(s) && !/IN[- ]PERSON/.test(s)) m.add('MAIL');
  if (/PROV/.test(s)) m.add('PROV');
  // Only early, mail and provisional votes move between precincts and batches; Election Day votes in a
  // batch (NC 'TRANSFER', 'CURBSIDE') are compared with the 2024 batch's own Election Day votes.
  for (const [mode, c] of Object.entries(u.live || {})) if (tot(c) > 0 && ['EV', 'MAIL', 'PROV'].includes(mode)) m.add(mode);
  return m;
}

/**
 * Attach baselines to units. Returns { matched, units } where batch units are merged per county.
 * unit: { c, p, lvl, v } -> adds b (2024 President cells), bh (2024 House cells), mk (match kind)
 */
export function attachBaseline(units, idx, opts = {}) {
  if (!idx) return { matched: 0, units };
  const used = new Set();
  const out = [];
  const pending = [];
  const batches = new Map(); // county key -> { c, units: [], modes: Set }
  const miGroups = new Map(); // county key -> { c, byJur: Map(jur -> [[unit, key]]) } (Michigan)
  let matched = 0;

  // 1. real precincts: exact names first, then looser keys
  for (const u of units) {
    const c = findCounty(idx, u.c);
    if (!c) {
      out.push(u);
      continue;
    }
    if (u.v) {
      const g = batches.get(c.key) || { c, units: [], modes: new Set() };
      g.units.push(u);
      for (const m of batchModes(u)) g.modes.add(m);
      batches.set(c.key, g);
      continue;
    }
    out.push(u);
    if (u.lvl === 'county' || u.p == null) {
      // A county-level result can only be compared with the whole county's 2024 vote if the race covers
      // (nearly) the whole county: always true statewide; for a district, judged from precinct counts.
      // Feeds without precinct counts (Indiana) fall back to the 2024 district lines, which is only valid
      // where the map hasn't changed since 2024; the adapter says so by setting prUnknown.
      const byCounts = !u.prUnknown && u.pr && u.pr.tot > 0 && c.real > 0 && u.pr.tot >= 0.85 * c.real;
      const byLines = u.prUnknown && opts.district != null && c.real > 0 && (c.byDist.get(opts.district) || 0) >= 0.85 * c.real;
      const whole = opts.statewide || byCounts || byLines;
      if (whole) {
        Object.assign(u, { b: c.pres, bh: c.house, mk: 'county' });
        matched += 1;
      } else u.mk = null;
      continue;
    }
    if (c.miJur) {
      const lk = miLiveKey(u.p);
      if (lk && c.miJur.has(lk.jur)) {
        out.pop(); // placed (or merged) by the Michigan join below
        const g = miGroups.get(c.key) || { c, byJur: new Map() };
        if (!g.byJur.has(lk.jur)) g.byJur.set(lk.jur, []);
        g.byJur.get(lk.jur).push([u, lk]);
        miGroups.set(c.key, g);
        continue;
      }
    }
    const keys = precinctKeys(u.p);
    const rec = keys[0] ? c.exact.get(keys[0]) : null;
    if (rec && !used.has(rec.id)) {
      used.add(rec.id);
      Object.assign(u, { _rec: rec, _c: c, mk: 'exact' });
    } else pending.push([u, c, keys]);
  }
  for (const [u, c, keys] of pending) {
    for (let i = 0; i < keys.length; i++) {
      const r = c.exact.get(keys[i]);
      if (r && !used.has(r.id)) {
        used.add(r.id);
        Object.assign(u, { _rec: r, _c: c, mk: i === 0 ? 'exact' : 'code' });
        break;
      }
      const list = (c.alt.get(keys[i]) || []).filter((x) => !used.has(x.id));
      if (list.length === 1) {
        used.add(list[0].id);
        Object.assign(u, { _rec: list[0], _c: c, mk: i === 0 ? 'code' : 'digits' });
        break;
      }
    }
  }

  // 1b. Michigan: match by precinct number where a city/township kept the same precincts as in 2024;
  //     otherwise compare the whole jurisdiction, once all of its precincts are in.
  for (const { c, byJur } of miGroups.values()) {
    for (const [jur, members] of byJur) {
      let recs = c.miJur.get(jur).filter((r) => !used.has(r.id));
      if (!opts.statewide && opts.district != null) recs = recs.filter((r) => Number(r.hd) === opts.district);
      if (!recs.length) {
        for (const [u] of members) out.push(Object.assign(u, { mk: null }));
        continue;
      }
      // Precinct numbers are usually unique in a jurisdiction; some cities restart them in each ward
      // (South Haven: Ward 2 Precinct 1, Ward 3 Precinct 1), so fall back to ward + number.
      let keyOf = (k) => String(k.num);
      let byNum = new Map(recs.map((r) => [keyOf(r.mi), r]));
      if (byNum.size < recs.length && recs.every((r) => r.mi.ward) && members.every(([, k]) => k.ward)) {
        keyOf = (k) => `${k.ward}-${k.num}`;
        byNum = new Map(recs.map((r) => [keyOf(r.mi), r]));
      }
      const same = members.length === recs.length && byNum.size === recs.length && members.every(([, k]) => byNum.has(keyOf(k)));
      if (same) {
        for (const [u, k] of members) {
          const r = byNum.get(keyOf(k));
          used.add(r.id);
          out.push(Object.assign(u, { _rec: r, _c: c, mk: 'number' }));
        }
        continue;
      }
      // Precincts were redrawn: one unit for the jurisdiction, complete only when every precinct is.
      for (const r of recs) used.add(r.id);
      const merged = { c: members[0][0].c, p: `${members[0][1].label} (all ${members.length} precincts; renumbered since 2024)`, v: false, lvl: 'precinct', live: {}, mk: 'jurisdiction' };
      let complete = true;
      for (const [u] of members) {
        for (const [m, cell] of Object.entries(u.live || {})) sumInto((merged.live[m] ||= [0, 0, 0]), cell);
        const lt = Object.values(u.live || {}).reduce((a, cell) => a + tot(cell), 0);
        const ed = u.live?.ED ? tot(u.live.ED) : null;
        if (u.x === false || lt === 0 || ed === 0) complete = false;
      }
      merged.x = complete;
      for (const kind of KINDS) {
        let cells = null;
        for (const r of recs) if (r[kind]) cells = addCells(cells, r[kind]);
        merged[kind === 'pres' ? 'b' : 'bh'] = cells;
      }
      if (merged.b) matched += 1;
      out.push(merged);
    }
  }

  // 2. this race's share of each county's 2024 precinct vote (for split counties)
  const share = new Map();
  for (const u of out) {
    if (!u._rec) continue;
    const s = share.get(u._c.key) || { pres: [0, 0, 0], house: [0, 0, 0] };
    sumInto(s.pres, sumCells(u._rec.pres));
    sumInto(s.house, sumCells(u._rec.house));
    share.set(u._c.key, s);
  }
  const weights = (c, kind) => {
    const s = share.get(c.key);
    const t = c['r' + kind];
    return [0, 1, 2].map((i) => (s && t[i] > 0 ? Math.min(1, s[kind][i] / t[i]) : 0));
  };

  // 3. per-precinct cells, mode by mode
  const moved = new Map(); // county key -> { pres: cells, house: cells } modes moved from precincts into batches
  for (const u of out) {
    if (!u._rec) continue;
    const c = u._c;
    const covered = batches.get(c.key)?.modes || new Set();
    let alloc = false;
    for (const kind of KINDS) {
      const own = u._rec[kind];
      if (!own) {
        u[kind === 'pres' ? 'b' : 'bh'] = null;
        continue;
      }
      const cells = {};
      for (const [m, v] of Object.entries(own)) cells[m] = v.slice();
      // spread 2024 batches over precincts for modes this county no longer batches
      const virt = c['v' + kind];
      const ctot = c['r' + kind];
      if (virt) {
        const mine = sumCells(own);
        const w = [0, 1, 2].map((i) => (ctot[i] > 0 ? mine[i] / ctot[i] : 0));
        for (const [m, v] of Object.entries(virt)) {
          if (covered.has(m) || !['EV', 'MAIL', 'PROV'].includes(m) || tot(v) === 0) continue;
          const cell = (cells[m] ||= [0, 0, 0]);
          for (let i = 0; i < 3; i++) cell[i] = round1(cell[i] + v[i] * w[i]);
          alloc = true;
        }
      }
      // Modes the county batches in 2026: if 2024 also batched most of that mode, compare batch with
      // batch; otherwise move this precinct's 2024 votes for the mode into the county batch baseline.
      for (const m of covered) {
        if (!cells[m]) continue;
        const batched2024 = virt && tot(virt[m]) >= tot(c['rm' + kind]?.[m]);
        if (!batched2024) {
          const mv = moved.get(c.key) || { pres: {}, house: {} };
          sumInto((mv[kind][m] ||= [0, 0, 0]), cells[m]);
          moved.set(c.key, mv);
        }
        delete cells[m];
      }
      u[kind === 'pres' ? 'b' : 'bh'] = Object.keys(cells).length ? cells : null;
    }
    if (alloc) u.mk += '+alloc';
    matched += 1;
  }

  // 4. one merged batch unit per county
  for (const [key, g] of batches) {
    const c = g.c;
    const merged = { c: g.units[0].c, p: '', v: true, lvl: 'precinct', x: null, live: {} };
    for (const u of g.units) for (const [m, cell] of Object.entries(u.live || {})) sumInto((merged.live[m] ||= [0, 0, 0]), cell);
    const names = g.units.map((u) => u.p);
    merged.p = `Batches: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4}` : ''}`;
    if (share.has(key)) {
      const parts = {};
      let whole = true;
      for (const kind of KINDS) {
        const w = weights(c, kind);
        if (kind === 'pres') whole = w.every((x) => x >= 0.95);
        const cells = {};
        const virt = c['v' + kind] || {};
        const virtModes = Object.keys(virt).filter((m) => tot(virt[m]) > 0 && m !== 'TOTAL');
        for (const m of new Set([...g.modes, ...virtModes])) {
          const batched2024 = tot(virt[m]) > 0 && tot(virt[m]) >= tot(c['rm' + kind]?.[m]);
          const fromBatch = tot(virt[m]) > 0 ? (whole ? virt[m].slice() : virt[m].map((x, i) => round1(x * w[i]))) : null;
          const fromPrecincts = !batched2024 ? moved.get(key)?.[kind]?.[m] : null;
          if (fromBatch && fromPrecincts) cells[m] = sumInto(fromBatch, fromPrecincts);
          else if (fromBatch || fromPrecincts) cells[m] = fromBatch || fromPrecincts;
        }
        parts[kind] = Object.keys(cells).length ? cells : null;
      }
      if (parts.pres) {
        Object.assign(merged, { b: parts.pres, bh: parts.house, mk: whole ? 'batch' : 'batch~' });
        matched += 1;
      }
    }
    out.push(merged);
  }
  for (const u of out) {
    delete u._rec;
    delete u._c;
  }
  return { matched, units: out };
}
