// The jobs chip's two always-on facts, kept out of the modal they describe.
//
// renderToolbar asks "is the dot lit?" on every render and signals.js asks "is
// the modal open?" every 20 seconds to decide whether to poll — neither is a
// reason to have the 13 kB modal in the boot payload, so both live here and
// jobs-modal.js is fetched when something opens it.
import { state } from './state.js';
import { unseen, JOBS_SEEN as SEEN } from './seen-mark.js';

export const jobsUnseen = () => unseen(SEEN, state.boardId, state.jobsFailedAt);

// Written by the modal, read by signals.js, which stands its own 20-second
// read down while the dialog is up: the dialog polls the board stamp four
// times as often and acknowledges what it draws, so it is the authority on
// state.jobsFailedAt for as long as it lives, and a second writer there is not
// merely redundant but wrong.
//
// A flag rather than a getter over the modal's own element, because the
// question gets asked before that module exists — and the answer then is not a
// fallback, it is correct: a module that has never loaded cannot be showing
// anything.
let open = false;
export const jobsModalOpen = () => open;
export const setJobsOpen = (v) => { open = !!v; };
