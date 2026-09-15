/**
 * API prefixes that authenticate themselves, so the middleware must not run
 * its session check on them first.
 *
 * Only routes this repository actually contains belong here. The
 * ChatMol-operated service keeps its own list; publishing its endpoint names
 * would also leave an auth bypass standing for paths that do not exist here,
 * so whoever added one later would get it unauthenticated by default.
 */
export const SELF_AUTHENTICATED_API_PREFIXES = ["/api/settings"];
