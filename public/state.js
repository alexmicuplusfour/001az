export const state = {
  boardId: null,
  boardName: null,
  boardManage: false,   // may the current user edit this board (global or board admin)
  facets: [],
  aiReasoning: true,
  items: [],
  uploading: [],
  selected: new Map(),
  bulkSelected: new Set(),
  filtersHidden: false,
  uid: 0,
  me: null,
  boards: [],
  crates: [],
  filterConfigs: [],
  selectedCrateId: null,
  selectedUploaderIds: new Set(),
  showFavorites: false,
  showUntagged: false,
  showProcessing: false,   // status pill: actively worked (processing/extracting/facing)
  showUnprocessed: false,  // status pill: queued, not started (pending*)
  sortByHearts: false,
  sortAlpha: false,
  // semantic search: server-enabled flag, the input's draft text, the last
  // submitted query, and its results (Map id -> score; null = not searching)
  boardMapping: null,
  boardTokens: null,
  searchAvailable: false,
  searchDraft: "",
  searchQuery: "",
  searchResults: null,
  searchLoading: false,
};
