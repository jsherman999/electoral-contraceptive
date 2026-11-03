import { test } from 'node:test';
import assert from 'node:assert/strict';
import { miBaselineKey, miLiveKey, loadBaseline, attachBaseline } from '../collector/lib/baseline.js';
import { buildRace } from '../site/js/shared/race.js';

test('michigan precinct names parse on both sides', () => {
  assert.deepEqual(miBaselineKey('SHELBY CHARTER TOWNSHIP 3 Ward 0'), { jur: 'T:SHELBY', num: 3 });
  assert.deepEqual(miBaselineKey('ST CLAIR SHORES CITY 12 Ward 0'), { jur: 'C:ST CLAIR SHORES', num: 12 });
  assert.deepEqual(miBaselineKey('MONROE CITY 3 Ward 0N'), { jur: 'C:MONROE', num: 3 });
  assert.equal(miBaselineKey('{Statistical Adjustments} 9999 Ward 0'), null);
  assert.equal(miLiveKey('Shelby Twp, Pct 3').jur, 'T:SHELBY');
  assert.equal(miLiveKey('St. Clair Shores, Pct 12').jur, 'C:ST CLAIR SHORES');
  assert.equal(miLiveKey('Richmond City, Pct 1').jur, 'C:RICHMOND');
  assert.equal(miLiveKey('Richmond Twp, Pct 1').jur, 'T:RICHMOND');
  assert.deepEqual([miLiveKey('Grosse Pointe Shores 2').jur, miLiveKey('Grosse Pointe Shores 2').num], ['C:GROSSE POINTE SHORES', 2]);
  // Enhanced Voting (Van Buren, Ingham, Shiawassee)
  assert.deepEqual([miLiveKey('City of Bangor, Precinct 1').jur, miLiveKey('City of Bangor, Precinct 1').num], ['C:BANGOR', 1]);
  assert.equal(miLiveKey('Township of Antwerp, Precinct 2').jur, 'T:ANTWERP');
  assert.equal(miLiveKey('Charter Township of Meridian, Precinct 14').jur, 'T:MERIDIAN');
  assert.equal(miBaselineKey('BANGOR CITY 1 Ward 0').jur, 'C:BANGOR');
});

const unit = (p, ed = 0, abs = 0) => ({ c: 'Macomb', p, lvl: 'precinct', v: false, x: null, live: { ED: [ed, ed, 0], MAIL: [abs, abs, 0] } });

test('michigan: same precinct set matches by number; renumbered townships compare whole, once complete', () => {
  const idx = loadBaseline('baseline', 'MI');
  // Sterling Heights kept its 2024 precincts (numbers skip 16, 24 and 41 in both years)
  const nums = [...Array(44).keys()].slice(1).filter((n) => ![16, 24, 41].includes(n));
  const sterling = nums.map((n) => unit(`Sterling Heights, Pct ${n}`, 100, 50));
  // Clinton Township went from 42 precincts (2024) to 18; one precinct still has no Election Day votes
  const clinton = Array.from({ length: 18 }, (_, i) => unit(`Clinton Twp, Pct ${i + 1}`, i === 17 ? 0 : 120, 60));
  const { units } = attachBaseline([...sterling, ...clinton], idx, { statewide: true });
  const sh = units.filter((u) => /^Sterling/.test(u.p));
  assert.equal(sh.length, 40);
  assert.ok(sh.every((u) => u.mk === 'number' && u.b));
  const cl = units.filter((u) => u.mk === 'jurisdiction');
  assert.equal(cl.length, 1);
  assert.match(cl[0].p, /Clinton Twp \(all 18 precincts/);
  assert.equal(cl[0].x, false); // not compared until every precinct is in
  assert.equal(cl[0].live.ED[0], 120 * 17);
  const { summary } = buildRace('MI-SEN', units, {});
  assert.equal(summary.match.rate, 1);

  clinton[17].live.ED = [120, 120, 0];
  const done = attachBaseline([...clinton.map((u) => ({ ...u, live: { ...u.live } }))], idx, { statewide: true }).units;
  assert.equal(done.find((u) => u.mk === 'jurisdiction').x, true);
});
