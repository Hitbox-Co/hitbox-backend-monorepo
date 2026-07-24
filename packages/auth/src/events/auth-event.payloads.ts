/**
 * Payload contracts for AUTH_EVENTS (see constants/auth.constant.ts).
 * Subscribers (e.g. the users module) import these types — never Clerk types.
 */

export interface UserRegisteredPayload {
    clerkUserId: string;
    email: string;
    emailVerified: boolean;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
}

export type UserUpdatedPayload = UserRegisteredPayload;

export interface UserDeletedPayload {
    clerkUserId: string;
}
