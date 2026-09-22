# Creating an admin user from the dashboard

How a HitBox system administrator brings a colleague onto the platform with a
role, and why it is built the way it is.

Companion to [authorization-architecture.md](authorization-architecture.md),
which covers roles, permissions and the engine that evaluates them. This
document covers only the one flow that was missing from it: **getting a person
into the system in the first place.**

---

## 1. The gap this closes

Role *assignment* already existed — `POST /admin/authz/users/:userId/roles` has
been there since the authorization module was built. What did not exist was any
way to produce the `:userId`.

A `User` row comes into being in exactly one way: Clerk fires `user.created`,
the auth module turns it into a `USER_REGISTERED` event, and the users module
writes the row. Clerk fires that when somebody **signs up through the consumer
app**.

So the old procedure for making a colleague an administrator was:

1. Ask them to download the mobile app and register as a *buyer*.
2. Wait.
3. Find them on the Team screen.
4. Grant them a role.

A system administrator could not provision anyone from the dashboard at all.
Steps 1–2 are also where it quietly went wrong in practice: the colleague
registers with a personal address, and the admin then grants staff privileges to
an account nobody controls the mailbox of.

---

## 2. What was built

```text
POST /api/v1/admin/authz/invitations
GET  /api/v1/admin/authz/invitations
POST /api/v1/admin/authz/invitations/:invitationId/revoke
```

One new table, `StaffInvitation`, and one new event,
`users.account.provisioned`. Full API detail in 6.

### The happy path, end to end

```text
  Dashboard                                         Clerk            Colleague
      │                                               │                   │
      │ POST /admin/authz/invitations                 │                   │
      │  { email, roleId, scopeType?, organizationId? }                   │
      ▼                                               │                   │
  ┌─────────────────────────────────────────┐         │                   │
  │ 1. role exists and is active?           │         │                   │
  │ 2. may THIS admin grant THIS role?      │  ← the escalation check     │
  │ 3. no open invitation for this already? │         │                   │
  └─────────────────────────────────────────┘         │                   │
      │                                               │                   │
      ▼                                               │                   │
  StaffInvitation: PENDING   ← written BEFORE the provider is called      │
      │                                               │                   │
      ├── address already has an account? ────────────┼── yes ──┐         │
      │                                               │         ▼         │
      │                                               │   grant the role  │
      │                                               │   invitation:     │
      │                                               │   ACCEPTED        │
      │                                               │   → 201 ROLE_ASSIGNED
      │ no                                            │                   │
      ▼                                               │                   │
  identity.sendInvitation(email) ──────────────────►  │  ── email ──────► │
      │                                               │                   │
      ▼                                               │            sets their own
  StaffInvitation: SENT                               │            password/passkey
  → 201 INVITATION_SENT                               │                   │
                                                      │                   │
                                       user.created ◄─┴───────────────────┘
                                            │
                                            ▼
                             auth: USER_REGISTERED event
                                            │
                                            ▼
                             users: writes the User row
                                            │
                                            ▼
                             users: users.account.provisioned   ← after the write
                                            │
                                            ▼
                      access-control: claimFor({ userId, email })
                                            │
                                            ▼
                       RoleAssignment created · invitation ACCEPTED
```

---

## 3. The approach, and the four decisions behind it

### 3.1 Invite, don't create

Clerk's backend API can create an account outright with a password supplied by
the caller. That was rejected. It would mean HitBox generating, transmitting and
briefly holding a colleague's credential, and then having to get it to them over
some channel — email, Slack, a phone call — each of which is a place a password
now lives.

The invitation flow emails a one-time link and the person sets their own
password or passkey. **No HitBox system ever sees it.**

The cost is real and is the reason the rest of this design exists: the account
does not exist at the moment the administrator clicks the button, so the role
cannot be granted then either.

### 3.2 The role lives in our database, not in Clerk

Clerk lets you attach arbitrary `public_metadata` to an invitation. Putting
`{ roleId }` there and reading it back in the webhook would have been
meaningfully less code — no table, no event, no claim step.

It was rejected because authorization intent would then live **outside this
database**:

