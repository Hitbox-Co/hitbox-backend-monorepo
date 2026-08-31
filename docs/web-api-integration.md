# HitBox Website API — Integration Guide

For whoever builds/maintains the hitboxcollectibles.com frontend. These four endpoints run on the
**same server** as the mobile app backend, under a distinct route prefix — different auth model
(none — these are public forms) and a different, tighter rate limit than the mobile API, but one
host, one port. See [repo-structure.md](repo-structure.md) for how the two domains share the
process, and [leads-schema.md](leads-schema.md) for the underlying database design.

---

## Base URL

`http://localhost:8000` in local dev (port from `PORT` — the same server the mobile API runs on).
In production, whatever host the backend is deployed to.

**All four routes are namespaced under `/app/web/v1`** — e.g. `POST /app/web/v1/waitlist`, not
`POST /waitlist`. This distinguishes them from the mobile platform's own `/api/v1/*` routes on the
same server.

## Authentication

None. All four endpoints are public and unauthenticated by design — they are marketing lead
capture forms.

## CORS

Whatever the backend's global CORS policy is — this API does not have its own separate CORS
configuration. See `apps/backend/src/app.ts` for the current setting.

## Rate limiting

**20 requests per 60 seconds, per client IP**, shared across all four endpoints (i.e. it's one
budget, not 20 per endpoint) — noticeably tighter than the mobile API's 100/min, because these are
unauthenticated public forms with no CAPTCHA yet (see [leads-schema.md](leads-schema.md) §6.4).
Exceeding it returns:

```json
// 429
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests, please try again later" } }
```

Standard `RateLimit-*` response headers are included on every response (see the mobile API docs'
rate-limiting section for the exact header format — identical mechanism, different budget).

## Response envelope

```jsonc
// success (all four endpoints return 201 on success)
{ "data": { "id": "…" } }              // waitlist also includes "status"

// error — ALWAYS this shape
{ "error": { "code": "STRING_CODE", "message": "Human readable", "details": … } }
```

## Validation errors

