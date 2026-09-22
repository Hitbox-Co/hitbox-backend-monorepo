import { ApprovalAuthority, OrganizationType } from '@hitbox/database';
import {
    auditActorType,
    canApprove,
    canOverrideDecision,
    canReject,
    resolveAuthority,
} from '../src/domain/approval-authority';
import type { DecidingActor } from '../src/domain/approval-authority';
import { decideReleaseApprovalSchema } from '../src/dto/release.dto';

const ARTIST_ID = 'artist-kaze';
const BRAND_ID = 'org-lumen';

const artistUser: DecidingActor = {
    userId: 'u-kaze',
    memberOrganizationIds: [],
    artistId: ARTIST_ID,
    canDecide: true,
    canOverride: false,
};

const brandUser: DecidingActor = {
    userId: 'u-brand',
    memberOrganizationIds: [BRAND_ID],
    artistId: null,
    canDecide: true,
    canOverride: false,
};

/** Holds everything globally, is a member of nothing. That is the point. */
const platformAdmin: DecidingActor = {
    userId: 'u-admin',
    memberOrganizationIds: [],
    artistId: null,
    canDecide: true,
    canOverride: true,
};

describe('resolveAuthority — the owner decides', () => {
    it('sends an artist-individual drop to the artist', () => {
        expect(
            resolveAuthority({
                organizationId: 'org-kaze-solo',
                organizationType: OrganizationType.ARTIST_INDIVIDUAL,
                artistId: ARTIST_ID,
                artistUserId: 'u-kaze',
            }),
        ).toEqual({
            authority: ApprovalAuthority.ARTIST,
            requiredArtistId: ARTIST_ID,
            requiredOrganizationId: 'org-kaze-solo',
        });
    });

    it('sends a brand drop to the brand, even though it names an artist', () => {
        // The case that makes organization.type the discriminator rather than
        // "does it have an artistId": most brand drops have both.
        expect(
            resolveAuthority({
                organizationId: BRAND_ID,
                organizationType: OrganizationType.BRAND,
                artistId: ARTIST_ID,
                artistUserId: 'u-kaze',
            }),
        ).toMatchObject({
            authority: ApprovalAuthority.ORGANIZATION,
            requiredOrganizationId: BRAND_ID,
        });
    });

    it('sends a HitBox drop to the platform', () => {
        expect(
            resolveAuthority({
                organizationId: 'org-hitbox',
                organizationType: OrganizationType.HITBOX,
                artistId: null,
                artistUserId: null,
            }).authority,
        ).toBe(ApprovalAuthority.PLATFORM);
    });

    it('sends an unfiled artist drop to the artist rather than the platform', () => {
        expect(
            resolveAuthority({
                organizationId: null,
                organizationType: null,
                artistId: ARTIST_ID,
                artistUserId: 'u-kaze',
            }).authority,
        ).toBe(ApprovalAuthority.ARTIST);
    });
});

describe('canApprove — nobody approves on the owner\'s behalf', () => {
    const artistDrop = {
        authority: ApprovalAuthority.ARTIST,
        requiredArtistId: ARTIST_ID,
        requiredOrganizationId: null,
    };
    const brandDrop = {
        authority: ApprovalAuthority.ORGANIZATION,
        requiredArtistId: ARTIST_ID,
        requiredOrganizationId: BRAND_ID,
    };

    it('lets the named artist approve their own drop', () => {
        expect(canApprove(artistDrop, artistUser).allowed).toBe(true);
    });

    it('refuses a different artist', () => {
        expect(
            canApprove(artistDrop, { ...artistUser, artistId: 'artist-someone-else' }).allowed,
        ).toBe(false);
    });

    it('REFUSES the platform admin on an artist drop', () => {
        // The headline rule. An override holder is not exempt.
        const check = canApprove(artistDrop, platformAdmin);
        expect(check.allowed).toBe(false);
        expect(check.reason).toMatch(/cannot approve it for them/i);
    });

    it('REFUSES the platform admin on a brand drop', () => {
        expect(canApprove(brandDrop, platformAdmin).allowed).toBe(false);
    });

    it('lets a member of the owning brand approve', () => {
        expect(canApprove(brandDrop, brandUser).allowed).toBe(true);
    });

    it('refuses a member of a different brand', () => {
        expect(
            canApprove(brandDrop, { ...brandUser, memberOrganizationIds: ['org-other'] }).allowed,
        ).toBe(false);
    });

    it('refuses the artist named on a brand drop — the brand is accountable', () => {
        expect(canApprove(brandDrop, artistUser).allowed).toBe(false);
    });

    it('lets any capable caller approve a platform drop', () => {
        const platformDrop = {
            authority: ApprovalAuthority.PLATFORM,
            requiredArtistId: null,
            requiredOrganizationId: null,
        };
        expect(canApprove(platformDrop, platformAdmin).allowed).toBe(true);
    });

    it('refuses anyone without approval rights at all', () => {
        expect(canApprove(artistDrop, { ...artistUser, canDecide: false }).allowed).toBe(false);
    });
});