- invisible to the audit trail and to any access review;
- unreadable by the permission engine, which resolves grants from `RoleAssignment`;
- editable by anyone with access to the Clerk dashboard, which is a different
  and usually wider set of people than those holding `employee-role-mgmt:assign`;
- and unrevocable through our own API.

The permission catalog is authoritative here, so the invitation is too. Clerk is
told exactly one thing: *"email this address a sign-up link."* The
`IIdentityInvitations` port has no parameter for a role, which makes that
structural rather than a convention someone has to remember.

### 3.3 The claim is driven by a users event, not the auth event

This is the subtlest decision and the one most likely to be "simplified" later
by someone who has not read this paragraph.

The obvious wiring is: access-control subscribes to `USER_REGISTERED` (the auth
event) and grants the role. **That races.** `InProcessEventBus.publish` fires
every subscriber via `setImmediate`, independently, awaiting none of them:

```ts
for (const handler of subscribers) {
    setImmediate(() => { Promise.resolve().then(() => handler(payload)).catch(…); });
}
```

So the users module's row insert and access-control's role assignment would run
concurrently, and `RoleAssignment.userId` has a foreign key to `User.id`. The
assignment would fail intermittently — passing in dev, failing under load, and
leaving a person signed in with no privileges and no error anyone sees.

The fix is a deterministic signal. `UserService.syncFromClerk` publishes
`users.account.provisioned` **after** the upsert has committed, and
access-control subscribes to that. The users module owns the table, so
announcing "this row now exists" is squarely its job.

A test pins the ordering, because it is the kind of property that survives
review and dies in a refactor:

```ts
const upsertAt = repo.upsertFromClerk.mock.invocationCallOrder[0];
const publishAt = bus.publish.mock.invocationCallOrder[0];
expect(upsertAt).toBeLessThan(publishAt);
```

### 3.4 Write the row before calling the provider

`StaffInvitation` is created `PENDING` and only then is Clerk called; success
moves it to `SENT`, failure to `FAILED` with the provider's message.

Written the other way round, a crash between the send and the insert would email
somebody a sign-up link with no role waiting for them and no record that it ever
happened. This way the worst case is a `PENDING` row an operator can see and
retry.

A failed invitation is **not** rolled back into silence for the same reason: an
invitation that could not be sent is something an administrator has to act on.

---

## 4. The two paths, and why the branch is not an edge case

**The address already has a HitBox account.** Common, for two reasons: staff buy
things too, and Clerk *refuses* to invite an address it already knows. So the
service checks the local user directory first. If somebody holds the address,
there is nothing to invite — the role is granted immediately and an `ACCEPTED`
invitation row is written anyway, so the audit trail reads the same whichever
path was taken. The response says `outcome: "ROLE_ASSIGNED"`.

**The address is unknown.** The invitation is sent and the role is granted later,
on acceptance. The response says `outcome: "INVITATION_SENT"`.

The dashboard must show these differently — "Priya now has the Order Manager
role" versus "We've emailed priya@… ; she'll have the role once she accepts" —
which is why the outcome is in the response body rather than inferred.

An archived (offboarded) user does **not** count as holding their address, so
re-inviting a returning colleague takes the invitation path rather than silently
granting a role to a tombstoned row.

---

## 5. Who can do this — and the escalation check

The invitation routes are gated on **`employee-role-mgmt:assign`** — the same
capability that gates granting a role directly. That is deliberate: an
invitation *is* a role assignment that happens later, and making the deferred
door weaker than the immediate one would undo the control entirely.

Scope is handled exactly as the direct route handles it: the guard's context
resolver reads `organizationId` from the body, so an organization-scoped
administrator (Brand Admin) can invite into their own organization and a
platform-wide invitation needs a grant that reaches beyond one organization.

### The check the guard cannot make

A capability check answers "may this person assign roles?" It cannot answer
"**may this person assign *this* role?**" — it never sees which permissions the
role carries.

Without that second question, the weakest holder of `employee-role-mgmt:assign`
could invite a fresh address to `HITBOX_SYSTEM_ADMIN`, accept the invitation
themselves, and sign in with more power than they started with. Two API calls.

