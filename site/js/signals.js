// Signal logic for the board: is a card's condition (e.g. "Democrats flip this seat") being met?
// Pure functions, shared by the page and the tests.

export function defaultSignal(colId, board) {
  const col = board.columns.find((c) => c.id === colId);
  return { party: col ? col.party : 'D' };
}

const partyMargin = (m, party) => (m == null ? null : party === 'D' ? m : -m);

/** How a single race is doing against a signal { party, margin }. */
export function raceSignal(sum, sig) {
  if (!sum) return { state: 'pending' };
  const thr = sig.margin || 0;
  if (sum.call && sum.call.party) {
    const ok = sum.call.party === sig.party && (thr === 0 || (partyMargin(sum.margin, sig.party) ?? -1) >= thr);
    return { state: ok ? 'hit-strong' : 'miss-strong', final: true };
  }
  if (sum.status === 'complete') {
    const v = partyMargin(sum.margin, sig.party);
    return { state: v > thr ? 'hit-strong' : 'miss-strong', final: true };
  }
  const p = sum.projection || {};
  if (!sum.votes || !sum.votes.T || p.margin == null) return { state: 'pending' };
  const v = partyMargin(p.margin, sig.party);
  const z = (v - thr) / (p.sigma || 10);
  if (p.confidence === 'too-early') return { state: 'pending', lean: z > 0 ? 'hit' : 'miss', z };
  if (z >= 1.645) return { state: 'hit-strong', z };
  if (z > 0) return { state: 'hit', z };
  if (z <= -1.645) return { state: 'miss-strong', z };
  return { state: 'miss', z };
}

export const isHit = (s) => s === 'hit' || s === 'hit-strong';
export const isMiss = (s) => s === 'miss' || s === 'miss-strong';

export function compositeSignal(comp, races) {
  const members = comp.races.map((id) => ({ id, sig: raceSignal(races[id], { party: comp.party }), sum: races[id] }));
  const hits = members.filter((m) => isHit(m.sig.state)).length;
  const misses = members.filter((m) => isMiss(m.sig.state)).length;
  const strongHits = members.filter((m) => m.sig.state === 'hit-strong').length;
  const strongMiss = members.filter((m) => m.sig.state === 'miss-strong').length;
  let st = 'pending';
  if (hits >= comp.atLeast) st = strongHits >= comp.atLeast ? 'hit-strong' : 'hit';
  else if (misses > comp.races.length - comp.atLeast) st = strongMiss > comp.races.length - comp.atLeast ? 'miss-strong' : 'miss';
  return { state: st, hits, misses, members };
}

/** Senate math: pickups among targets minus losses among holds, against the net gain needed. */
export function senateTally(sec, races) {
  const out = { pickups: 0, pickupsLikely: 0, losses: 0, pending: 0, targets: 0, holds: 0, reporting: 0 };
  for (const row of sec.rows) {
    for (const [colId, cards] of Object.entries(row.cells || {})) {
      for (const card of cards) {
        const s = raceSignal(races[card.race], card.signal || { party: 'D' }).state;
        if (colId === 'hold') {
          out.holds += 1;
          if (isMiss(s)) out.losses += 1;
        } else {
          out.targets += 1;
          if (isHit(s)) out.pickups += 1;
          if (s === 'hit-strong') out.pickupsLikely += 1;
        }
        if (s === 'pending') out.pending += 1;
        else out.reporting += 1;
      }
    }
  }
  out.net = out.pickups - out.losses;
  return out;
}

