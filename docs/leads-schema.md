# Database schema — HitBox Website (Phase 1: lead capture)

Source of truth for `packages/leads/prisma/schema.prisma`. **Change both together.** This is a
**separate domain** from the mobile platform documented in
[hitbox-architecture.md](hitbox-architecture.md) — same server process as `apps/backend`, own
route namespace (`/app/web/v1/*`), separate package (`@hitbox/leads`), separate database. See
[repo-structure.md](repo-structure.md) for how the two domains share the process and why.

Phase 1 is lead capture only: **four public forms, and nothing else.** No admin dashboard, no
notes/activity/export audit trail, no admin auth/RBAC — those were deliberately cut from the
initial build (they had zero consumers) and will be added back only when an actual admin panel
needs them; see [repo-structure.md](repo-structure.md) §"Adding an admin panel." No users,
collectibles, collections, orders, scans or claims either — those live in the mobile platform's
own package set, not here.

**Field naming.** Prisma models use camelCase; Postgres columns are snake_case via `@map`. The
website's form inputs use their own names, which do **not** all match the schema — the mapping is
implemented in `packages/leads/src/service/*.ts`, one service per form, and documented per-model
below.

---

## 1. Where the data comes from

Four endpoints, served by the same backend process as the mobile platform, under the
`/app/web/v1` route prefix (see [repo-structure.md](repo-structure.md)):

| Endpoint | Form component | Model | Service |
| --- | --- | --- | --- |
| `POST /app/web/v1/waitlist` | `WaitlistForm` (3 variants) | `WaitlistSubscriber` | `WaitlistService` |
| `POST /app/web/v1/contact` | `ContactForm` | `ContactSubmission` | `ContactService` |
| `POST /app/web/v1/artist-inquiry` | `ArtistInquiryForm` | `ArtistLead` | `ArtistLeadService` |
| `POST /app/web/v1/business-inquiry` | `BusinessPartnerForm` | `PartnerLead` | `PartnerLeadService` |

Full request/response contracts, including every field name and validation rule, are in
[web-api-integration.md](web-api-integration.md) — that is the document to hand to whoever builds
the actual form components.

---

## 2. Decisions made resolving the original schema draft

The original schema draft was written for the forms Phase 1 *will* have; the forms that exist
today are narrower. Six categories of mismatch were identified and are resolved as follows.
Anything not resolved is listed in §6, exactly as originally flagged.

### 2.1 Non-null columns with no source in any current form

| Model | Field | Resolution |
| --- | --- | --- |
| all four | `consentVersion` | Non-null, kept. Stamped server-side from `CURRENT_CONSENT_VERSION` (`packages/leads/src/constants/leads.constant.ts`) on every insert. Bump that one constant when the privacy policy text changes — it is a code constant, not a DB row, specifically so a policy change is a one-line PR with a clear diff/blame trail. |
| all four | `consentTimestamp` | Non-null, kept. Stamped as `new Date()` at request time in the controller (`buildServerContext`), not a DB default — same value is used for both columns in one insert. |
| `ArtistLead` | `primaryCategory` | **Relaxed to nullable.** Not on the form; forms live in a separate repo this backend doesn't control. Tighten back to non-null via a migration once the form asks the question. |
| `ArtistLead` | `contactRole` | **Relaxed to nullable.** Same reasoning. |
| `ArtistLead` | `authorizedConfirmation` | **Relaxed to nullable `Boolean?`.** This is a legal/rights-authorization flag — defaulting it to `true` or `false` would misrepresent a question that was never asked. `null` is the only honest value until the form has a real checkbox. Do not silently default this one. |
| `PartnerLead` | `jobTitle` | **Relaxed to nullable**, matching the form's actual (optional) behavior. |
| `PartnerLead` | `companyWebsite` | **Relaxed to nullable**, same reasoning. |

**The contact form has no consent checkbox at all**, yet `ContactSubmission.consentVersion` is
non-null. Resolved as: it records the policy revision in force at submission time, not an
affirmative tick. This is now the documented, intentional meaning of that column on this model
specifically — the other three models' consent columns represent an actual checkbox tick.

### 2.2 Fields the forms collect that the original schema had nowhere to put

