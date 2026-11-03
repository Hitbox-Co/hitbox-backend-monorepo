/**
 * What a reward file is, read from its MIME type: a video, a music track, a
 * GIF, or an image (posters, artwork). Anything else — a PDF, an archive — is
 * not reward content and is refused before an upload URL is issued.
 *
 * Derived, not stored: the MIME type on the media row is the fact, and a
 * second column could only disagree with it.
 */
export type RewardKind = 'VIDEO' | 'AUDIO' | 'GIF' | 'IMAGE';

export const REWARD_MIME_TYPES: Record<RewardKind, readonly string[]> = {
    VIDEO: ['video/mp4', 'video/webm', 'video/quicktime'],
    AUDIO: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac'],
    GIF: ['image/gif'],
    IMAGE: ['image/jpeg', 'image/png', 'image/webp'],
};

export function rewardKindOf(mimeType: string): RewardKind | null {
    const mime = mimeType.trim().toLowerCase();
    for (const [kind, types] of Object.entries(REWARD_MIME_TYPES) as [RewardKind, readonly string[]][]) {
        if (types.includes(mime)) return kind;
    }
    return null;
}

export const ALL_REWARD_MIME_TYPES: string[] = Object.values(REWARD_MIME_TYPES).flat();
