# Plan: Election-night House tracker

Goal: a live board for the House bellwether races on election night (Nov 3, 2026), laid out like the
"Blue Wave should be clear by 9pm" graphic. It collects **precinct-level returns** as counties publish
them and compares each precinct with **how that same precinct voted in 2024**, so you can see which way
a district, county or state is moving compared with last cycle before the race is called.

## 1. What the user sees

**The board** (`site/`, hosted on GitHub Pages)

- Same grid as the reference graphic. Rows are poll-closing times (6:00, 7:00, 7:30, 8:00, 9:00 ET, plus
  a "Later" row). Columns are scenarios: **Red Riptide** (GOP holds or gains), **Blue Tide** (D 218–229),
  **Blue Wave** (D 230–239), **Blue Tsunami** (D 240+).
- Each race card keeps the graphic's look: blue or red for the party holding the seat, ★ for districts
  redrawn since 2024, and a dashed red outline for "GOP clears this bar" signal cards. Live data is added
  to each card:
  - a thin bar showing how much of the expected vote has been counted
  - the current margin (`D+3.1`) and the swing against the same precincts in 2024 (`▲D 4.2 vs '24`)
  - a ring and check mark when the card's signal is being hit (for example, Dems leading a Blue Wave seat),
    and a dimmed card when it is being missed
  - a FLIP tag when the projected leader is not the party holding the seat
- Each column header has a live tally ("5 of 12 trending"). A top bar shows the vote-weighted average
  swing across all races, the time of the last update, the data source, and which column the night is
  tracking toward.
- Composite signal cards ("FL redraw GOP 4 for 4", "TX redraw GOP 4+ of 5", "PA-07/10 GOP 2 for 2") are
  computed from their member races. Their member districts are listed in `site/board.json` and can be edited.

**Click any card** to open a detail panel with:

- a summary: candidates, votes and shares, precincts reporting, % of expected vote counted, the 2024
  margin in the same precincts, the swing, turnout compared with 2024, and a projected final margin with a
  range (labelled as a model estimate, not a race call)
- a precinct scatter plot: 2024 margin on the x-axis, 2026 margin on the y-axis, and a diagonal line, so
  dots above the line moved toward Democrats
- a timeline of margin, swing and projection over the night
- a county table, with each county's current margin against its 2024 margin
- a sortable, searchable table of every precinct (status, D, R, other, total, 2026 margin, 2024 margin,
  shift, turnout against 2024) with filters for reported, partial, not reported and unmatched precincts
- a toggle for the baseline: **2024 President** (default) or **2024 House**

**Demo mode** (`?demo`) simulates the whole night in the browser with a time scrubber and a choice of
national environment. It is clearly labelled as simulated, and it is used to check the UI before polls
close.

## 2. Architecture

GitHub Pages only serves static files, and county results sites block cross-origin browser requests, so
the scraping happens in a **collector** that writes JSON. The static page reads that JSON.

```
 county / state results feeds ──► collector (Node, no dependencies) ──► results JSON ──► Pages site
   NC SBE precinct zip               adapters ─► normalize ─► join with            (polls every 30–75 s)
   Clarity ENR detailxml             2024 baseline ─► swing + projection
   Enhanced Voting JSON
   FL DOS county file
   any CSV/TSV/JSON (column mapping)
```

Where the collector runs:

1. **GitHub Actions** (`.github/workflows/election-night.yml`). One job loops for about 5h45m, collecting
   every 90 s and force-pushing a single commit of results to an `election-data` branch. Two scheduled
   runs (17:45 ET and 23:35 ET) cover the night, and it can also be started by hand. A long-running loop
   is used because GitHub cron only runs every 5 minutes at best and is often late.
2. **Your own machine** as a fallback: `npm run live` collects and serves the site at
   `http://localhost:8080`. `--publish` also pushes to the `election-data` branch.