| Form field | Form | Resolution |
| --- | --- | --- |
| `additional` | Artist inquiry | Given its own column: `ArtistLead.additionalNotes` |
| `additional` | Partner inquiry | Given its own column: `PartnerLead.additionalNotes` |
| `companyDescription` | Partner inquiry | Given its own column: `PartnerLead.companyDescription`, kept **distinct** from `relevantCapabilities` (a different question — conflating them was rejected) |

Every one of the four submission models also has `rawPayload Json?`, storing the **unvalidated**
request body exactly as received — captured in the controller before Zod runs, not the validated
DTO (Zod silently drops keys it doesn't recognize, which would defeat the whole point of this
column). This is the actual hedge against future unmapped fields: if the site adds a field before
this schema is updated, it survives in `rawPayload`, not just what's listed in this document.

### 2.3 Type mismatches

| Field | Schema | Form sends | Resolution |
| --- | --- | --- | --- |
| `ArtistLead.collectibleFormats` | `String[]` | `collectibleType`, a single `<select>` value | Kept as `String[]`; the service wraps the single value into a one-element array. |
| `ArtistLead.primarySocialUrl` / `additionalSocialUrls` | one URL + array | `socials`, a free-text multi-line textarea | Parsed by `packages/leads/src/utils/social-links.ts` — splits on newlines/commas, extracts anything URL-shaped, first result → `primarySocialUrl`, rest → `additionalSocialUrls`. This is a **best-effort heuristic**, not a guarantee; the original raw text is always preserved verbatim in `rawPayload` regardless of parse success. |
| `WaitlistSubscriber.interests` | `String[]` | array, string, or absent (see below) | Normalized by `packages/leads/src/utils/normalize-array.ts`. |

**The `interests` trap**, resolved exactly as specified: `formData.getAll(key)` gives an array for
2+ ticks, a bare string for exactly one, and omits the key for none.
`normalizeToStringArray` handles all three. On a **repeat** waitlist signup (see §6.2), an absent
`interests` key is passed through as `undefined`, not `[]` — this matters: a footer-variant
resignup must not silently erase interests recorded by an earlier full-page signup.

### 2.4 `country` on the waitlist stays nullable

Confirmed nullable, unchanged. `WaitlistForm`'s footer and compact variants never send it; only
the full page does. Do not "fix" this to non-null on the strength of the form's HTML
`required` attribute — that attribute only applies to the full-page variant. This is also why
`sourcePage` matters: it's the only way to tell a footer signup from a full-page one after the
fact.

**Also changed:** `country` was widened from an assumed `VarChar(2)` (ISO alpha-2 code) to
`VarChar(100)` on all three models that have it. The actual `<select>` values the live form sends
were not available to confirm the format — guessing wrong on a length-constrained column risks
hard-rejecting every real submission. Tighten this once the frontend's actual values are
confirmed.

### 2.5 Admin status enums

`LeadStatus` (`new`, `reviewing`, `qualified`, `contacted`, `meeting_scheduled`, `in_discussion`,
`on_hold`, `closed_won`, `closed_lost`, `spam`) and `WaitlistStatus`
(`pending`/`confirmed`/`unsubscribed`/`suppressed`) are implemented exactly as originally
specified. **`LeadPriority`'s full value set was not given** beyond the default `unreviewed` — a
standard 5-value set (`unreviewed`, `low`, `medium`, `high`, `urgent`) was chosen as a reasonable
default; it is a low-consequence, easily-renamed-later choice, not a structural one.

No admin dashboard exists yet to consume any of this — see
[repo-structure.md](repo-structure.md) §"Adding the next website" for where one would plug in.

### 2.6 Attribution / request context

Implemented as specified: `utmSource`/`utmMedium`/`utmCampaign`/`utmContent`/`utmTerm` and
`sourcePage` are accepted as optional request fields (the frontend doesn't send them yet — nothing
changes on this side once it does). `ipHash` is a **salted SHA-256** hash (`IP_HASH_SALT` env var,
soft-fails to a dev-only fallback with a warning if unset — see §5) — the raw address is never
persisted. `userAgentSummary` is a coarse `"Browser / OS"` string
(`packages/leads/src/utils/user-agent-summary.ts`), not the full UA string.

**Not yet done, flagged as originally specified:** the privacy policy does not yet mention
`ipHash`/`userAgentSummary` collection. This must happen before these fields start being
populated in a real deployment — legal/product action, not a code change.

---