describe('canReject — refusal is broader than consent', () => {
    const brandDrop = {
        authority: ApprovalAuthority.ORGANIZATION,
        requiredArtistId: null,
        requiredOrganizationId: BRAND_ID,
    };

    it('lets the platform admin reject a brand drop they cannot approve', () => {
        // Pulling a drop that breaches policy must not wait for the brand that
        // published it to agree.
        expect(canApprove(brandDrop, platformAdmin).allowed).toBe(false);
        expect(canReject(brandDrop, platformAdmin).allowed).toBe(true);
    });

    it('still lets the owner reject their own drop', () => {
        expect(canReject(brandDrop, brandUser).allowed).toBe(true);
    });

    it('refuses an unrelated brand', () => {
        expect(
            canReject(brandDrop, { ...brandUser, memberOrganizationIds: ['org-other'] }).allowed,
        ).toBe(false);
    });
});

describe('canOverrideDecision — override is not a route to approval', () => {
    it('lets an override holder reverse a decision into a rejection', () => {
        expect(canOverrideDecision('REJECTED', platformAdmin).allowed).toBe(true);
    });

    it('REFUSES overriding into an approval, even for the admin', () => {
        // Otherwise the override capability manufactures an owner's legal
        // acceptance, which is what the whole authority rule exists to prevent.
        const check = canOverrideDecision('APPROVED', platformAdmin);
        expect(check.allowed).toBe(false);
        expect(check.reason).toMatch(/reopen it instead/i);
    });

    it('refuses anyone without the override capability', () => {
        expect(canOverrideDecision('REJECTED', brandUser).allowed).toBe(false);
    });
});

describe('auditActorType — which hat they wore on this drop', () => {
    it('records the artist as ARTIST', () => {
        expect(
            auditActorType(
                { requiredArtistId: ARTIST_ID, requiredOrganizationId: null },
                artistUser,
            ),
        ).toBe('ARTIST');
    });

    it('records a brand member as BRAND_EMPLOYEE', () => {
        expect(
            auditActorType(
                { requiredArtistId: null, requiredOrganizationId: BRAND_ID },
                brandUser,
            ),
        ).toBe('BRAND_EMPLOYEE');
    });

    it('records everyone else as HITBOX_ADMIN', () => {
        expect(
            auditActorType(
                { requiredArtistId: ARTIST_ID, requiredOrganizationId: BRAND_ID },
                platformAdmin,
            ),
        ).toBe('HITBOX_ADMIN');
    });
});

describe('the legal compliance tickmark', () => {
    it('refuses an approval without it', () => {
        const result = decideReleaseApprovalSchema.safeParse({ status: 'APPROVED' });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => /legal compliance/i.test(i.message))).toBe(true);
        }
    });

    it('refuses an approval that ticks it false', () => {
        expect(
            decideReleaseApprovalSchema.safeParse({
                status: 'APPROVED',
                acceptLegalCompliance: false,
            }).success,
        ).toBe(false);
    });

    it('accepts an approval that ticks it true', () => {
        expect(
            decideReleaseApprovalSchema.safeParse({
                status: 'APPROVED',
                acceptLegalCompliance: true,
            }).success,
        ).toBe(true);
    });

    it('does not require it to reject — refusing carries no liability', () => {
        expect(
            decideReleaseApprovalSchema.safeParse({
                status: 'REJECTED',
                comment: 'Artwork rights unclear.',
            }).success,
        ).toBe(true);
    });

    it('still requires a note on rejection', () => {
        expect(decideReleaseApprovalSchema.safeParse({ status: 'REJECTED' }).success).toBe(false);
    });
});
