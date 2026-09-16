// The alert caret's count, kept out of the modal it describes — same reason as
// jobs-state.js: renderToolbar reads this every render, and that is not a
// reason to carry the alerts modal in the boot payload.
//
// Unlike the other two header dots this one is not a localStorage watermark
// (see seen-mark.js's note on why): an alert firing is a per-user ledger the
// server keeps, so the count is simply summed off what signals.js last fetched.
import { state } from './state.js';

export const alertsUnseen = () => state.alerts.reduce((n, a) => n + (a.unseen || 0), 0);
