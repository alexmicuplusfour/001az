export const state = {
  boardId: null,
  boardName: null,
  boardManage: false,   // may the current user edit this board (global or board admin)
  facets: [],
  aiReasoning: true,
  boardVotes: 1,        // ai_votes: >1 means the board carries per-facet confidence
  facetStats: null,     // per-facet stability roll-up; null = not fetched yet
  facetGates: {},       // the thresholds the diagnose loop gates on, served with it
  items: [],
  // Cursor for ?since= delta polls: the server's `now` from the last items
  // response. Null = server predates delta polling, fall back to full fetches.
  itemsSince: null,
  uploading: [],
  selected: new Map(),
  bulkSelected: new Set(),
  filtersHidden: false,
  uid: 0,
  me: null,
  boards: [],
  crates: [],
  filterConfigs: [],
  alerts: [],           // the user's alerts on this board (with unseen counts)
  jobsFailedAt: null,   // newest failed job on this board (ms); drives the jobs chip's dot
  alertEvent: null,     // ?event= view: { id, name, count, ids: Set<entityId> }
  selectedCrateId: null,
  showFavorites: false,
  showUntagged: false,
  showProcessing: false,   // status pill: actively worked (processing/extracting/facing/fetching)
  showUnprocessed: false,  // status pill: queued, not started (pending*)
  showOdds: false,         // odds lens: ×N on salient chips while filtering (patterns.js; per viewer per board)
  showClusters: false,     // clusters lens: found-group row in the rail (patterns.js; per viewer per board; holds the granularity LEVEL, 0 = off)
  showMeaningClusters: 0,  // the same lens carved from embeddings instead of chips — mutually exclusive with showClusters (patterns.js owns the rule)
  // Active board sort: null = server default (newest first), else { by, dir }.
  // `by` is namespaced: "name"/"created"/"updated"/"hearts"/"instances"
  // (universal), "media:<fn>" (file metadata), "field:<key>" (connector-bound).
  sort: null,
  // Gallery view mode BASE preference: null = default (grid), else the
  // viewer's pick, persisted per board. While filters are active, a session
  // overlay in view.js takes precedence (auto-rows on filter, session-scoped
  // toggles, restored on clear) without ever touching this.
  view: null,
  // semantic search: server-enabled flag, the input's draft text, the last
  // submitted query, and its results (Map id -> score; null = not searching)
  boardMapping: null,
  boardPaused: false,   // board pause: automatic work held — the jobs chip dims, the delta poll slows
  boardIngestMode: null, // null | "manual" | "paused" | "scheduled" — drives the toolbar chip
  boardIngestNextRun: null, // ms timestamp of the next ingestion run (chip countdown; also what keeps the slow delta poll alive)
  boardUnits: null, // { unit: quantity } — every unit metered on this board, never summed across them
  boardUnitDefs: null, // the served vocabulary for boardUnits ([{ unit, label, format }])
  boardCost: null, // { micros, unpriced: [{ unit, label, format, quantity }] } — manager-only, absent when nothing was ever priced
  searchAvailable: false,
  searchDraft: "",
  searchQuery: "",
  searchResults: null,
  searchLoading: false,
  // "Find similar" rides the same results/query plumbing; this label being
  // set is what marks the mode (and feeds the toolbar's chip). searchDraft
  // stays untouched — the input remains whatever the user typed.
  searchSimilarTo: null,
};
