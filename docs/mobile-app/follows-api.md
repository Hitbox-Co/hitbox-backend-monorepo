# Follows — API

Following **collectors** and **artists**: the Follow / Following button on a
profile, and the Followers / Following lists.

> **Database migration required.** Following collectors uses a new column,
> `Follow.followedUserId` (migration `20261120100000_follow_collectors`). Until it
> is applied (`pnpm db:migrate`), every `/follows` call fails with 500, and so do
> `GET /users/me`, `GET /users/:id` and `GET /users/handle/:handle`, because their
> stats count followers.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/follows/users/:userId` | required | Follow a collector |
| DELETE | `/follows/users/:userId` | required | Unfollow a collector |
| POST | `/follows/artists/:artistId` | required | Follow an artist |
| DELETE | `/follows/artists/:artistId` | required | Unfollow an artist |
| GET | `/follows/users/:userId/followers` | optional | Collectors following this collector |
| GET | `/follows/users/:userId/following` | optional | Collectors (or, with `?type=artists`, artists) this collector follows |

Base path: `/api/v1/follows`. Code: `packages/social` (the `Follow` table is
social's). The counts shown on a profile come from here, through
[users-api.md](users-api.md) (`stats.followers`, `stats.following`,
`stats.followingArtists`).

---

## Authentication

Follow and unfollow need the Clerk session: `Authorization: Bearer <token>`. You
always act as yourself; there is no way to make someone else follow.

The lists are public. A token is optional and only fills in `isFollowedByYou` on
each row. An invalid token is treated as a guest. See [auth-api.md](auth-api.md).

---

## Shapes

### `FollowResult`: what follow and unfollow return

```jsonc
{
  "following": true,       // your state after the call
  "followerCount": 8       // the target's follower count after the call
}
```

### `FollowUserView`: a collector in a list

```jsonc
{
  "id": "9b1d7e3a-…",
  "handle": "mia.figures",
  "fullName": "Mia Lopez",
  "avatarUrl": "https://img.clerk.com/…",
  "isPrivate": true,               // their profile is private: tapping shows name + stats, no items
  "followedAt": "2026-11-20T10:00:00.000Z",
  "isFollowedByYou": false         // your Follow button; null for guests and on your own row
}
```

### `FollowArtistView`: an artist in a list (`?type=artists`)

```jsonc
{
  "id": "a91e…",
  "name": "Studio Nova",
  "slug": "studio-nova",
  "avatarUrl": "https://…",
  "followedAt": "2026-11-20T10:00:00.000Z"
}
```

---

## Endpoints

### `POST /api/v1/follows/users/:userId`

Follow a collector. There is no body. Response: `{ "data": FollowResult }` with
`following: true`.

It is **idempotent**: following someone you already follow returns 200 with the
same result. Private profiles can be followed like any other. There is no
request or approval step.

### `DELETE /api/v1/follows/users/:userId`

Unfollow. Response: `{ "data": FollowResult }` with `following: false`. Also
idempotent: unfollowing someone you don't follow is fine.

### `POST /api/v1/follows/artists/:artistId` · `DELETE …`

The same for an artist. The artist must have a public profile (public, active,
not archived). Artist ids come from Discover's **Meet the creators**
(`creators[].id`, [discover-api.md](discover-api.md)) and from drop cards
(`artist.id`).

### `GET /api/v1/follows/users/:userId/followers`

| Param | Values | Default |
|---|---|---|
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

```jsonc
{
  "data": [ FollowUserView, … ],   // newest follower first
  "meta": { "page": 1, "limit": 20, "total": 7, "totalPages": 1 }
}
```

### `GET /api/v1/follows/users/:userId/following`

| Param | Values | Default |
|---|---|---|
| `type` | `users` `artists` | `users` |
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

`data` is `FollowUserView[]` for `type=users` and `FollowArtistView[]` for
`type=artists`, newest first, with the same `meta` as above.

For **your own** lists, pass your own id (from `GET /users/me`).

### Errors

| Status | Code | When |
|---|---|---|
| 401 / 403 | `AUTH_…` | Follow/unfollow without a valid session ([README.md](README.md#authentication)) |
| 400 | `SOCIAL_CANNOT_FOLLOW_SELF` | `POST /follows/users/<your own id>` |
| 404 | `SOCIAL_USER_NOT_FOUND` | No such collector, or deactivated/deleted (follow, and both lists) |
| 404 | `SOCIAL_ARTIST_NOT_FOUND` | No such artist, or no public profile (follow) |
| 422 | `VALIDATION_ERROR` | An id is not a uuid, bad `type`/`page`/`limit` |

---

## How it works

### Profile screen, end to end

```text
GET /users/:id                          → name, avatar, isPrivate, stats, viewer.isFollowing
   ├─ Follow button:   viewer.isFollowing ? DELETE : POST  /follows/users/:id
   │                   → update the button and stats.followers from followerCount
   ├─ "7 Followers":   GET /follows/users/:id/followers
   ├─ "2 Following":   GET /follows/users/:id/following
   └─ Items tab:       isPrivate ? "This profile is private"
                                 : GET /collections/user/:id
```

Follow and unfollow are idempotent, so the button can change immediately and the
request can be sent in the background.

### Privacy

A private profile hides **what its owner holds**, not who they are or who they
follow:

- anyone can follow a private profile;
- private collectors appear in followers and following lists with their name and
  avatar (`isPrivate: true`);
- their follower and following lists are visible.

Only their items are hidden ([users-api.md](users-api.md#public-and-private-profiles)).

### What is counted

Deactivated and deleted accounts drop out of every list and count, and artists
drop out when they stop being public. The rows are kept, so they come back if the
account or artist is restored.

The database enforces one follow per pair, that a follow points at exactly one
target (a collector, an artist or an organization), and that nobody can follow
themselves.

---

## Known limitations

- **No follow-state on artist cards.** Discover's creators and drop cards don't
  say whether you follow that artist. Show the button from your own
  `GET /follows/users/<me>/following?type=artists`.
- **No public artist page.** Buyers can follow an artist, but there is no
  buyer-facing artist profile endpoint yet. Artist pages are admin and self-service only.
- **Organizations cannot be followed through the API.** The table supports it,
  but there is no buyer-facing organization surface.
- **No notifications.** Nobody is told when they gain a follower, and following an
  artist does not yet alert you to their new drops.
- **No blocking and no follow requests.** By design, a private profile is followable
  without approval.
