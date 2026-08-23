export const USERS_EVENTS = {
    /**
     * A local user row now exists for a Clerk identity. Emitted AFTER the
     * projection is committed, which is why the authorization module listens
     * for this instead of auth's `auth.user.registered`: a role assignment
     * needs the user row to exist, and the in-process bus gives no ordering
     * guarantee between two subscribers of the same event.
     */
    USER_PROVISIONED: 'users.user.provisioned',
    /** The account was soft-deleted or suspended — cached access must be dropped. */
    USER_DEACTIVATED: 'users.user.deactivated',
} as const;

export type UsersEventName = (typeof USERS_EVENTS)[keyof typeof USERS_EVENTS];

export interface UserProvisionedPayload {
    userId: string;
    clerkUserId: string;
    email: string;
    /** True the first time this identity was projected, false on a re-sync. */
    firstTime: boolean;
}

export interface UserDeactivatedPayload {
    userId: string;
    clerkUserId: string;
    reason: 'deleted' | 'suspended';
}
