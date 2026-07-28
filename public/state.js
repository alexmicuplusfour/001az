export const state = {
  boardId: null,
  boardName: null,
  boardManage: false,   // may the current user edit this board (global or board admin)
  facets: [],
  aiReasoning: true,
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
  alertEvent: null,     // ?event= view: { id, name, count, ids: Set<entityId> }
  selectedCrateId: null,
  selectedUploaderIds: new Set(),
  showFavorites: false,
  showUntagged: false,
  showProcessing: false,   // status pill: actively worked (processing/extracting/facing)
  showUnprocessed: false,  // status pill: queued, not started (pending*)
  // Active board sort: null = server default (newest first), else { by, dir }.
  // `by` is namespaced: "name"/"created"/"updated"/"hearts"/"instances"
  // (universal), "media:<fn>" (file metadata), "field:<key>" (connector-bound).
  sort: null,
  // semantic search: server-enabled flag, the input's draft text, the last
  // submitted query, and its results (Map id -> score; null = not searching)
  boardMapping: null,
  boardIngest: false,   // automatic ingestion enabled — keeps a slow delta poll alive
  boardIngestNextRun: null, // ms timestamp of the next ingestion run (toolbar chip countdown)
  boardTokens: null,
  searchAvailable: false,
  searchDraft: "",
  searchQuery: "",
  searchResults: null,
  searchLoading: false,
};
