import { Visibility } from '@hitbox/database';
import type { User } from '@hitbox/database';
import { z } from 'zod';

/**
 * Profile fields a user may edit on themselves.
 *
 * `preferredMarketId` is deliberately absent: it is a foreign key, and
 * accepting one here would let a client write an arbitrary uuid that only
 * fails at the database. It belongs behind an endpoint that validates the
 * market exists and is active.
 */
export const updateProfileSchema = z
    .object({
        handle: z
            .string()
            .min(3)
            .max(50)
            .regex(/^[a-zA-Z0-9_.]+$/, 'Only letters, numbers, "_" and "." are allowed'),
        fullName: z.string().min(1).max(200),
        avatarUrl: z.string().url(),
        bio: z.string().max(500),
        phone: z.string().min(5).max(32),
        generalLocation: z.string().max(120),
        profileVisibility: z.nativeEnum(Visibility),
    })
    .partial()
    .strict();

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;

/**
 * What anyone may see about a user.
 *
 * `bio` is included because it is profile copy the user wrote for display.
 * `generalLocation` is NOT — it is coarse location, and the platform treats
 * location as something only staff read, and only masked.
 */
export interface PublicUserDto {
    id: string;
    handle: string | null;
    fullName: string | null;
    avatarUrl: string | null;
    bio: string | null;
    createdAt: Date;
}

/** What the user sees about themselves. */
export interface MeDto extends PublicUserDto {
    email: string;
    phone: string | null;
    role: User['role'];
    profileVisibility: User['profileVisibility'];
    generalLocation: string | null;
    preferredMarketId: string | null;
    isActive: boolean;
    updatedAt: Date;
}

export function toPublicUser(user: User): PublicUserDto {
    return {
        id: user.id,
        handle: user.handle,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        createdAt: user.createdAt,
    };
}

export function toMe(user: User): MeDto {
    return {
        ...toPublicUser(user),
        email: user.email,
        phone: user.phone,
        role: user.role,
        profileVisibility: user.profileVisibility,
        generalLocation: user.generalLocation,
        preferredMarketId: user.preferredMarketId,
        isActive: user.isActive,
        updatedAt: user.updatedAt,
    };
}
