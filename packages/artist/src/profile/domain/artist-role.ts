/**
 * Does a role make the person holding it an **artist**?
 *
 * Answered from the capabilities the role confers, never from its name. A
 * route that reads `roleName === 'ARTIST'` is correct exactly until an
 * operator defines `GUEST_ARTIST` or `RESIDENT_ARTIST` through the Roles
 * screen, at which point their invitations silently stop creating profiles and
 * nothing errors — the artist just never appears in the picker.
 *
 * The capability that means it is `brand-artist-record` at **`own`** scope:
 * "you may read and update *your own* artist record", which is only true of
 * somebody who has one. A Brand Admin holds the same resource at
 * `:organization` — they administer other people's artist records without
 * being an artist — and that distinction is exactly what separates the two.
 *
 * In the seeded catalog this matches `ARTIST` and nothing else.
 */
const ARTIST_RESOURCE = 'brand-artist-record';

/** Scopes that mean "this record is mine", as opposed to "I administer these". */
const OWN_SCOPES = new Set(['own']);

export function roleImpliesArtistProfile(rolePermissions: readonly string[]): boolean {
    return rolePermissions.some((key) => {
        const [resource, , scope] = key.split(':');
        return resource === ARTIST_RESOURCE && scope !== undefined && OWN_SCOPES.has(scope);
    });
}

/**
 * A display name for an artist invited without one.
 *
 * `jane.doe@label.com` → `Jane Doe`. A guess, and one that ends up printed on
 * a product page, which is why `artistName` exists on the invite payload and
 * why this is only the fallback. Better a readable guess than the raw address:
 * an operator who sees "Jane Doe" in the picker knows to correct it, where
 * "jane.doe@label.com" reads like a bug.
 */
export function nameFromEmail(email: string): string {
    const local = email.split('@')[0] ?? email;
    const words = local
        .split(/[._\-+]+/)
        .map((part) => part.replace(/\d+$/, ''))
        .filter((part) => part.length > 0);

    if (words.length === 0) return email;
    return words
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

/**
 * A URL-safe slug candidate. Uniqueness is the repository's problem — it holds
 * the unique index and is the only place that can resolve a collision without
 * a race.
 */
export function slugify(value: string): string {
    const slug = value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug.length > 0 ? slug : 'artist';
}
