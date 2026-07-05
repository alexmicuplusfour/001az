export const state = {
  boardId: null,
  boardName: null,
  adapter: null, // the board type's client adapter (types/), set at boot
  facets: [],
  aiReasoning: true,
  images: [],
  uploading: [],
  selected: new Map(),
  bulkSelected: new Set(),
  filtersHidden: false,
  uid: 0,
  me: null,
  boards: [],
  crates: [],
  selectedCrateId: null,
  showFavorites: false,
  sortByHearts: false,
};
