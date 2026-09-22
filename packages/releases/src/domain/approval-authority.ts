import { ApprovalAuthority, OrganizationType } from '@hitbox/database';

/**
 * WHO IS ENTITLED TO SIGN A RELEASE OFF.
 *
 * The rule, in one sentence: **the party that owns the drop approves it, and
 * nobody approves on their behalf.**
 *
 * | The drop's organization | Who must decide |
 * |---|---|
 * | `ARTIST_INDIVIDUAL`     | the artist named on the drop |
 * | `BRAND`                 | someone acting for that brand |
 * | `HITBOX`, or none       | HitBox staff |
 *
 * `Organization.type` is the discriminator rather than "does the drop have an
 * artistId", because most drops have both. A Lumen drop carries
 * `artistId = Lumen` *and* `organizationId = Lumen Studios (BRAND)` — the
 * artist is signed to the brand, and it is the brand that is legally
 * accountable. Only an artist-individual organization means the artist is
 * accountable for themselves.
 *
 * ## Why a HitBox administrator cannot stand in
 *
 * An approval is not just a state change; it carries an explicit acceptance of
 * the legal compliance terms by a named person. A platform administrator
 * accepting those terms for a brand would be recording an acceptance that
 * brand never gave — which is worse than the drop staying unapproved, because
 * it *looks* like consent in the audit trail.
 *
 * So the administrator's powers are deliberately shaped differently. They may
 * **reject** a drop and they may **reopen** a rejected one so the owner can
 * decide again. They may not approve one. See `canOverrideDecision` below.
 */

/** What the release module needs to know about the drop being reviewed. */
export interface OwnershipFacts {
    organizationId: string | null;
    organizationType: OrganizationType | null;
    artistId: string | null;
    /** The account backing the artist, null until they accept their invitation. */
    artistUserId: string | null;
}

export interface ResolvedAuthority {
    authority: ApprovalAuthority;
    requiredArtistId: string | null;
    requiredOrganizationId: string | null;
}

export function resolveAuthority(facts: OwnershipFacts): ResolvedAuthority {
    if (facts.organizationType === OrganizationType.ARTIST_INDIVIDUAL && facts.artistId) {
        return {
            authority: ApprovalAuthority.ARTIST,
            requiredArtistId: facts.artistId,
            requiredOrganizationId: facts.organizationId,
        };
    }

    // An artist-owned drop filed under no organization at all. Rare, but the
    // artist is plainly the owner, so treating it as a platform drop would
    // hand their sign-off to HitBox.
    if (!facts.organizationId && facts.artistId) {
        return {
            authority: ApprovalAuthority.ARTIST,
            requiredArtistId: facts.artistId,
            requiredOrganizationId: null,
        };
    }

    if (facts.organizationId && facts.organizationType === OrganizationType.BRAND) {
        return {
            authority: ApprovalAuthority.ORGANIZATION,
            requiredArtistId: facts.artistId,
            requiredOrganizationId: facts.organizationId,
        };
    }

    // HITBOX-owned, or an organization whose type we cannot read. HitBox staff
    // decide, which is the pre-existing behaviour for HitBox's own drops.
    return {
        authority: ApprovalAuthority.PLATFORM,
        requiredArtistId: facts.artistId,
        requiredOrganizationId: facts.organizationId,
    };
}

/** The caller, as far as this decision is concerned. */
export interface DecidingActor {
    userId: string;
    /**
     * Organizations the caller holds a role assignment **in**. Not the read
     * scope: a HitBox administrator reaches every organization for reading and
     * is a member of none of them, and that difference is the whole point here.
     */
    memberOrganizationIds: string[];
    /** The artist record this account backs, if any. */
    artistId: string | null;
    /** Holds `release-approval:approve` or `:manage` at some scope. */
    canDecide: boolean;
    /** Holds `release-approval:override` — platform-wide authority. */
    canOverride: boolean;
}

export interface AuthorityCheck {
    allowed: boolean;
    /** Why not, phrased for the person reading it on screen. */
    reason: string | null;
}

/**
 * May this actor record an **approval** on this review?
 *
 * `canOverride` is deliberately absent from this function. Override is not a
 * skeleton key for approval — see the module header.
 */
