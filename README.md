# Electoral Contraceptive: election-night House tracker

A live board for the 2026 House bellwether races. It collects precinct returns as counties publish them,
compares each precinct with how it voted in 2024, and shows on one screen whether the night is a Red
Riptide, a Blue Tide, a Blue Wave or a Blue Tsunami.

> Work in progress. See [PLAN.md](PLAN.md) for the design. Setup steps are added below as each part lands.

## Layout

```
site/        static web app served by GitHub Pages
collector/   Node scraper: fetches feeds, joins them to the 2024 baseline, writes results JSON
config/      feed URLs per race (sources.json) and manual race calls (calls.json)
baseline/    prebuilt 2024 precinct baselines (President and House) per state
.github/     Pages deploy and election-night collector workflows
```