So `assertCanGrantRole` (`domain/grantable-roles.ts`) enforces: **you cannot
grant a permission you do not hold.** It compares *permission sets*, never role
names or seniority — there is no role hierarchy in this system and inventing one
here would contradict 15 of the architecture.

The rule has three clauses, and the second two exist because the strict version
produced false negatives on the real catalog:

| Clause | Example | Why |
| --- | --- | --- |
| Hold it, at a scope at least as wide | `order:read:global` covers `order:read:organization` | The base rule |
| **Administer it, delegate narrower** — `manage` at a *strictly wider* scope covers any action | `release-approval:manage:global` covers `release-approval:approve:organization` | `HITBOX_SYSTEM_ADMIN` administers the release queue platform-wide but deliberately does not approve releases — that is the brand's job. Without this it could not grant `BRAND_ADMIN`, which is most of what it exists to do. |
| **Own-scoped permissions are always grantable** | anyone can grant `my-collections:manage:own` | A SELF-scoped permission acts only on the holder's own records, so it widens nobody's reach. Without this, `HITBOX_SYSTEM_ADMIN` could not grant the ordinary buyer role — it holds `my-collections:read:global` and has no collection of its own to organise. |

"Strictly wider" in clause two is what stops it becoming a hole:
`payment-royalty:manage:global` does **not** cover
`payment-royalty:override:global`. Delegating downwards is administration;
acquiring a sibling power at your own level is escalation.

A test asserts every role in the catalog is grantable by `HITBOX_SYSTEM_ADMIN` —
if that fails, a role has been defined carrying a permission the highest business
role lacks, making it ungrantable by anyone through the API.

### This was also applied to the existing route

`POST /admin/authz/users/:userId/roles` had no escalation check. Guarding only
the new invitation route would have been security theatre — an attacker would
simply use the older one. Both now pass the granter's own permissions into
`RoleAssignmentService.assign()`.

**Behaviour change to be aware of:** an administrator who could previously assign
a role carrying permissions they lack will now get a 403 naming the permissions
they are short of. On the shipped catalog no legitimate case is affected (the
test above proves it for the whole business domain), but a custom role defined
through the Roles screen could hit it.

### Separation of duties, and what is *not* enforced

The escalation check runs when the **invitation is created**, which is where the
decision is taken. It does not re-run at claim time, because at that point the
relevant question would be "is the inviter still an administrator?" — and
failing a colleague's first sign-in because the person who invited them has since
changed jobs is the wrong behaviour.

The residual risk is bounded by two things: invitations expire (72 hours by
default, `ADMIN_INVITATION_TTL_HOURS`), and any administrator can revoke a
pending invitation. If you want a stricter posture — invitations auto-revoked
when the inviter's grants change — that is a deliberate product decision and is
not built.

---

## 6. API reference

Base path `/api/v1/admin/authz`. All routes require authentication.

### `POST /invitations` — invite someone to hold a role

**Capability:** `employee-role-mgmt:assign`, scoped to the target organization.

```json
{
  "email": "priya@hitbox.com",
  "roleId": "e2b1…",
  "scopeType": "GLOBAL",
  "organizationId": null
}
```

Inviting an **artist** takes two more optional fields, used only when the role
makes them one (see §6a):

```json
{
  "email": "kaze@studio.io",
  "roleId": "<the ARTIST role id>",
  "organizationId": "f3bb6065-…",
  "artistName": "Kaze",
  "artistGenre": "street"
}
```

`scopeType` and `organizationId` are both optional. Omitted, the role's natural
scope is used — `brand_artist` roles are organization-scoped, `end_user` roles
are own-scoped, everything else is global — so the dashboard does not have to
know that `BRAND_ADMIN` is org-scoped and `HITBOX_SUPPORT` is not. An
org-scoped role without an `organizationId` is a 400.

**201**, and the outcome tells the dashboard what to say:

```json
{
  "data": {
    "outcome": "INVITATION_SENT",
    "assignmentId": null,
    "invitation": {
      "id": "…", "email": "priya@hitbox.com",
      "roleId": "e2b1…", "roleName": "HITBOX_ORDER_MANAGER",
      "roleDisplayName": "HitBox Order Manager",
      "scopeType": "GLOBAL", "organizationId": null,
      "status": "SENT",
      "invitedById": "…", "invitedAt": "2026-09-18T09:14:00.000Z",
      "expiresAt": "2026-09-21T09:14:00.000Z",
      "acceptedAt": null, "acceptedUserId": null, "assignmentId": null,
      "revokedAt": null, "revokeReason": null, "providerError": null
    }
  }
}
```