export function canApprove(
    approval: {
        authority: ApprovalAuthority;
        requiredArtistId: string | null;
        requiredOrganizationId: string | null;
    },
    actor: DecidingActor,
): AuthorityCheck {
    if (!actor.canDecide) {
        return { allowed: false, reason: 'You do not hold release approval rights.' };
    }

    switch (approval.authority) {
        case ApprovalAuthority.ARTIST: {
            if (!approval.requiredArtistId) {
                return {
                    allowed: false,
                    reason: 'This drop needs its artist to approve it, but no artist is set on it.',
                };
            }
            if (actor.artistId !== approval.requiredArtistId) {
                return {
                    allowed: false,
                    reason:
                        'Only the artist this drop belongs to can approve it. ' +
                        'An administrator can reject it or send it back, but cannot approve it for them.',
                };
            }
            return { allowed: true, reason: null };
        }

        case ApprovalAuthority.ORGANIZATION: {
            if (!approval.requiredOrganizationId) {
                return {
                    allowed: false,
                    reason: 'This drop needs its brand to approve it, but no brand is set on it.',
                };
            }
            if (!actor.memberOrganizationIds.includes(approval.requiredOrganizationId)) {
                return {
                    allowed: false,
                    reason:
                        'Only someone acting for the brand that owns this drop can approve it. ' +
                        'An administrator can reject it or send it back, but cannot approve it for them.',
                };
            }
            return { allowed: true, reason: null };
        }

        case ApprovalAuthority.PLATFORM:
            // HitBox's own drops. Any holder of the capability qualifies —
            // there is no separate owner to defer to.
            return { allowed: true, reason: null };
    }
}

/**
 * May this actor **reject** this review?
 *
 * Wider than approval on purpose. Pulling a drop that breaches policy is a
 * protective act, and a platform administrator must be able to do it without
 * waiting for the brand that published it to agree. The asymmetry is the
 * design: consent is narrow, refusal is broad.
 */
export function canReject(
    approval: {
        authority: ApprovalAuthority;
        requiredArtistId: string | null;
        requiredOrganizationId: string | null;
    },
    actor: DecidingActor,
): AuthorityCheck {
    if (!actor.canDecide) {
        return { allowed: false, reason: 'You do not hold release approval rights.' };
    }
    if (actor.canOverride) return { allowed: true, reason: null };
    return canApprove(approval, actor);
}

/**
 * May this actor reverse a decision already recorded?
 *
 * Only an override holder, and only toward REJECTED. Reversing a rejection
 * into an approval would let the override capability manufacture an owner's
 * legal acceptance, which is exactly what the authority rule exists to
 * prevent — the route back to APPROVED is to reopen the review and let the
 * owner decide again.
 */
export function canOverrideDecision(
    target: 'APPROVED' | 'REJECTED',
    actor: DecidingActor,
): AuthorityCheck {
    if (!actor.canOverride) {
        return {
            allowed: false,
            reason: 'This review has already been decided. Reversing it requires the override permission.',
        };
    }
    if (target === 'APPROVED') {
        return {
            allowed: false,
            reason:
                'A decided review cannot be overridden into an approval — that would record a ' +
                'legal acceptance the owner never gave. Reopen it instead, so the owner can approve it.',
        };
    }
    return { allowed: true, reason: null };
}

/**
 * Which persona the trail records this actor as.
 *
 * Derived from their relationship to *this* drop rather than from their role
 * name: the same person can be the artist on one review and a platform
 * administrator on another, and the trail should say which hat they were
 * wearing when they acted.
 */
export function auditActorType(
    approval: { requiredArtistId: string | null; requiredOrganizationId: string | null },
    actor: DecidingActor,
): 'ARTIST' | 'BRAND_EMPLOYEE' | 'HITBOX_ADMIN' {
    if (approval.requiredArtistId && actor.artistId === approval.requiredArtistId) {
        return 'ARTIST';
    }
    if (
        approval.requiredOrganizationId &&
        actor.memberOrganizationIds.includes(approval.requiredOrganizationId)
    ) {
        return 'BRAND_EMPLOYEE';
    }
    return 'HITBOX_ADMIN';
}

export { ApprovalAuthority };
