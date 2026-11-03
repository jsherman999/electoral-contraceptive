// Turns joined units for one race into the JSON the board reads: a compact summary for summary.json
// and a detail object for races/<id>.json. Shared by the collector and the in-browser demo.
import { analyzeRace } from './model.js';

/**
 * @param {string} id               race id, e.g. "NC-01"
 * @param {Array}  units            joined units; u.b = 2024 President baseline, u.bh = 2024 House baseline
 * @param {object} extra
 * @param {Array}  extra.candidates [{ name, party, votes }]
 * @param {object} [extra.call]     manual call { party, note }
 * @param {Array}  [extra.feeds]    feed status [{ id, adapter, ok, error, fetchedAt, sourceUpdatedAt, url }]
 * @param {Array}  [extra.history]  previous history rows
 * @param {string} [extra.now]      ISO timestamp
 */
export function buildRace(id, units, extra = {}) {
  const now = extra.now || new Date().toISOString();
  const pres = analyzeRace(units);
  const hasHouse = units.some((u) => u.bh);
  const house = hasHouse ? analyzeRace(units.map((u) => ({ ...u, b: u.bh || null, mk: u.bh ? u.mk : null }))) : null;
  const s = pres.summary;

  const levels = new Set(units.map((u) => (u.lvl === 'county' ? 'county' : 'precinct')));
  const level = levels.size > 1 ? 'mixed' : levels.has('county') ? 'county' : 'precinct';

  const call = extra.call && extra.call.party ? extra.call : null;
  let status = 'waiting';
  if (call) status = 'called';
  else if (s.votes.T > 0 && s.precincts.total > 0 && s.precincts.none === 0 && s.precincts.partial === 0) status = 'complete';
  else if (s.votes.T > 0) status = 'counting';

  const candidates = (extra.candidates || []).slice().sort((a, b) => (b.votes || 0) - (a.votes || 0));

  let history = (extra.history || []).slice();
  // Votes falling by more than half means a source was replaced or withdrawn (e.g. a feed that had
  // picked up the wrong election); earlier points no longer describe this count, so start over.
  const prev = history[history.length - 1];
  if (prev && prev[5] > 1000 && s.votes.T < prev[5] * 0.5) history = [];
  const point = [
    Math.round(Date.parse(now) / 1000),
    s.margin,
    s.swing,
    s.projection.margin,
    s.projection.expectedPct,
    s.votes.T,
  ];
  const last = history[history.length - 1];
  if (!last || last[5] !== point[5] || last[1] !== point[1]) {
    if (s.votes.T > 0 || !last) history.push(point);
  }
  if (history.length > 400) history.splice(0, history.length - 400);

  const summary = {
    id,
    updatedAt: now,
    status,
    level,
    call,
    candidates: candidates.slice(0, 4),
    ...s,
    house: house
      ? { swing: house.summary.swing, base: house.summary.base, match: house.summary.match, margin: house.summary.projection.margin }
      : null,
    feeds: extra.feeds || [],
    spark: history.slice(-40).map((h) => [h[0], h[3]]),
  };

  const detail = {
    id,
    updatedAt: now,
    status,
    level,
    call,
    candidates,
    feeds: extra.feeds || [],
    analyses: { pres, house },
    history,
  };
  return { summary, detail };
}
