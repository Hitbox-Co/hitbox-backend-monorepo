import { z } from 'zod';

/** Outer shape of every Clerk webhook event. */
export const clerkWebhookEnvelopeSchema = z.object({
    type: z.string(),
    data: z.record(z.unknown()),
});

export type ClerkWebhookEnvelope = z.infer<typeof clerkWebhookEnvelopeSchema>;

const clerkEmailSchema = z.object({
    id: z.string(),
    email_address: z.string().email(),
    // Clerk marks each email's verification; primary must be "verified".
    verification: z.object({ status: z.string() }).nullish(),
});

/**
 * Profile fields the mobile app tucks into unsafe_metadata at sign-up,
 * because the Clerk instance has username / name attributes disabled.
 */
const clerkUnsafeMetadataSchema = z
    .object({
        username: z.string().nullish(),
        firstName: z.string().nullish(),
        lastName: z.string().nullish(),
    })
    .partial()
    .passthrough();

/** `data` for user.created / user.updated. */
export const clerkUserPayloadSchema = z.object({
    id: z.string(),
    email_addresses: z.array(clerkEmailSchema).default([]),
    primary_email_address_id: z.string().nullish(),
    username: z.string().nullish(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    image_url: z.string().nullish(),
    unsafe_metadata: clerkUnsafeMetadataSchema.nullish(),
});

export type ClerkUserPayload = z.infer<typeof clerkUserPayloadSchema>;

/** `data` for user.deleted. */
export const clerkDeletedUserPayloadSchema = z.object({
    id: z.string(),
});

function primaryEmailRecord(user: ClerkUserPayload) {
    const primary = user.email_addresses.find(
        (address) => address.id === user.primary_email_address_id,
    );
    return primary ?? user.email_addresses[0] ?? null;
}

export function resolvePrimaryEmail(user: ClerkUserPayload): string | null {
    return primaryEmailRecord(user)?.email_address ?? null;
}

/** True only when the primary email's Clerk verification status is "verified". */
export function isPrimaryEmailVerified(user: ClerkUserPayload): boolean {
    return primaryEmailRecord(user)?.verification?.status === 'verified';
}