**422**, with field-level detail — `path` matches the request body field name exactly (the form's
own name, not the internal DB column name):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [ { "path": "email", "message": "Invalid email" } ]
  }
}
```

## Attribution fields (optional, on every endpoint)

Not read/sent anywhere on the site today, but accepted on all four endpoints so no API change is
needed once they are. Add these as hidden form inputs, populated from the query string on landing
and persisted for the session:

| Field | Notes |
| --- | --- |
| `sourcePage` | The page path the form was submitted from. More reliable than the `Referer` header (which is used as a fallback if this is absent) — send it explicitly. |
| `utmSource`, `utmMedium`, `utmCampaign`, `utmContent`, `utmTerm` | Standard UTM parameters, read from the landing URL's query string. |

Everything else — consent version/timestamp, IP hash, user-agent summary — is derived server-side
and never sent by the client.

---

## `POST /app/web/v1/waitlist`

Backs `WaitlistForm`'s three variants (footer / compact / full page). Only `email` is required by
the API; `firstName`/`lastName`/`country`/`interests` are required **by the full-page variant's
own HTML**, not by this endpoint — the footer/compact variants never send them and that's correct.

```jsonc
// body
{
  "email": "fan@example.com",             // required
  "firstName": "Ava",                     // full-page variant
  "lastName": "Novak",                    // full-page variant
  "country": "United States",             // full-page variant — send whatever your <select> uses; not format-constrained server-side (see leads-schema.md §2.4)
  "interests": ["Music", "Gaming"],        // array OR a single string OR omit entirely — all three are handled, see below
  "musicGenres": ["Rock"],
  "stateRegion": "California",
  "city": "Los Angeles",
  "ageRange": "18-24",
  "referralSource": "friend",
  "consent": "yes"                        // no dedicated consent checkbox column exists — send whatever you have; it's preserved in the audit trail either way
}
```

**`interests` — send it however `formData.getAll()` naturally produces it.** Two ticks → an array.
One tick → a bare string. Zero ticks → omit the key. All three are accepted; do not
special-case this on the frontend.

```json
// 201
{ "data": { "id": "…", "status": "pending" } }
```

**Duplicate emails are upserted, not rejected** — resubmitting the same email refreshes your name
and interests rather than erroring. If you re-submit from the footer widget (which never sends
`interests`) after an earlier full-page signup, previously recorded interests are preserved, not
wiped — omit the field entirely rather than sending `interests: []` if you don't have new data to
report.

| Status | Code | When |
| --- | --- | --- |
| 422 | `VALIDATION_ERROR` | Missing/invalid `email`, or a field exceeds its length limit |

---

## `POST /app/web/v1/contact`

Backs `ContactForm`. **Field name note:** your form's `subject` field maps to the stored `topic`
column — send it as `subject` in the request; the mapping happens server-side.

```jsonc
// body
{
  "name": "Jordan Lee",           // required
  "email": "jordan@example.com",  // required
  "subject": "Partnership idea",  // required — NOT "topic"
  "message": "…",                 // required
  "company": "Acme Co",
  "phone": "+1 555 0100"
}
```

```json
// 201
{ "data": { "id": "…" } }
```

There is currently no consent checkbox on this form. `consentVersion` is still recorded on every
submission — it captures the privacy policy revision in force at the time, not an affirmative
tick. No frontend change needed for this; it's handled entirely server-side.

| Status | Code | When |
| --- | --- | --- |
| 422 | `VALIDATION_ERROR` | Missing `name`/`email`/`subject`/`message`, or invalid email |

---

## `POST /app/web/v1/artist-inquiry`

Backs `ArtistInquiryForm`. **Several field names differ from what's stored** — send the form's own
names; the mapping happens server-side:

| Send this field | Not this |
| --- | --- |
| `name` | ~~`contactName`~~ |
| `email` | ~~`contactEmail`~~ |
| `phone` | ~~`contactPhone`~~ |
| `management` | ~~`managementCompany`~~ |
| `label` | ~~`recordLabel`~~ |
| `projectIdea` | ~~`collaborationDescription`~~ |
| `additional` | ~~`additionalNotes`~~ |

```jsonc
// body
{
  "artistName": "Nova Ray",              // required
  "country": "Canada",                   // required
  "name": "Nova Ray",                    // required — contact name
  "email": "nova@example.com",           // required
  "projectIdea": "A signed vinyl drop",  // required
  "website": "https://novaray.example",
  "socials": "https://instagram.com/novaray\nhttps://twitter.com/novaray",  // free text — see below
  "phone": "+1 555 0100",
  "management": "Acme Management",
  "label": "Indie Records",
  "collectibleType": "Vinyl",            // single value — see below
  "timeline": "Q2 2026",
  "additional": "Anything else you want to mention"
}
```

**`socials` is free text, not a URL field** — send whatever the visitor typed (a textarea is
fine: newline- or comma-separated links). The API does a best-effort parse into a primary link
plus additional links; it is not guaranteed to catch everything perfectly, so also expect that the
raw text you sent is preserved regardless — nothing is silently lost even on a bad parse.

**`collectibleType` is a single value** (from a `<select>`) even though it's stored as a list
internally — send just the one string, the API wraps it.

**Not on the form yet, accepted for when they are added:** `primaryCategory`, `contactRole`
(strings), `authorizedConfirmation` (boolean — this should be a real checkbox confirming the
artist has rights to enter the collaboration; today it's always `null` because no such checkbox
exists).

```json
// 201
{ "data": { "id": "…" } }
```

| Status | Code | When |
| --- | --- | --- |
| 422 | `VALIDATION_ERROR` | Missing `artistName`/`country`/`name`/`email`/`projectIdea`, invalid email/URL |

---

## `POST /app/web/v1/business-inquiry`

Backs `BusinessPartnerForm`. **Field name note**, same pattern as above:

| Send this field | Not this |
| --- | --- |
| `company` | ~~`companyName`~~ |
| `name` | ~~`contactName`~~ |
| `email` | ~~`workEmail`~~ |
| `website` | ~~`companyWebsite`~~ |
| `projectDetails` | ~~`message`~~ |
| `additional` | ~~`additionalNotes`~~ |

```jsonc
// body
{
  "company": "Acme Retail",                 // required
  "name": "Sam Rivera",                     // required
  "email": "sam@acme.example",              // required
  "country": "United Kingdom",              // required
  "partnershipType": "Retail Distribution", // required
  "projectDetails": "…",                    // required
  "jobTitle": "VP Partnerships",            // optional — nullable in storage
  "phone": "+44 20 0000 0000",
  "website": "https://acme.example",        // optional — nullable in storage
  "companyDescription": "What Acme does, for context",
  "additional": "Anything else"
}
```

`jobTitle` and `website` are optional here, matching the form — earlier schema drafts had them
required in storage; that's been relaxed to match reality (see
[leads-schema.md](leads-schema.md) §2.1).

`companyDescription` is a **different question** from the internal `relevantCapabilities` field
(which nothing currently populates) — don't conflate the two if the form ever grows a
capabilities question separately.

```json
// 201
{ "data": { "id": "…" } }
```

| Status | Code | When |
| --- | --- | --- |
| 422 | `VALIDATION_ERROR` | Missing `company`/`name`/`email`/`country`/`partnershipType`/`projectDetails`, invalid email/URL |

---

## Things this API deliberately does NOT do yet

- **No email verification / double opt-in** for waitlist signups — `status` will always be
  `"pending"`. Don't build UI that implies a confirmation email is coming.
- **No unsubscribe endpoint** — if your consent copy promises "unsubscribe any time," that promise
  isn't backed by a working link yet.
- **No CAPTCHA/bot defense** beyond the 20/min IP rate limit. If spam becomes a problem, that's a
  frontend+backend joint effort (e.g. a honeypot field, which costs nothing on either side and can
  be added without an API contract change — an extra hidden field submitted-but-ignored server-side
  is a reasonable first step).
