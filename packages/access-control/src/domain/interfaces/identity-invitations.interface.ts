/**
 * Sending an invitation through whatever identity provider the platform uses.
 *
 * Declared here and implemented in `@hitbox/auth`, which is the module that
 * owns Clerk — consumer defines the port, provider writes the adapter, and
 * bootstrap connects them (architecture doc §6). Nothing in this module names
 * Clerk, so swapping the identity provider is an adapter change.
 *
 * Note how little is passed: **an email address and nothing else.** No role, no
 * scope, no permissions. The provider's only job is to establish that the
 * person controls the address and to let them set a credential; what they are
 * allowed to do afterwards is decided here, from the `StaffInvitation` row.
 *
 * That split is deliberate. Clerk supports arbitrary `public_metadata` on an
 * invitation and stashing the role there would have been less code — but then
 * authorization intent would live outside this database: invisible to the audit
 * trail, unreadable by the permission engine, and editable by anyone with
 * access to the provider's dashboard.
 */
export interface SentInvitation {
    /** The provider's own id, kept so the invitation can be revoked there too. */
    providerInvitationId: string;
}

export interface IIdentityInvitations {
    /**
     * Asks the provider to email a sign-up link.
     *
     * Throws if the provider refuses — most commonly because an account already
     * exists for this address. The caller is expected to have handled that case
     * before getting here (see `StaffInvitationService`), so an error at this
     * point is a real failure and is recorded on the row.
     */
    sendInvitation(input: {
        email: string;
        /** Where the provider sends the person after they accept. */
        redirectUrl?: string | undefined;
    }): Promise<SentInvitation>;

    /**
     * Withdraws an invitation at the provider.
     *
     * Best-effort by contract: the local row is the authority on whether a role
     * will be granted, so a provider-side revoke that fails must not prevent
     * the local revoke. Implementations should throw and let the caller decide.
     */
    revokeInvitation(providerInvitationId: string): Promise<void>;
}

/**
 * Stands in when no identity provider is configured.
 *
 * Refuses rather than pretending to succeed: an invitation that silently went
 * nowhere would leave an administrator waiting for a colleague who was never
 * emailed. The already-registered path (which sends no invitation) still works
 * on a deployment wired with this.
 */
export const UNAVAILABLE_IDENTITY_INVITATIONS: IIdentityInvitations = {
    sendInvitation() {
        return Promise.reject(
            new Error(
                'No identity provider is configured on this deployment, so staff ' +
                'invitations cannot be emailed.',
            ),
        );
    },
    revokeInvitation() {
        return Promise.reject(
            new Error('No identity provider is configured on this deployment.'),
        );
    },
};
