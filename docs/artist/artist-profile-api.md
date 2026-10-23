# Artist Profile API — "My Profile" for artists

> **What this is:** the endpoints an **artist** uses to manage **their own**
> profile — display name, public handle, bio, genre, whether the profile is
> public, and their **avatar** and **cover image**.
>
> **Who can use it:** artists only (anyone holding the ARTIST role).
> Everything is always about *the signed-in artist's own profile* — there is no
> artist id in any URL, so nobody can reach someone else's profile.
>
> Related: how artists get an account in the first place —
> [authorization/admin-provisioning.md](../authorization/admin-provisioning.md);
> the admin-side artist picker (`GET /admin/artists`) —
> [admin/product-upload-api.md §4](../admin/product-upload-api.md);
> bucket setup for images — [media/s3-configuration.md](../media/s3-configuration.md);
> the artist's **collections** (create, edit, reorder, delete — same artist-only
> access) — [artist-collection/](../artist-collection/README.md).

---

## Contents

1. [Quick start](#1-quick-start)
2. [All endpoints at a glance](#2-all-endpoints-at-a-glance)
3. [Every field on the artist profile — editable or not](#3-every-field-on-the-artist-profile--editable-or-not)
4. [`GET /artist/me` — read my profile](#4-get-artistme--read-my-profile)
5. [`PATCH /artist/me` — edit name, handle, bio, genre, visibility](#5-patch-artistme--edit-name-handle-bio-genre-visibility)
6. [`GET /artist/genres` — the genre list](#6-get-artistgenres--the-genre-list)
7. [Avatar & cover image — upload, set, remove](#7-avatar--cover-image--upload-set-remove)
8. [Who can call this](#8-who-can-call-this)
9. [Errors](#9-errors)
10. [Where the code lives](#10-where-the-code-lives)
11. [Frontend checklist](#11-frontend-checklist)
12. [Not built](#12-not-built)

All paths below are under **`/api/v1`** and need a Clerk session
(`Authorization: Bearer <token>`).

---

## 1. Quick start

```http
# See my profile
GET /api/v1/artist/me

# Change my name, bio and genre, and make the profile public
PATCH /api/v1/artist/me
{ "name": "Kaze", "bio": "Tokyo-born producer.", "genre": "ELECTRONIC", "isPublic": true }

# Upload a new avatar (3 steps)
POST /api/v1/artist/me/avatar/upload-url      { "fileName": "me.png", "mimeType": "image/png", "sizeBytes": 482113 }
PUT  <uploadUrl from the response>            ← the raw file bytes, straight to S3
PUT  /api/v1/artist/me/avatar                 { "assetId": "<assetId from step 1>" }
```

The cover image works exactly the same way with `cover` in place of `avatar`.

---

## 2. All endpoints at a glance

| Method | Path | What it does |
|---|---|---|
| `GET` | `/artist/me` | My full profile |
| `PATCH` | `/artist/me` | Edit name, slug (handle), bio, genre, isPublic |
| `GET` | `/artist/genres` | The genres I can choose from |
| `POST` | `/artist/me/avatar/upload-url` | Step 1 of an avatar upload — get a presigned S3 URL |
| `PUT` | `/artist/me/avatar` | Step 3 — set the uploaded file as my avatar |
| `DELETE` | `/artist/me/avatar` | Remove my avatar |
| `POST` | `/artist/me/cover/upload-url` | Step 1 of a cover upload |
| `PUT` | `/artist/me/cover` | Step 3 — set the uploaded file as my cover |
| `DELETE` | `/artist/me/cover` | Remove my cover |

Every write returns the **whole updated profile**, so the screen can
re-render straight from the response.

---

## 3. Every field on the artist profile — editable or not

This is every column of the `Artist` table and what an artist can do with it.

| Field | Artist can edit? | How | Notes |
|---|---|---|---|
| `name` | ✅ | `PATCH /artist/me` | Display name, 1–120 characters. Printed on drops and the storefront |
| `slug` | ✅ | `PATCH /artist/me` | Public handle used in profile URLs. 3–60 chars, lowercase letters, digits and single hyphens (`the-midnight-club`). Must be unique |
| `bio` | ✅ | `PATCH /artist/me` | Up to 2000 characters. `""` or `null` clears it |
| `genre` | ✅ | `PATCH /artist/me` | Pick one from [`GET /artist/genres`](#6-get-artistgenres--the-genre-list). `null` clears it |
| `isPublic` | ✅ | `PATCH /artist/me` | `true` = profile listed publicly; `false` = unlisted. New artists start `false` |
| `avatarUrl` | ✅ | Upload flow, [§7](#7-avatar--cover-image--upload-set-remove) | Never set directly — always through an upload |
| `coverUrl` | ✅ | Upload flow, [§7](#7-avatar--cover-image--upload-set-remove) | Same |
| `id`, `publicCode` | ❌ | — | Record identifiers |
| `organizationId` | ❌ | — | Which brand / artist-individual organization the artist belongs to. Set by HitBox |
| `userId` | ❌ | — | The account linked to this profile. Set when the invitation is accepted |
| `invitationId` | ❌ | — | The invitation the profile was created from. Internal |
| `complianceAttestedAt` | ❌ (read-only) | — | Shown as `compliance.attested` / `attestedAt` |
| `complianceAttestedBy` | ❌ (hidden) | — | Which staff member attested. Not shown to the artist |
| `isActive` | ❌ (read-only) | — | Set by HitBox. A deactivated profile can be read but not edited |
| `archivedAt` | ❌ (read-only) | — | Set by HitBox. An archived profile can be read but not edited |
| `createdAt`, `updatedAt` | ❌ (read-only) | — | Timestamps |

**Sending a field you can't edit is refused**, not silently ignored:
`PATCH /artist/me { "organizationId": "…" }` returns `422 VALIDATION_ERROR`
naming the field. That way a screen never believes it changed something it
didn't.

---

## 4. `GET /artist/me` — read my profile

```json
{
  "data": {
    "id": "6f1c…",
    "publicCode": "art0h2k9m4p7x3f8q2n",
    "name": "Kaze",
    "slug": "kaze",
    "bio": "Tokyo-born producer.",
    "genre": "Electronic",
    "avatarUrl": "https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/profile-images/artists/6f1c…/a-77….png",
    "coverUrl": null,
    "isPublic": true,
    "isActive": true,
    "archivedAt": null,
    "editable": true,
    "compliance": { "attested": true, "attestedAt": "2026-09-30T10:12:00.000Z" },
    "organization": { "id": "0b9e…", "name": "Kaze", "type": "ARTIST_INDIVIDUAL" },
    "counts": { "drops": 4, "collections": 1, "followers": 312 },
    "createdAt": "2026-09-01T08:00:00.000Z",
    "updatedAt": "2026-10-12T09:41:00.000Z"
  }
}
```

| Field | Meaning |
|---|---|
| `editable` | `false` when HitBox has archived or deactivated the profile. Disable the edit form when `false` |
| `compliance` | Whether HitBox has attested the artist's compliance, and when |
| `organization` | The organization the artist belongs to — `type` is `ARTIST_INDIVIDUAL` (their own) or `BRAND` (signed to a label) |
| `counts.followers` | Users following this artist |

`404 ARTIST_PROFILE_NOT_FOUND` means the signed-in account isn't linked to
an artist profile. Profiles are created when HitBox invites someone as an
artist, and linked when they accept.

---

## 5. `PATCH /artist/me` — edit name, handle, bio, genre, visibility

Send **only the fields you're changing**; at least one is required.

```json
{
  "name": "Kaze",
  "slug": "kaze-official",
  "bio": "Tokyo-born producer making late-night electronic records.",
  "genre": "electronic",
  "isPublic": true
}
```

| Field | Type | Rules |
|---|---|---|
| `name` | string | 1–120 characters, trimmed |
| `slug` | string | 3–60, `a-z 0-9` and single hyphens, no leading/trailing hyphen. Upper-case is lower-cased for you. `409 ARTIST_SLUG_TAKEN` if another artist has it |
| `bio` | string \| null | Up to 2000 characters. `""` and `null` both clear it |
| `genre` | string \| null | A genre **code** (`HIP_HOP`) or **label** (`Hip-Hop`), any case. Saved as the label. `null` clears it. Anything not on the list → `400 ARTIST_GENRE_INVALID` |
| `isPublic` | boolean | `true`/`false` (the strings `"true"`/`"false"` are accepted too) |

Response `200` — the full updated profile (as in §4).

> Changing `slug` changes your public profile URL. Old links using the
> previous handle stop working.

---

## 6. `GET /artist/genres` — the genre list

```json
{
  "data": [
    { "code": "POP", "label": "Pop" },
    { "code": "HIP_HOP", "label": "Hip-Hop" },
    { "code": "RNB", "label": "R&B" },
    …
  ]
}
```

Show `label` in the dropdown and send either `code` or `label` back. The
full list: Pop, Hip-Hop, R&B, Rock, Alternative, Indie, Electronic, Dance,
Jazz, Blues, Soul, Classical, Country, Folk, Metal, Punk, Reggae, Latin,
Afrobeats, K-Pop, Bollywood, Indian Classical, Devotional, Soundtrack,
Visual Art, Illustration, Street Art, Gaming, Sports, Other.

An artist has **one** genre. The list lives in code
(`ARTIST_GENRES` in `packages/artist/src/self/constants/artist-self.constant.ts`);
adding a genre is one line there, with no database change. A profile created
before this list existed may hold a genre that isn't on it — it is shown as
is, and replaced the next time the artist picks one.

---

## 7. Avatar & cover image — upload, set, remove

The file itself **never passes through the API**. It goes straight from the
browser/app to S3 with a short-lived signed URL. Three steps:

```
1. POST /artist/me/avatar/upload-url   → { assetId, uploadUrl, expiresIn, publicUrl }
2. PUT  <uploadUrl>                    → the raw file bytes, directly to S3 (expires in 5 min)
3. PUT  /artist/me/avatar { assetId }  → the profile now shows the new avatar
```

Replace `avatar` with `cover` for the cover image. The two are independent:
setting one never touches the other.

### Step 1 — `POST /artist/me/avatar/upload-url`

```json
{ "fileName": "me.png", "mimeType": "image/png", "sizeBytes": 482113 }
```

| Field | Rules |
|---|---|
| `fileName` | 1–255 chars. Only the extension is used in the stored name |
| `mimeType` | `image/jpeg`, `image/png`, `image/webp` or `image/gif` |
| `sizeBytes` | The exact file size (`file.size` in a browser). Max **15 MB** |

Response `201`:

```json
{
  "data": {
    "kind": "avatar",
    "assetId": "a-771f…",
    "uploadUrl": "https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/profile-images/artists/6f1c…/a-771f….png?X-Amz-…",
    "expiresIn": 300,
    "publicUrl": "https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/profile-images/artists/6f1c…/a-771f….png"
  }
}
```

Nothing on the profile changes yet.

### Step 2 — upload the file to S3

```http
PUT <uploadUrl>
Content-Type: image/png        ← exactly the mimeType from step 1
<the file bytes>               ← exactly sizeBytes long
```

- The signature is bound to the `Content-Type` **and** the size. A different
  type, or a file of a different length, gets `403 SignatureDoesNotMatch`
  from S3.
- The URL expires after `expiresIn` seconds (5 minutes). Ask for a new one if
  it lapses.
- This call goes to S3, not to the HitBox API — don't send the Clerk token.

### Step 3 — `PUT /artist/me/avatar`

```json
{ "assetId": "a-771f…" }
```

Response `200` — the full profile, with `avatarUrl` now set to the image's
permanent public URL. Render that URL directly; it doesn't expire.

The asset is checked before it's used. It is refused
(`400 ARTIST_IMAGE_INVALID`) if it:

- doesn't exist;
- was not uploaded to **your** profile (you can't use another artist's file);
- is not a profile image;
- has been deleted;
- failed the virus scan, or is still being scanned (where scanning is
  enabled — try again shortly);
- isn't stored in the public profile-images location.

> Call step 3 **only after the S3 upload in step 2 succeeded** (status 200).
> The API can't see inside S3, so setting an asset whose upload failed would
> point the profile at a missing image.

### Removing — `DELETE /artist/me/avatar`

No body. Clears `avatarUrl` and returns the profile. The stored file is kept
(for history), it's just no longer shown. `DELETE /artist/me/cover` does the
same for the cover.

### Recommended sizes

The API accepts any jpeg/png/webp/gif up to 15 MB. For good results:

| Image | Shape | Suggested size |
|---|---|---|
| Avatar | Square, shown cropped to a circle | 800 × 800 px |
| Cover | Wide banner | 1920 × 640 px (3:1) |

Resizing and cropping happen on the client; the server stores what it gets.

---

## 8. Who can call this

| Caller | Result |
|---|---|
| An **artist** (ARTIST role) linked to a profile | ✅ Full access to their own profile |
| An artist whose profile HitBox archived/deactivated | Can read (`editable: false`); every edit → `409 ARTIST_PROFILE_LOCKED` |
| A Brand Admin / Brand Employee | ❌ `403` — they administer artist records at organization level, which doesn't count as "own" |
| A buyer | ❌ `403` |
| HitBox System Admin | Passes the permission check, but has no artist profile of their own → `404 ARTIST_PROFILE_NOT_FOUND`. Admin editing of artist records is a separate surface (not built — §12) |

How it works: the routes require `brand-artist-record:read` (reads) and
`brand-artist-record:update` (writes), checked at **own** scope against the
caller's own user id. The ARTIST role holds both as `…:own`. The check is on
the capability, never the role name, so a custom artist role created through
the Roles screen with those grants works without a code change.

The artist is found by `Artist.userId = <signed-in account>`. The URL never
carries an artist id.

---

## 9. Errors

Standard envelope: `{ "error": { "code", "message", "details" } }`.

| Status | Code | When |
|---|---|---|
| `400` | `ARTIST_GENRE_INVALID` | `genre` not on the list. `details.allowed` lists the codes |
| `400` | `ARTIST_IMAGE_INVALID` | The `assetId` in step 3 failed a check (§7) |
| `400` | `ARTIST_IMAGES_UNAVAILABLE` | This server has no image bucket configured. The rest of the profile still works |
| `400` | `UNSUPPORTED_MIME_TYPE` | Step 1 with a type other than jpeg/png/webp/gif. `details.allowed` lists them |
| `400` | `FILE_TOO_LARGE` | Step 1 with `sizeBytes` over 15 MB |
| `401` | `AUTH_UNAUTHENTICATED` | No or expired session |
| `403` | `AUTHZ_FORBIDDEN` | Not an artist (§8) |
| `404` | `ARTIST_PROFILE_NOT_FOUND` | Your account isn't linked to an artist profile |
| `409` | `ARTIST_SLUG_TAKEN` | Another artist already uses that handle |
| `409` | `ARTIST_PROFILE_LOCKED` | Profile archived or deactivated by HitBox |
| `422` | `VALIDATION_ERROR` | Malformed body, empty `PATCH`, or a field you can't edit |

---

## 10. Where the code lives

The feature sits in `@hitbox/artist`, which owns the `Artist` table. Images
go through `@hitbox/media`, which owns `MediaAsset` and the S3 bucket, via an
injected port — the two modules never import each other.

```
packages/artist/src/self/
  constants/artist-self.constant.ts     ← capabilities, error codes, ARTIST_GENRES, limits
  dto/artist-self.dto.ts                ← request validation (strict — unknown fields refused)
  domain/artist-image-storage.interface.ts   ← IArtistImageStorage port
  repository/artist-self.repository.ts  ← the only Prisma access
  service/artist-self.service.ts        ← rules: own profile only, locked profiles, genre, slug, image checks
  controller/artist-self.controller.ts
packages/artist/src/module.ts           ← createSelfRouter()
packages/media/src/module.ts            ← profileImages: implements the port (PROFILE_IMAGE, owner = artist)
apps/backend/src/bootstrap.ts           ← wires resolveUserId + mediaModule.profileImages
apps/backend/src/routes.ts              ← mounts /artist
packages/artist/tests/artist-self.test.ts
```

- **Storage location:** `profile-images/artists/<artistId>/<assetId>.<ext>` —
  a publicly readable prefix, so the saved URL is permanent.
- **No database migration:** every field already existed on `Artist`.
- **Event:** `artist.profile.updated` with `{ artistId, fields }` after every
  change, for search indexing or cache busting.

---

## 11. Frontend checklist

- [ ] Profile screen loads `GET /artist/me`; if `editable` is `false`, show it read-only with a "contact support" note.
- [ ] Genre dropdown from `GET /artist/genres` (show `label`, send `code`).
- [ ] Handle (`slug`) field: lowercase, live-format as the user types, show `409 ARTIST_SLUG_TAKEN` inline.
- [ ] `PATCH` only the changed fields.
- [ ] Image upload: crop/resize on the client, then upload-url → PUT to S3 with the same `Content-Type` → `PUT /artist/me/{avatar|cover}`. Only call the last step after S3 returns 200.
- [ ] Re-request an upload URL if more than 5 minutes passed.
- [ ] Render `avatarUrl` / `coverUrl` directly; show a placeholder when `null`.
- [ ] Hide the whole "My Artist Profile" area for users without the artist grant (`GET /authz/me` → `brand-artist-record:read:own`).

---

## 12. Not built

| Not built | Note |
|---|---|
| Admin editing of any artist's profile | Staff with `brand-artist-record:manage:global` / Brand Admins (`:organization`) need their own endpoints under `/admin/artists` |
| Public artist page (`GET /artists/:slug`) | The storefront read of a public profile |
| Multiple genres per artist | `Artist.genre` is a single column; multi-genre would need a schema change |
| Social links, website, location | Not columns on `Artist` today |
| Server-side image resizing / thumbnails | The file is stored as uploaded |
| Deleting old image files | Replaced/removed images stay in the bucket |
