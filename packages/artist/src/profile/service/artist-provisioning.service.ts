import type { Logger } from 'pino';
import { nameFromEmail, roleImpliesArtistProfile } from '../domain/artist-role';
import type { ArtistRepository, ArtistRow } from '../repository/artist.repository';

/**
 * The payload of `access-control.staff.invited`.
 *
 * Declared here, structurally, rather than imported from access-control: a
 * subscriber that imports the publisher's types turns an event — the loosest
 * coupling the architecture has — back into a compile-time dependency.
 */
export interface StaffInvitedEvent {
    invitationId: string;
    email: string;
    roleId: string;
    roleName: string;
    rolePermissions: string[];
    organizationId: string | null;
    artistName?: string | null;
    artistGenre?: string | null;
    /** Set when the invited address already had an account. */
    userId?: string | null;
}

/** The payload of `access-control.staff.invitation-accepted`. */
export interface StaffInvitationAcceptedEvent {
    invitationId: string;
    email: string;
    userId: string;
    rolePermissions: string[];
}

interface ArtistProvisioningDeps {
    artists: ArtistRepository;
    logger: Logger;
}

/**
 * Creates the `Artist` row when somebody is invited as an artist.
 *
 * ## Why at invite time rather than on acceptance
 *
 * An invited artist has no account until they sign up, which can be days. If
 * the profile only appeared then, an operator who has just invited an artist
 * could not file a drop against them, and the artist picker would not list
 * them — so the invitation would look like it had done nothing. Creating the
 * row immediately means the rest of the catalog can reference the artist from
 * the moment the invitation is sent.
 *
 * The cost is that a profile can outlive an invitation nobody accepts. That is
 * the better failure: an unclaimed profile is visible, inert and easy to
 * archive, where a missing one is invisible and looks like a bug.
 *
 * ## Two events, one row
 *
 *   `staff.invited`             → create the profile, `userId` null
 *   `staff.invitation-accepted` → fill in `userId`
 *
 * On the path where the address already had an account both fire together and
 * the row is created already linked.
 *
 * Every handler is **idempotent**: the in-process bus has no delivery
 * guarantees, ROLE_ASSIGNED is currently published twice on one path, and a
 * future broker-backed bus will redeliver. Re-handling an event must be a
 * no-op, which is what `invitationId` being unique buys.
 */
export class ArtistProvisioningService {
    constructor(private readonly deps: ArtistProvisioningDeps) { }

    async onStaffInvited(event: StaffInvitedEvent): Promise<ArtistRow | null> {
        if (!roleImpliesArtistProfile(event.rolePermissions)) return null;

        const existing = await this.deps.artists.findByInvitationId(event.invitationId);
        if (existing) {
            this.deps.logger.debug(
                { invitationId: event.invitationId, artistId: existing.id },
                'artist profile already provisioned for this invitation',
            );
            return existing;
        }

        // Someone invited again at an address that already has a profile —
        // re-invited after an expiry, or granted a second artist role. One
        // person is one artist; adopt the existing profile rather than
        // creating a duplicate that splits their drops in two.
        if (event.userId) {
            const byUser = await this.deps.artists.findByUserId(event.userId);
            if (byUser) {
                this.deps.logger.info(
                    { invitationId: event.invitationId, artistId: byUser.id },
                    'invited artist already has a profile — leaving it as it is',
                );
                return byUser;
            }
        }

        const name = event.artistName?.trim() || nameFromEmail(event.email);
        const created = await this.deps.artists.createFromInvitation({
            invitationId: event.invitationId,
            name,
            genre: event.artistGenre?.trim() || null,
            organizationId: event.organizationId,
            userId: event.userId ?? null,
        });

        this.deps.logger.info(
            {
                invitationId: event.invitationId,
                artistId: created.id,
                name: created.name,
                slug: created.slug,
                organizationId: created.organizationId,
                derivedName: !event.artistName,
            },
            'artist profile created from a staff invitation',
        );
        return created;
    }

    async onInvitationAccepted(event: StaffInvitationAcceptedEvent): Promise<ArtistRow | null> {
        if (!roleImpliesArtistProfile(event.rolePermissions)) return null;

        const profile = await this.deps.artists.findByInvitationId(event.invitationId);
        if (!profile) {
            // The invitation predates this feature, or the invite-time handler
            // failed. Create it now rather than leaving the artist without a
            // profile — late is recoverable, absent is not.
            this.deps.logger.warn(
                { invitationId: event.invitationId, userId: event.userId },
                'accepted artist invitation had no profile — creating it now',
            );
            return this.onStaffInvited({
                invitationId: event.invitationId,
                email: event.email,
                roleId: '',
                roleName: '',
                rolePermissions: event.rolePermissions,
                organizationId: null,
                userId: event.userId,
            });
        }

        if (profile.invitationId && profile.id && (await this.alreadyLinked(event.userId))) {
            return profile;
        }

        const linked = await this.deps.artists.linkUser(profile.id, event.userId);
        this.deps.logger.info(
            { invitationId: event.invitationId, artistId: profile.id, userId: event.userId },
            'artist profile linked to the account that accepted the invitation',
        );
        return linked;
    }

    /** `Artist.userId` is unique, so a second link would throw rather than duplicate. */
    private async alreadyLinked(userId: string): Promise<boolean> {
        return (await this.deps.artists.findByUserId(userId)) !== null;
    }
}