## 3. Models

See `packages/leads/prisma/schema.prisma` for the authoritative field list — every field there
carries an inline comment explaining any deviation from the original draft. Model-to-endpoint
mapping is in §1; full request/response JSON shapes are in
[web-api-integration.md](web-api-integration.md).

Four models, one per public form: `WaitlistSubscriber`, `ContactSubmission`, `ArtistLead`,
`PartnerLead`. That's the entire schema — the original draft's four admin-side models
(`LeadNote`, `LeadActivity`, `AdminProfile`, `ExportLog`, plus their supporting `LeadType` /
`AdminRole` / `ExportResource` enums) were **cut entirely**: nothing reads or writes them without
an admin app, and none exists yet. `LeadStatus`/`LeadPriority`/`WaitlistStatus` stay — those are
plain columns on the four models above with sensible defaults, not admin-app scaffolding, so they
cost nothing to keep. Re-add the four cut models (they were fully designed — see git history on
this file for the original field definitions) when an admin dashboard is actually being built;
don't recreate them speculatively before then.

---

## 4. Indexes

Implemented: `createdAt` and the relevant status column (`status` / `leadStatus`) on all four
submission tables, `status` on `WaitlistSubscriber`. `assignedUserId` was **not** indexed yet —
the original doc hedged this on "if the dashboard grows a 'my leads' view," which doesn't exist;
add it when it does.

---

## 5. Environment

This is a **separate database** from the mobile platform — see
[repo-structure.md](repo-structure.md) for why. New variables (all in the one shared
`packages/shared/config/env.ts`, all optional there — `@hitbox/leads` is the module that actually
needs them):

| Variable | Purpose |
| --- | --- |
| `LEADS_DATABASE_URL` | Postgres connection string (pooled) for this database |
| `LEADS_DIRECT_URL` | Unpooled connection string — required for migrations |
| `IP_HASH_SALT` | Salt for `ipHash`. Not a security-critical secret — soft-fails to a dev-only fallback with a startup warning if unset, does not block boot |

No separate port or CORS variable exists for this domain — it runs on `apps/backend`'s own `PORT`
and shares its CORS policy (see [repo-structure.md](repo-structure.md)).

**Not yet provisioned:** a real Neon (or other Postgres) project for `LEADS_DATABASE_URL` /
`LEADS_DIRECT_URL`. Everything on this side — schema, generated client, full module, live HTTP
validation — has been verified without one (Prisma Client connects lazily; validation happens
before any query runs). The one remaining step is running `pnpm --filter @hitbox/leads db:migrate`
once real credentials exist.

---

## 6. Open decisions

Carried over from the original draft, **not** resolved by this implementation — these need a
product/ops decision, not just a schema change:

1. **Duplicate waitlist emails — RESOLVED as upsert.** `emailNormalized` is unique; a repeat
   signup refreshes the existing row (name, interests, etc.) rather than rejecting. This matches
   how most production waitlists behave and avoids surfacing a raw constraint error to a visitor.
   Switch `WaitlistRepository.upsertByEmail` to reject-with-a-friendly-message instead if product
   wants that — it's a one-method change.
2. **Unsubscribe** — the consent copy promises it; no token, route, or `unsubscribedAt`-setting
   flow exists yet. Columns are ready.
3. **Double opt-in** — `confirmationTokenHash`, `confirmationExpiresAt`, `confirmedAt` exist;
   `status` defaults to `pending` and will sit there forever without a send/verify flow.
4. **Spam** — still no CAPTCHA or honeypot on any endpoint. A tighter rate limit (20 req/min per
   IP, vs. the mobile API's 100) is now in place as a first, cheap control — see
   [web-api-integration.md](web-api-integration.md) — but this is not a substitute for real bot
   defense on a public, unauthenticated form.
5. **Privacy policy copy** — must be updated to mention `ipHash`/`userAgentSummary` collection
   before a real deployment starts populating them.
6. **Admin dashboard** — doesn't exist, and its supporting tables (`LeadNote`, `LeadActivity`,
   `AdminProfile`, `ExportLog`) were removed from the schema rather than left unused (see §3).
   `LeadStatus`/`LeadPriority` triage and waitlist status management have no UI either. See
   [repo-structure.md](repo-structure.md) §"Adding the next website" for how to bring the admin
   tables back when this is actually being built.
