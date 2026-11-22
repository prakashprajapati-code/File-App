/** Room mailbox lifetime. Long enough to cover ICE gathering and candidate exchange. */
export const ROOM_TTL_SECONDS = 180;

/** Hard cap per side so a broken client cannot grow the room record without bound. */
export const MAX_ICE_CANDIDATES = 50;

/** Candidates accepted in one POST. The client batches anyway. */
export const MAX_ICE_CANDIDATES_PER_POST = 20;

/** Remote-candidate polling interval during pairing. */
export const CANDIDATE_POLL_MS = 300;

/** How long the TV waits for the answer before showing "code expired". */
export const ROOM_DEADLINE_MS = ROOM_TTL_SECONDS * 1000;
