// One lazy door for the toolbar's modals.
//
// Every export here is reached only by a click, so none of it belongs in the
// boot payload — but it is deliberately ONE module rather than one per modal.
// Measured (planning/app-loading-plan.md, Stage 2): giving each modal its own
// dynamic import makes the bundler factor out a separate shared chunk per
// entry point, and the BOOT path then has to fetch all of them — eight lazy
// roots cost twelve eager files where one barrel costs four, and the barrel is
// smaller besides. Per-modal granularity buys nothing a reader notices, since
// anyone who opens one of these will open others.
//
// The detail view is NOT here: it has its own door (detail-open.js) because it
// is reached from a different gesture — clicking an item, which is far more
// common than any toolbar button — and deserves its own chunk.
export { openIngestModal } from './ingest-modal.js';
export { openBoardModal } from './board-modal.js';
export { openConnectorBrowse } from './connector-browse.js';
export { appendAlertMenu, appendAlertFooter, openAlertHistory } from './alerts-modal.js';
export { openJobsModal } from './jobs-modal.js';
export { openDiagnosticsModal } from './facet-diagnostics.js';