`outcome` is `"ROLE_ASSIGNED"` when the address already had an account; then
`assignmentId` is set and `status` is `ACCEPTED`.

| Failure | Status | Meaning |
| --- | --- | --- |
| `AUTHZ_ROLE_NOT_FOUND` | 404 / 400 | No such role, or it is deactivated |
| `AUTHZ_FORBIDDEN` | 403 | The role carries permissions you do not hold — the message names them |
| `AUTHZ_MISSING_ORG_SCOPE` | 400 | Org-scoped role with no `organizationId` |
| `AUTHZ_ASSIGNMENT_EXISTS` | 409 | An open invitation for this exact grant already exists |
| `AUTHZ_FORBIDDEN` | 400 | The provider refused to send it; `details.invitationId` points at the `FAILED` row |

### Inviting an artist also creates their `Artist` record

See §6a below — the profile exists as soon as the invitation is sent, so the
artist can be picked on the drop form before they have signed up.

### `GET /invitations` — list them

**Capability:** `employee-role-mgmt:read`.

Query: `page`, `limit` (max 100), `status`, `email`, `roleId`.

An organization-scoped administrator sees invitations into their own
organizations. Global invitations (`organizationId: null`) are deliberately
excluded from their view — who is being made a *platform* administrator is not a
brand's business.

### `POST /invitations/:invitationId/revoke` — withdraw one

**Capability:** `employee-role-mgmt:delete` — withdrawing an invitation is
revoking a grant that has not landed yet, so it takes the delete capability
rather than assign.

```json
{ "reason": "Sent to the wrong address" }
```

The local row is revoked **first**, the provider second. This database decides
whether a role is granted, so a provider call that fails must not leave a
claimable invitation behind; a provider revoke that fails is logged and the link
may still work, but accepting it then creates an ordinary account with no role —
the safe failure.

An already-`ACCEPTED` invitation is a 409: revoke the role assignment instead
(`DELETE /admin/authz/users/:userId/roles/:roleId`).

---

## 6a. Inviting an artist creates their profile

Inviting somebody as an artist writes an `Artist` row immediately. The drop
form's artist picker (`GET /admin/artists`) lists them straight away, and a
drop can be filed against them **before they have an account**.

### The two events

```
POST /admin/authz/invitations
        │
        ├─ access-control.staff.invited ──────────► Artist row created
        │                                           (userId null, isPublic false)
        │
   … the person signs up, days later …
        │
        └─ access-control.staff.invitation-accepted ► Artist.userId filled in
```

Both are published on the path where the address **already had an account**
too, one after the other — so "invited" means one event regardless of which
branch ran, and the row is created already linked.

### What the profile looks like

| Field | Value at invite time | Why |
| --- | --- | --- |
| `name` | `artistName`, else derived from the email | `jane.doe@label.com` → "Jane Doe" |
| `slug` | slugified name, deduped | unique index; collisions get a short random suffix |
| `genre` | `artistGenre`, else null | |
| `organizationId` | the invitation's scope | an org-scoped artist belongs to that brand |
| `userId` | **null** until they accept | they have no account yet |
| `invitationId` | the invitation | the only thing connecting profile to person |
| `isActive` | `true` | a drop can be filed against them immediately |
| `isPublic` | **`false`** | no bio, no avatar, an unverified name — not storefront-ready |

**Supply `artistName` whenever you know it.** The email fallback is a guess,
and the guess ends up printed on a product page. An operator who sees "Jane
Doe" in the picker knows to correct it; `jane.doe@label.com` reads like a bug.

### Which roles count as artists — and why it is not the role name

The rule reads **capabilities**, never `roleName === 'ARTIST'`:

> A role makes someone an artist when it carries `brand-artist-record` at
> **`own`** scope — "you may read and update *your own* artist record", which
> is only true of somebody who has one.

