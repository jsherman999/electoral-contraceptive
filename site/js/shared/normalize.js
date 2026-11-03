// Name normalization shared by the browser and the Node collector.
// Every join between a live 2026 feed and the 2024 baseline goes through these functions,
// so they are deliberately forgiving about case, punctuation, prefixes and leading zeros.

export const MODES = ['ED', 'EV', 'MAIL', 'PROV', 'OTHER'];
export const MODE_LABELS = {
  ED: 'Election Day',
  EV: 'Early in-person',
  MAIL: 'Mail / absentee',
  PROV: 'Provisional',
  OTHER: 'Other',
  TOTAL: 'All votes',
};

/** County key: "St. Lucie County" -> "STLUCIE", "DeKalb" -> "DEKALB", "Fairfax City" -> "FAIRFAXCITY". */
export function countyKey(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(/\bCOUNTY\b|\bPARISH\b|\bBOROUGH\b/g, ' ')
    .replace(/\bSAINT\b/g, 'ST')
    .replace(/\bSTE\b/g, 'STE')
    .replace(/[^A-Z0-9]/g, '');
}

const PRECINCT_WORDS = /\b(PRECINCTS?|PCTS?|PREC|PRCT|VOTING DISTRICT|ELECTION DISTRICT|ED)\b\.?/g;

function tokens(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(PRECINCT_WORDS, ' ')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? String(parseInt(t, 10)) : t.replace(/^0+(?=\d)/, '')));
}

/**
 * Candidate keys for a precinct name, best first.
 *  "PRECINCT 012"           -> ["12"]
 *  "0012 - Smith Elem"      -> ["12-SMITH-ELEM", "12"]
 *  "Ward 01 Pct 03"         -> ["WARD-1-3", "1-3"]
 */
export function precinctKeys(name) {
  const raw = String(name ?? '').trim();
  const keys = [];
  const full = tokens(raw).join('-');
  if (full) keys.push(full);
  // Code part before a separator: "0012 - Smith Elementary", "12: Smith"
  const m = raw.match(/^\s*([A-Za-z]{0,4}[-\s]?\d+[A-Za-z]?(?:[.\-]\d+[A-Za-z]?)?)\s*(?:[-:–]\s+|\s{2,}|\s+\()/);
  if (m) {
    const code = tokens(m[1]).join('-');
    if (code && !keys.includes(code)) keys.push(code);
  }
  const digits = tokens(raw).filter((t) => /^\d+[A-Z]?$/.test(t)).join('-');
  if (digits && !keys.includes(digits)) keys.push(digits);
  return keys;
}

export function precinctKey(name) {
  return precinctKeys(name)[0] || '';
}

/** Canonical vote mode. */
const CANON = new Set(['ED', 'EV', 'MAIL', 'PROV', 'OTHER', 'TOTAL']);
export function normMode(s) {
  const m = String(s ?? '').toUpperCase().trim();
  if (CANON.has(m)) return m;
  if (!m || /TOTAL|^ALL\b|COMBINED/.test(m)) return 'TOTAL';
  if (/PROVIS|AFFIDAVIT|CHALLENGE/.test(m)) return 'PROV';
  if (/ONE[- ]?STOP|ABSENTEE IN[- ]PERSON|IN[- ]PERSON ABSENTEE|EARLY VOT|EARLY IN|ADVANCE|EARLY IN-PERSON/.test(m)) return 'EV';
  if (/MAIL|ABSENT|ABM|VBM|UOCAVA|MILITARY|OVERSEAS|POSTAL/.test(m)) return 'MAIL';
  if (/EARLY/.test(m)) return 'EV';
  if (/ELECTION[- ]?DAY|POLL|^ED$|^E\.?D\.?$|IN[- ]PERSON|PRECINCT|MACHINE/.test(m)) return 'ED';
  return 'OTHER';
}

/** "DEM", "Democratic", "DEMOCRAT / WORKING FAMILIES", "DFL" -> "D"; "REP", "GOP" -> "R"; else "O". */
export function normParty(p) {
  const s = String(p ?? '').toUpperCase().trim();
  if (!s) return 'O';
  if (/^(D|DEM|DFL)$/.test(s) || /DEMOCRA/.test(s)) return 'D';
  if (/^(R|REP|GOP)$/.test(s) || /REPUBLICAN/.test(s)) return 'R';
  return 'O';
}

/** Pull "(REP)" / "(D)" style party tags out of candidate text. */
export function partyFromName(name) {
  const m = String(name ?? '').match(/\((DEM|REP|D|R|DEMOCRAT|REPUBLICAN|DEMOCRATIC|GOP)\)/i);
  return m ? normParty(m[1]) : null;
}

export function candidateKey(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^A-Z]/g, '');
}

/** Pseudo-precincts that hold countywide absentee, provisional or early-vote batches. */
export function isVirtualPrecinct(name) {
  const s = String(name ?? '').toUpperCase().trim();
  return (
    /ABSENTEE|PROVISIONAL|ONE[\s-]?STOP|EARLY ?VOT|BY[\s-]MAIL|MAIL BALLOT|UOCAVA|OVERSEAS|CURBSIDE|TRANSFER|FEDERAL ONLY|PRESIDENTIAL ONLY|SUPPLEMENTAL/.test(s) ||
    /[A-Z.]\s+(EV|ABS)$/.test(s) || // "MILLERS CREEK EV", "DOB EV"
    (/^EV[A-Z]{2,3}$/.test(s) && !/^EV(ANS?|ERS?|ERT|ENS?|ELL|ART|ON|A)$/.test(s)) || // "EVAB", "EVBOE" (NC early-vote site codes)
    /^(ABSEN|PROVI?S|PROVI$|PROVISON|PROVSIONAL)/.test(s) ||
    /^(BOE|TRANS|SPARE|CURB|PROV|AB|ABS)$/.test(s) ||
    /^(ABS|PROV|OS|CURB|EV|AB)[\s\-_]/.test(s)
  );
}

/** Rows that are not votes for anyone (over/under votes, ballots cast, registration). */
export function isNonCandidate(name) {
  return /OVER ?VOTES?|UNDER ?VOTES?|^BLANK|TOTAL VOTES|BALLOTS CAST|REGISTERED VOTERS|TIMES (OVER|UNDER) ?VOTED|^REGISTERED/i.test(
    String(name ?? '').trim()
  );
}
