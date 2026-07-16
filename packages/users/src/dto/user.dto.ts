import { z } from 'zod';
import type { User } from '@hitbox/database';

export const updateProfileSchema = z
    .object({
        username: z
            .string()
            .min(3)
            .max(50)
            .regex(/^[a-zA-Z0-9_.]+$/, 'Only letters, numbers, "_" and "." are allowed'),
        firstName: z.string().max(100),
        lastName: z.string().max(100),
        avatarUrl: z.string().url(),
    })
    .partial()
    .strict();

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;

/** What anyone may see about a user. */
export interface PublicUserDto {
    id: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    createdAt: Date;
}

/** What the user sees about themselves. */
export interface MeDto extends PublicUserDto {
    email: string;
    role: User['role'];
    state: User['state'];
    rewardPoints: number;
}

export function toPublicUser(user: User): PublicUserDto {
    return {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
    };
}

export function toMe(user: User): MeDto {
    return {
        ...toPublicUser(user),
        email: user.email,
        role: user.role,
        state: user.state,
        rewardPoints: user.rewardPoints,
    };
}
