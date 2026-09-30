/**
 * Somewhere to put an artist who arrives without a brand behind them.
 *
 * ## Why an artist invitation needs an organization at all
 *
 * The `ARTIST` role's working capabilities are organization-scoped —
 * `drop:manage:organization`, `release-approval:read:organization`,
 * `release-approval:approve:organization`. The authorization engine satisfies
 * an organization-scoped grant only through an assignment that names an
 * organization; an assignment with no `scopeId` is rejected outright
 * ("organization-scoped assignment of ARTIST has no organization id"), whatever
 * the request context says.
 *
 * So an artist invited at `OWN` scope, or at `ORGANIZATION` scope with no
 * organization, is provisioned into a state where **they can never see their
 * own drops or the approvals waiting on them**. Nothing fails at invite time;
 * it fails silently, later, as an empty dashboard — which is how it went
 * unnoticed.
 *
 * A self-releasing artist is still an organization of one. That is already the
 * shape the platform uses: `OrganizationType.ARTIST_INDIVIDUAL` exists for
 * exactly this, and the seeded solo artist has an organization of their own.
 * This port lets the invitation flow create that organization rather than
 * refusing the invitation or producing an artist nobody can authorize.
 *
 * Defined here and implemented in bootstrap: access-control owns no
 * organization table and must not import the module that does.
 */
export interface ISoloOrganizations {
    /**
     * The `ARTIST_INDIVIDUAL` organization for a self-releasing artist,
     * creating it when it does not exist yet.
     *
     * Idempotent on `email`: re-inviting the same address must land on the same
     * organization rather than splitting one artist's catalog across two.
     */
    ensureForArtist(input: {
        /** The artist's display name, when the inviter supplied one. */
        name: string | null;
        /** The invited address — the stable identity to deduplicate on. */
        email: string;
    }): Promise<{ id: string; name: string }>;
}