How the page finds the data: on `*.github.io` it asks the GitHub API for the latest commit SHA of
`election-data` (one small request, revalidated with ETags), then loads
`raw.githubusercontent.com/<owner>/<repo>/<sha>/results/...`. Files fetched by SHA never change, so
nothing stale is served from a cache. If the API rate limit is hit, it falls back to the branch URL (the
CDN can lag by up to about 5 minutes). Run locally, it reads `./results/`.

## 3. Data model and math

Each precinct ("unit") holds D, R and Other votes **by vote mode** (Election Day, Early, Mail,
Provisional) where the source breaks them out, or a single TOTAL otherwise.

- **Matching:** each live precinct is joined to its 2024 baseline on normalized `county|precinct`.
  Normalization handles case, "PRECINCT"/"PCT" prefixes, leading zeros, punctuation and a numeric-code
  fallback. Pseudo-precincts (absentee, provisional, one-stop) are flagged. Match rates are shown in the UI.
- **Like-for-like swing:** compare only the vote modes that have reported in 2026 against the same modes
  in 2024. Early votes released at 7:30 are compared with 2024 early votes, not with the full 2024 result.
  `swing = Σ(D−R)₂₆/ΣT₂₆ − Σ(D−R)₂₄/ΣT₂₄` over the matched cells that have reported.
- **Turnout ratio** is 2026 votes divided by 2024 votes in those same cells.
- **Projection:** cells that have not reported are filled in from their 2024 values, scaled by the
  turnout ratio for that mode and shifted by the swing for that mode (falling back to the race-wide
  figures when there is little data). This gives a projected final margin and a % of expected vote
  counted. The uncertainty band shrinks as the counted share grows. Labels: *too early*, *lean*, *likely*,
  *clear*.
- **Calls:** a race becomes final at 100% reporting, or when you add a manual call (for example, the AP
  call) in `config/calls.json`.
- **County-level feeds** (for example, the FL DOS file) are compared with the countywide 2024 result. This
  is flagged as approximate when a county is split between districts.

## 4. Sources

| State(s) | Live 2026 feed | 2024 baseline |
|---|---|---|
| NC (NC-01, -05, -09, -11) | NC SBE statewide precinct zip, **already up for 2026 (all zeros) and verified** | NC SBE 2024 precinct zip (same format, exact name match) |
| SC, CO, IA (+ Clarity counties in other states) | Clarity ENR: paste the results URL; the adapter finds county pages and `detailxml.zip` | MEDSL 2024 precinct returns |
| GA, VA | Enhanced Voting JSON export (best effort; check on the night) | MEDSL |
| FL | FL DOS election-night county file (county level) plus Clarity or CSV feeds from county elections offices | MEDSL |
| Everything else | Generic CSV/TSV/JSON adapter with column mapping in `config/sources.json` | MEDSL |

Baselines are prebuilt into `baseline/<st>.json.gz` from MEDSL's 2024 precinct data
(`MEDSL/2024-elections-official`), covering 2024 President and 2024 House by precinct and vote mode.

**Known gaps (stated honestly):** most states only publish their 2026 results URLs on the night. Every
race card works from the config, and feeds are added or fixed by pasting a URL into `config/sources.json`
without code changes. Precinct names can change between cycles, so match rates below about 70% mean the
swing estimate for that race is less reliable. The UI shows this.

## 5. Build order

1. Plan and README (this file)
2. Shared, browser-and-Node modules: normalization, model (join, swing, projection), demo simulator
3. Static site: board, cards, column tallies, top bar, detail panel, SVG charts, precinct table, demo mode
4. Collector: HTTP with retries and ETags, unzip, CSV, adapters (ncsbe, clarity, enhanced-voting, fl-dos,
   delimited, json, demo), output writer, history, publish to branch, local server
5. Baseline builder and prebuilt baselines for the 21 states on the board
6. GitHub Actions: Pages deploy and election-night loop
7. Run end to end: demo mode in a headless browser, collector run against the live NC feed
