import { actionSatisfies } from '@hitbox/access-control';
import { parseCapability, parsePermissionKeyOrThrow } from '@hitbox/access-control';
import { ROLE_CATALOG } from '@hitbox/access-control';
import {
    RELEASE_DECISION_CAPABILITIES,
    RELEASE_OVERRIDE_CAPABILITY,
    RELEASE_READ_CAPABILITY,
    RELEASE_SUBMIT_CAPABILITY,
} from '../src/constants/releases.constant';

/**
 * Does the role catalog actually let the right people through the route gates?
 *
 * This exists because it did not. The decision route was gated on
 * `release-approval:manage`, and `approve` neither is nor implies `manage` —
 * so ARTIST and BRAND_ADMIN, the two roles the whole authority rule exists to
 * serve, got a 403 before the service was ever reached. A unit test of
 * `canApprove` could not catch it: that function was correct, and unreachable.
 */

const permissionsOf = (roleName: string): string[] =>
    ROLE_CATALOG.find((role) => role.name === roleName)?.permissions ?? [];

/** Would the guard let this role through a route requiring any of these? */
function passes(roleName: string, capabilities: readonly string[]): boolean {
    const held = permissionsOf(roleName).map((key) => parsePermissionKeyOrThrow(key));
    return capabilities.some((capability) => {
        const required = parseCapability(capability);
        if (!required) throw new Error(`"${capability}" is not a valid capability.`);
        return held.some(
            (grant) =>
                grant.resource === required.resource &&
                actionSatisfies(grant.action, required.action),
        );
    });
}

describe('the decision route admits everyone the authority rule needs', () => {
    it.each(['ARTIST', 'BRAND_ADMIN'])(
        'lets %s reach the decision endpoint',
        (role) => {
            // The regression. These roles hold approve/reject and NOT manage.
            expect(passes(role, RELEASE_DECISION_CAPABILITIES)).toBe(true);
        },
    );

    it('lets HITBOX_SYSTEM_ADMIN reach it', () => {
        expect(passes('HITBOX_SYSTEM_ADMIN', RELEASE_DECISION_CAPABILITIES)).toBe(true);
    });

    it('keeps BRAND_EMPLOYEE out — read-only on releases by design', () => {
        expect(passes('BRAND_EMPLOYEE', RELEASE_DECISION_CAPABILITIES)).toBe(false);
    });

    it('keeps HITBOX_DROP_MANAGER out of deciding', () => {
        // They manage drops, not approvals. They can submit, not sign off.
        expect(passes('HITBOX_DROP_MANAGER', RELEASE_DECISION_CAPABILITIES)).toBe(false);
    });

    it('keeps a buyer out', () => {
        expect(passes('BUYER_COLLECTOR', RELEASE_DECISION_CAPABILITIES)).toBe(false);
    });

    it('would have BLOCKED artists under the old manage-only gate', () => {
        // Locks in the reason this file exists, so nobody "simplifies" the
        // route back to a single capability.
        expect(passes('ARTIST', ['release-approval:manage'])).toBe(false);
        expect(passes('BRAND_ADMIN', ['release-approval:manage'])).toBe(false);
    });
});

describe('the submit route admits everyone who owns a drop', () => {
    it.each(['ARTIST', 'BRAND_ADMIN', 'BRAND_EMPLOYEE', 'HITBOX_DROP_MANAGER', 'HITBOX_SYSTEM_ADMIN'])(
        'lets %s submit a drop for review',
        (role) => {
            expect(passes(role, [RELEASE_SUBMIT_CAPABILITY])).toBe(true);
        },
    );

    it('keeps a buyer out', () => {
        // `drop:read:public` is not `drop:manage`.
        expect(passes('BUYER_COLLECTOR', [RELEASE_SUBMIT_CAPABILITY])).toBe(false);
    });

    it('would have BLOCKED the Drop Manager under the old release-capability gate', () => {
        expect(passes('HITBOX_DROP_MANAGER', ['release-approval:manage'])).toBe(false);
    });
});

describe('reopen stays a platform-only power', () => {
    it('admits HITBOX_SYSTEM_ADMIN alone', () => {
        const admitted = ROLE_CATALOG
            .filter((role) => passes(role.name, [RELEASE_OVERRIDE_CAPABILITY]))
            .map((role) => role.name);
        expect(admitted).toEqual(['HITBOX_SYSTEM_ADMIN']);
    });
});

describe('the read route', () => {
    it.each(['ARTIST', 'BRAND_ADMIN', 'BRAND_EMPLOYEE', 'HITBOX_DROP_MANAGER', 'HITBOX_SYSTEM_ADMIN'])(
        'admits %s',
        (role) => {
            expect(passes(role, [RELEASE_READ_CAPABILITY])).toBe(true);
        },
    );
});