A Brand Admin holds the same resource at `:organization`: they administer other
people's artist records without being an artist. That distinction is the whole
rule. In the seeded catalog it matches `ARTIST` and nothing else, and a future
`GUEST_ARTIST` defined through the Roles screen gets a profile with no code
change — where a role-name check would silently stop working and the artist
would simply never appear in the picker.

Asserted against the seeded catalog in
`packages/artist/tests/artist-provisioning.test.ts`.

### Idempotency

`Artist.invitationId` is unique, so a redelivered event creates nothing. This
matters today, not just in theory: the in-process bus has no delivery
guarantees, and `ROLE_ASSIGNED` is currently published twice on the
already-has-an-account path.

Re-inviting an address that already has a profile **adopts the existing one**
rather than creating a second. One person is one artist; a duplicate would
split their drops across two records.

### Failure behaviour

A provisioning failure is logged and swallowed — it never fails the invitation.
An invitation that was genuinely sent must not report an error because the
artist table was unhappy. If the profile is missing when the person later
accepts, it is created then, from the acceptance event.

Nothing is provisioned when the identity provider **refuses** to send the
invitation: that path writes a `FAILED` row and publishes no event.

### Not built

- **No backfill.** Artists invited before this shipped have no profile. They
  get one if they accept (the acceptance handler creates it late); an artist
  who accepted *already* needs one created by hand.
- **Revoking an invitation does not remove the profile.** It stays, unclaimed
  and inert, for an operator to archive. Deleting it would be wrong once a drop
  references it.
- **No admin "create artist" screen.** Invitation is currently the only route
  that writes an `Artist` row.

---

## 7. Operating it

### Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `ADMIN_INVITATION_REDIRECT_URL` | Clerk instance default | Where Clerk sends someone after they accept — the dashboard's sign-up completion route |
| `ADMIN_INVITATION_TTL_HOURS` | `72` | How long an invitation stays claimable. Short on purpose: an invitation is a standing offer of privilege, and one sitting unused for a fortnight is more likely a stale mailbox than a busy colleague |

With no Clerk secret configured the module still mounts these routes and the
already-has-an-account path still works; only the email path refuses, with a
clear message rather than silently going nowhere.

### The expiry sweep

`accessControlModule.invitations.expireStale()` moves claimable invitations past
`expiresAt` to `EXPIRED`. Idempotent; call it from the scheduler. It is also
applied lazily at claim time, so a late acceptance is never honoured even if the
sweep has not run.

### The first administrator

This flow needs an existing administrator to run it, so it cannot bootstrap
itself. The first `HITBOX_SYSTEM_ADMIN` on a fresh environment is still seeded —
`pnpm db:seed:authz` and `pnpm db:link-admin`. After that, every subsequent
administrator should come through this API, because it leaves a trail and the
seed script does not.

### Migration

**Applied** on 2026-09-18, in `20260918000000_tax_invoicing_and_staff_invitations` (shared with
the tax module's tables — both were pending together).

```bash
pnpm db:merge && pnpm db:validate
pnpm --filter @hitbox/database db:deploy
```

`StaffInvitation` is one new table plus the `StaffInvitationStatus` enum, its
five foreign keys and four indexes. No existing table is modified: the
back-relations on `User`, `Role` and `Organization` are relation fields and add
no columns.

Note on tooling: `pnpm db:migrate` runs `prisma migrate dev`, which prompts for
a migration name and so needs an interactive terminal. In a non-interactive
shell, author the folder from `prisma migrate diff --from-url … --script` and
apply it with `db:deploy`, which is non-interactive and is what a deployment
runs anyway.

---

## 8. What is not built

- **No resend.** Revoke and re-invite. A resend endpoint that reused the row
  would need to decide whether the clock restarts, and "revoke, then invite
  again" answers that unambiguously with endpoints that already exist.
- **No bulk invite.** One address per call.
- **No notification to the invited person from HitBox** — Clerk sends the only
  email. A branded "welcome to the team" message belongs in
  `@hitbox/notifications` and would subscribe to the invitation events.
- **No auto-revocation** when the inviter's own grants are withdrawn — see 5.
- **No UI.** This is the API the dashboard calls.
