// Site settings. Everything here can also be overridden with URL parameters:
//   ?demo            simulated night (time scrubber + national environment picker)
//   ?data=<url>      read results from any directory URL that holds summary.json and races/
window.TRACKER_CONFIG = {
  // 'auto': on *.github.io read the `election-data` branch of this repo; anywhere else read ./results/
  // 'demo': always simulate.  Or a URL ending in / that holds summary.json.
  dataSource: 'auto',

  // Where the collector publishes on GitHub. owner/repo are detected from the *.github.io URL when blank.
  github: { owner: '', repo: '', branch: 'election-data', dir: 'results' },

  // Seconds between refreshes. GitHub mode makes one API call per refresh (60/hour unauthenticated limit).
  pollSeconds: { local: 20, github: 75, url: 30 },

  // When no live data has been published yet, show the simulation instead of an empty board.
  demoWhenNoData: true,
  defaultDemoEnv: 'wave',
};
