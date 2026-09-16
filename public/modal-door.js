// The toolbar's modals, as functions that fetch their own code.
//
// Each export here has the same name and signature as the modals.js export it
// stands for, so call sites read exactly as they did before the split — the
// only difference is that they now return a promise. Importing this file costs
// nothing: the barrel is behind the dynamic import inside lazyDoor.
import { lazyDoor } from './lazy-door.js';

const door = lazyDoor(() => import('./modals.js'), {
  failMsg: "Couldn't open that — check your connection",
});

export const openIngestModal = door.fn('openIngestModal');
export const openBoardModal = door.fn('openBoardModal');
export const openConnectorBrowse = door.fn('openConnectorBrowse');
export const openAlertHistory = door.fn('openAlertHistory');
export const openJobsModal = door.fn('openJobsModal');
export const openDiagnosticsModal = door.fn('openDiagnosticsModal');

// The escape hatch, for the one caller that needs SEVERAL of the barrel's
// exports resolved together: openDropdown calls build() and footer()
// synchronously, so the alert menu has to have both appenders in hand before
// the menu opens. Everything else should use the named exports above.
export const withModals = door.wrap;

export const preloadModals = door.preload;
