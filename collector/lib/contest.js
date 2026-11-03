// Contest-name matching. Feeds name the same race many ways:
//   "US HOUSE OF REPRESENTATIVES DISTRICT 01"      (NC)
//   "U.S. House of Representatives District 1"      (Clarity)
//   "Representative in Congress 7th District"       (MI, PA, NY)
//   "Member, House of Representatives (2nd District)" (VA)
//   "U.S. Representative in Congress - District No. 6" (AZ)
//   "United States Representative | RACE=USR | DIST=14" (FL DOS adapter)
//   "United States Representative, Fifth District"   (Indiana)

const STATE_NAMES =
  'ALABAMA|ALASKA|ARIZONA|ARKANSAS|CALIFORNIA|COLORADO|CONNECTICUT|DELAWARE|FLORIDA|GEORGIA|HAWAII|IDAHO|ILLINOIS|INDIANA|IOWA|KANSAS|KENTUCKY|LOUISIANA|MAINE|MARYLAND|MASSACHUSETTS|MICHIGAN|MINNESOTA|MISSISSIPPI|MISSOURI|MONTANA|NEBRASKA|NEVADA|NEW HAMPSHIRE|NEW JERSEY|NEW MEXICO|NEW YORK|NORTH CAROLINA|NORTH DAKOTA|OHIO|OKLAHOMA|OREGON|PENNSYLVANIA|RHODE ISLAND|SOUTH CAROLINA|SOUTH DAKOTA|TENNESSEE|TEXAS|UTAH|VERMONT|VIRGINIA|WASHINGTON|WEST VIRGINIA|WISCONSIN|WYOMING';
// State legislative and local contests, including "NC HOUSE OF REPRESENTATIVES" / "Ohio House of Representatives".
const EXCLUDE = String.raw`^(?!.*\b(STATE|ASSEMBLY|SENATE|SENATOR|DELEGATES?|LEGISLAT\w*|BOARD|COUNCIL|COMMISSION\w*|JUDGE|COURT|GENERAL ASSEMBLY)\b)(?!.*\b(?:(?!US\b)[A-Z]{2}|${STATE_NAMES})\s+HOUSE\b)`;
const FEDERAL = String.raw`(?=.*(CONGRESS|U\.?\s?S\.?\s*(HOUSE|REP)|UNITED STATES\s+(HOUSE|REP)|HOUSE OF REPRESENTATIVES|\bUS\s*REP|RACE=USR|\bUSR\b))`;

const ONES = ['', 'FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH'];
const TEENS = ['TENTH', 'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH', 'FIFTEENTH', 'SIXTEENTH', 'SEVENTEENTH', 'EIGHTEENTH', 'NINETEENTH'];
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY'];
const TENS_ORD = ['', '', 'TWENTIETH', 'THIRTIETH', 'FORTIETH', 'FIFTIETH'];

/** Ordinal word pattern: 5 -> "FIFTH", 21 -> "TWENTY[- ]?FIRST" (Indiana: "Fifth District"). */
function ordinalWords(n) {
  if (n < 1 || n > 59) return null;
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  const t = Math.floor(n / 10);
  return n % 10 === 0 ? TENS_ORD[t] : `${TENS[t]}[\\s-]?${ONES[n % 10]}`;
}

/** RegExp matching the U.S. House contest for district n in (almost) any feed's naming. */
export function houseContestRegex(n) {
  const num = `0*${Number(n)}`;
  const word = ordinalWords(Number(n));
  const forms = [
    // "Fifth District", but not "Twenty-Fifth District" for district 5
    ...(word ? [String.raw`(?<!(?:TWENTY|THIRTY|FORTY|FIFTY)[\s-]?)\b${word}\s+(?:CONG\w*\s+)?DIST`] : []),
    String.raw`DIST(?:RICT)?\.?\s*(?:NO\.?\s*|#\s*)?${num}\b`,
    String.raw`\b${num}(?:ST|ND|RD|TH)\s+(?:CONG\w*\s+)?DIST`,
    String.raw`\(${num}(?:ST|ND|RD|TH)?\b`,
    String.raw`DIST=${num}$`,
    String.raw`CONGRESS(?:IONAL)?\s+${num}\b`,
    String.raw`\bCD\s*-?\s*${num}\b`,
  ];
  return new RegExp(`${EXCLUDE}${FEDERAL}.*(?:${forms.join('|')})`, 'i');
}

export const presidentRegex = /PRESIDENT/i;

/**
 * RegExp for the U.S. Senate contest, including special elections ("U.S. Senator (Unexpired Term)").
 * Excludes state senate races. If a state has two Senate races on one ballot, set the race's contest
 * explicitly in config/sources.json.
 */
export function senateContestRegex() {
  return new RegExp(
    String.raw`^(?!.*\b(STATE\s+SENAT\w*|SENATE\s+DISTRICT|SENATORIAL\s+DISTRICT|ASSEMBLY|LEGISLAT\w*|PRESIDENT PRO)\b)(?!.*\b(?:(?!US\b)[A-Z]{2}|${STATE_NAMES})\s+SENATE\b)(?=.*(U\.?\s?S\.?\s*SENAT|UNITED STATES\s+SENAT|\bUS\s*SENAT|RACE=USS\b|\bUSS\b))`,
    'i'
  );
}

/** Turn a config value into a RegExp: "auto" -> house regex for the race, otherwise a pattern string. */
export function contestMatcher(spec, raceId) {
  if (spec instanceof RegExp) return spec;
  if (!spec || spec === 'auto') {
    const part = String(raceId).split('-')[1];
    if (/^SEN/i.test(part)) return senateContestRegex();
    return houseContestRegex(Number(part));
  }
  return new RegExp(spec, 'i');
}
