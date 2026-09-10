/**
 * Port for evicting cached authorization data.
 *
 * Injected into the services that change grants, and **awaited** — a revoke
 * must be effective before its own HTTP response returns, so this is not
 * fire-and-forget via the event bus.
 *
 * The no-op implementation is what runs when caching is disabled, which keeps
 * the services free of `if (cache)` branches.
 */
export interface IGrantsInvalidator {
    /**
     * One user's grants changed — a role was assigned to or revoked from them.
     * Cheap and precise.
     */
    invalidateUser(userId: string): Promise<void>;

    /**
     * Something changed that affects an unknown set of users — a role's
     * permission set was edited, a role was deactivated or deleted, or the
     * permission catalog was re-synced.
     *
     * Deliberately a blunt instrument: computing the exact affected set means
     * querying every assignment of that role, whereas this is O(1) and
     * correct. Role definitions change rarely; assignments change often.
     */
    invalidateAll(reason: string): Promise<void>;
}

/** Used when caching is switched off. */
export const NOOP_GRANTS_INVALIDATOR: IGrantsInvalidator = {
    async invalidateUser() {
        /* nothing cached */
    },
    async invalidateAll() {
        /* nothing cached */
    },
};
