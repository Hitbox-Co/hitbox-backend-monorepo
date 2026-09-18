import { createClerkClient } from '@clerk/backend';
import type { ClerkClient } from '@clerk/backend';

/**
 * Auth's side of the `IIdentityInvitations` port that `@hitbox/access-control`
 * declares: ask Clerk to email someone a sign-up link.
 *
 * The interface is not imported — it is structural, because auth is the
 * provider here and a provider importing its consumer's types has the
 * dependency arrow backwards. Bootstrap checks the shapes by assignment.
 *
 * **Why an invitation and not `users.createUser`.** Clerk's backend API can
 * create an account outright, with a password supplied by the caller. That
 * would mean HitBox generating, transmitting and briefly holding a colleague's
 * credential — and then having to get it to them over some channel. The
 * invitation flow instead emails a one-time link and lets the person set their
 * own password or passkey, so no HitBox system ever sees it. The cost is that
 * the account does not exist until they accept, which is precisely what the
 * `StaffInvitation` table is for.
 *
 * The secret key is passed in rather than read from `env` here so this class
 * has no import-time dependency on configuration and is trivially fakeable.
 */
export interface ClerkInvitationsAdapterConfig {
    secretKey: string;
    /**
     * Where Clerk sends the person after they accept — the admin dashboard's
     * sign-up completion route. Optional: Clerk falls back to the instance's
     * configured URL.
     */
    redirectUrl?: string | undefined;
}

export class ClerkInvitationsAdapter {
    private readonly clerk: ClerkClient;

    constructor(private readonly config: ClerkInvitationsAdapterConfig) {
        this.clerk = createClerkClient({ secretKey: config.secretKey });
    }

    async sendInvitation(input: {
        email: string;
        redirectUrl?: string | undefined;
    }): Promise<{ providerInvitationId: string }> {
        const invitation = await this.clerk.invitations.createInvitation({
            emailAddress: input.email,
            ...(input.redirectUrl ?? this.config.redirectUrl
                ? { redirectUrl: input.redirectUrl ?? this.config.redirectUrl }
                : {}),
            // Deliberately NO publicMetadata. The role this person will hold is
            // recorded in `StaffInvitation`, not here — see the port's own
            // comment for why authorization intent must not live in the
            // identity provider.
            //
            // `ignoreExisting: false` (the default) makes Clerk reject an
            // invitation to an address that already has an account. That
            // rejection is a useful safety net rather than a nuisance: the
            // service checks for an existing HitBox user first and takes the
            // direct-assignment path, so reaching here with a known address
            // means the two stores disagree and the operator should be told.
        });

        return { providerInvitationId: invitation.id };
    }

    async revokeInvitation(providerInvitationId: string): Promise<void> {
        await this.clerk.invitations.revokeInvitation(providerInvitationId);
    }
}
