# Order Payments & Refunds API — admin guide

> **What this covers:** everything the admin app needs to show an order's
> money and run a refund — what was charged, what was collected, what was given
> back, how much more can be refunded, and the step-by-step refund workflow
> with the exact buttons to show at each step.
>
> The APIs live in two places:
> - **the order detail** (`/admin/orders/:orderId`) carries a ready-made money
>   summary, the order's payments and its refunds — enough for the order page;
> - **the payments module** (`/admin/payments/*` and `/refunds`) runs the refund
>   workflow, payment review, disputes and webhook logs.
>
> **Returns need photos.** A buyer sending an item back must upload at least
> one photo of it and describe the problem (≥ 20 characters) — see
> [6.0](#60-placing-a-return--photos-and-description). Every refund response
> now carries `evidenceCount` and, on detail, `evidence[]` with signed photo
> URLs.
>
> Deeper background: [finance/refunds-and-disputes.md](../finance/refunds-and-disputes.md)
> (why the workflow is shaped this way, what `process` does to claims and
> royalties), [finance/payments-and-webhooks.md](../finance/payments-and-webhooks.md)
> (checkout and Stripe webhooks). Packing: [order-unit-assignment-api.md](order-unit-assignment-api.md).

---

## Contents

1. [The screens and the calls behind them](#1-the-screens-and-the-calls-behind-them)
2. [Order detail — the money fields](#2-order-detail--the-money-fields)
3. [The money summary — how each number is worked out](#3-the-money-summary--how-each-number-is-worked-out)
4. [Payment transactions](#4-payment-transactions)
5. [The refund workflow](#5-the-refund-workflow)
6. [Refund endpoints](#6-refund-endpoints)
7. [What processing a refund actually does](#7-what-processing-a-refund-actually-does)
8. [Disputes (chargebacks)](#8-disputes-chargebacks)
9. [Webhook events](#9-webhook-events)
10. [Who can do what](#10-who-can-do-what)
11. [Errors](#11-errors)
12. [Worked examples](#12-worked-examples)
13. [Test data](#13-test-data)
14. [Where the code lives](#14-where-the-code-lives)
15. [Frontend checklist](#15-frontend-checklist)

All paths are under **`/api/v1`** and need a Clerk session.
List endpoints return `{ "page", "limit", "total", "items": [...] }`; single
records return `{ "data": {...} }`; errors return
`{ "error": { "code", "message", "details" } }`.

---

## 1. The screens and the calls behind them

| Screen | Call(s) |
|---|---|
| **Order page → "Payments & refunds" card** | `GET /admin/orders/:orderId` → `money`, `payments`, `refunds` (2) |
| Order page → **Refund** button | `POST /refunds` with the order's id (6.1) — show only when `money.canRequestRefund`. Photos optional for staff (6.0) |
| **Buyer app → Return this item** | `POST /refunds/evidence/upload-url` per photo → `PUT` each to S3 → `POST /refunds` with `evidenceAssetIds` (6.0, 6.1) |
| **Buyer app → My return** | `GET /refunds/:refundId` — the buyer's own refund with its photos (6.3) |
| **Refunds queue** | `GET /admin/payments/refunds?status=…` (6.2) |
| **Refund detail** + its action buttons | `GET /admin/payments/refunds/:refundId` → render one button per `allowedActions` entry (5, 6) |
| **Payments list / review queue** | `GET /admin/payments/transactions?needsReview=true` (4) |
| **Disputes** | `/admin/payments/disputes…` (8) |
| **Webhook log** (support/debug) | `GET /admin/payments/webhook-events` (9) |

Two fields mean the frontend never has to re-implement business rules:

- **`money.canRequestRefund`** + **`money.refundBlockedReason`** on the order — whether the Refund button is enabled, and why not.
- **`allowedActions`** on every refund — exactly which workflow buttons to show.

---

## 2. Order detail — the money fields

`GET /api/v1/admin/orders/:orderId`

Every order has `paidAt` and `unitAssignedById`. The callers who can see money
(any `payment-royalty:read` grant — System Admin, Finance Admin) also get
`money`, `payments` and `refunds`.

```json
{
  "data": {
    "id": "8c1e…",
    "status": "DELIVERED",
    "amount": "29.00",
    "currency": "GBP",
    "paidAt": "2026-09-15T14:03:00.000Z",
    "unitAssignedAt": "2026-09-16T10:00:00.000Z",
    "unitAssignedById": "d893…",

    "money": {
      "currency": "GBP",
      "charged": "29.00",
      "paid": "29.00",
      "refunded": "0.00",
      "refundInProgress": "29.00",
      "refundable": "29.00",
      "canRequestRefund": false,
      "refundBlockedReason": "REFUND_IN_PROGRESS",
      "openRefundId": "cf2e…",
      "returnWindowEndsAt": "2026-10-20T14:05:00.000Z",
      "returnWindowOpen": true
    },

    "payments": [
      {
        "id": "a7d0…",
        "status": "SUCCEEDED",
        "gateway": "STRIPE",
        "gatewayRef": "pi_3Q…",
        "amount": "29.00",
        "currency": "GBP",
        "needsReview": false,
        "reviewedAt": null,
        "reviewNote": null,
        "failureReason": null,
        "createdAt": "2026-09-15T14:00:00.000Z",
        "updatedAt": "2026-09-15T14:03:00.000Z"
      }
    ],

    "refunds": [
      {
        "id": "cf2e…",
        "status": "REQUESTED",
        "reasonCode": "BUYER_CHANGED_MIND",
        "reason": "Wrong size — would like to return it.",
        "amount": "29.00",
        "currency": "GBP",
        "physicalReturnRequired": true,
        "physicalReturnConfirmedAt": null,
        "nfcTagCondition": null,
        "approvedAt": null,
        "rejectionReason": null,
        "gatewayRefundId": null,
        "processedAt": null,
        "claimRevokedAt": null,
        "createdAt": "2026-10-11T12:00:00.000Z",
        "updatedAt": "2026-10-12T12:00:00.000Z"
      }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `paidAt` | When payment settled. `null` until `PAID` |
| `money` | The summary in 3 — use it for the card's headline numbers and the Refund button |
| `payments[]` | Every payment attempt, newest first. `gatewayRef` is the Stripe charge (`pi_…`) — link to the Stripe dashboard with it. `failureReason` explains a `FAILED` one |
| `refunds[]` | Every refund ever raised on the order, newest first. `gatewayRefundId` is the Stripe refund (`re_…`). Click through to the refund detail (6.3) to act on one |

Money is always a **string with two decimals** (`"2499.00"`), never a number,
and always in the order's own `currency`.

---

## 3. The money summary — how each number is worked out

| Field | Rule |
|---|---|
| `charged` | `Order.amount` — what the buyer was charged |
| `paid` | Sum of payments with status `SUCCEEDED` (failed or pending attempts don't count) |
| `refunded` | Sum of `PROCESSED` refunds Stripe hasn't failed — money actually given back |
| `refundFailed` | Sum of `PROCESSED` refunds Stripe then **failed or cancelled** (`gatewayStatus` `FAILED`/`CANCELED`). Non-zero = the order says refunded but the buyer has no money — show a red banner |
| `refundInProgress` | Amount of the open refund (`REQUESTED`, `AWAITING_RETURN` or `APPROVED`), else `"0.00"` |
| `refundable` | `charged − refunded − refundFailed`, never below zero — the most a new refund may ask for (a failed refund is fixed by an operator, not by a second request) |
| `openRefundId` | The open refund's id, for a "View refund in progress" link |
| `returnWindowEndsAt` | `deliveredAt` + `RETURN_WINDOW_DAYS` (10). `null` until delivered |
| `returnWindowOpen` | `true` until `returnWindowEndsAt` (also before delivery). When `false`, no **return** can be placed by anyone — turn the "item must be returned" toggle off and disable it |
| `canRequestRefund` | `true` only when **all** of the rules below pass |
| `refundBlockedReason` | Which rule failed, when `canRequestRefund` is `false` |

| `refundBlockedReason` | Meaning | Suggested UI |
|---|---|---|
| `NO_PERMISSION` | The caller lacks `order:refund:global` | Hide the button |
| `ORDER_NOT_REFUNDABLE` | Order isn't `PAID`, `PROCESSING`, `SHIPPED` or `DELIVERED` (e.g. pending, cancelled, already `REFUNDED`) | Disable: "This order can't be refunded" |
| `REFUND_IN_PROGRESS` | A refund is already open — only one at a time | Replace with "View refund in progress" → `openRefundId` |
| `RETURN_WINDOW_CLOSED` | **Buyer screens only.** Delivered more than 10 days ago. Staff never get this — past the window they may still refund with nothing sent back | "Return window closed on …" |
| `FULLY_REFUNDED` | `refundable` is `0.00` | Disable: "Fully refunded" |

These are the same rules `POST /refunds` enforces (6.1), so a button shown as
enabled will not be refused for these reasons.

---

## 4. Payment transactions

One row per payment attempt. A buyer who retries checkout can have a `FAILED`
row followed by a `SUCCEEDED` one.

| Status | Meaning |
|---|---|
| `INITIATED` / `PENDING` | Checkout started, not settled yet |
| `SUCCEEDED` | Money captured — the order became `PAID` |
| `FAILED` | Declined or abandoned — see `failureReason` |
| `NEEDS_REVIEW` | Flagged for a human look (e.g. billing country mismatch) |

### `GET /admin/payments/transactions`

| Query | Notes |
|---|---|
| `orderId` | One order's attempts |
| `status` | One of the statuses above |
| `needsReview` | `true` → the review queue |
| `gateway` | `STRIPE` |
| `currency` | `USD`, `INR`, `GBP` |
| `from`, `to` | ISO dates (created) |
| `page`, `limit` | Pagination |

### `GET /admin/payments/transactions/:paymentId`

```json
{
  "data": {
    "id": "a7d0…",
    "orderId": "8c1e…",
    "gateway": "STRIPE",
    "gatewayRef": "pi_3Q…",
    "status": "SUCCEEDED",
    "amount": "29.00",
    "currency": "GBP",
    "needsReview": false,
    "reviewedById": null,
    "reviewedAt": null,
    "reviewNote": null,
    "failureReason": null,
    "settledAt": "2026-09-15T14:03:00.000Z",
    "createdAt": "2026-09-15T14:00:00.000Z"
  }
}
```

### `POST /admin/payments/transactions/:paymentId/review` 🔒 `payment-royalty:manage:global`

```json
{ "decision": "APPROVE", "note": "Card holder confirmed by phone." }
```

`decision` is `APPROVE` or `REJECT`; `note` is required (1–500 chars).
Clears `needsReview` and records who reviewed it and why.

---

## 5. The refund workflow

```
             request (POST /refunds)
                     │
                     ▼
              ┌─────────────┐
              │  REQUESTED  │──────────────────────────────┐
              └──────┬──────┘                              │
                     │ confirm-return (item is back,       │
                     │ tag condition recorded)             │
                     ▼                                     │ reject
           ┌───────────────────┐                           │ (any open state)
           │  AWAITING_RETURN  │───────────────────────────┤
           └─────────┬─────────┘                           │
                     │ approve                             │
                     ▼                                     ▼
              ┌─────────────┐                        ┌──────────┐
              │  APPROVED   │───────────────────────▶│ REJECTED │  terminal
              └──────┬──────┘                        └──────────┘
                     │ process (money moves)
                     ▼
              ┌─────────────┐
              │  PROCESSED  │  terminal
              └─────────────┘
```

**The rule that shapes everything: money never moves before the item is
back.** If a refund needs the physical item returned
(`physicalReturnRequired: true`, the default), it can only be approved once
the return is confirmed — unless an admin explicitly overrides that, with a
written reason, which is recorded.

**A buyer's return starts with evidence.** When the buyer places a return
(`physicalReturnRequired: true`), the request must carry at least one photo of
the item and a description of at least 20 characters (6.0). Those photos are
what the warehouse compares the parcel against at **confirm-return** and what
the approver looks at before **approve** — show them on the refund detail
(`evidence[]`, 6.3).

A physical return starts at `AWAITING_RETURN`, not `REQUESTED`: nobody has
decided anything yet, the item simply has to come back first. `REQUESTED` is
the starting state only when nothing is being sent back.

### `allowedActions` — the buttons to show

Every refund response carries `allowedActions`, computed for the **caller**
from the refund's current state. Render exactly these buttons:

| Action | Shown when | Calls |
|---|---|---|
| `CONFIRM_RETURN` | `REQUESTED` or `AWAITING_RETURN`, a return is required, and it hasn't been confirmed yet | `POST …/confirm-return` |
| `APPROVE` | Approvable, and nothing is outstanding (return confirmed, or no return needed) | `POST …/approve` |
| `APPROVE_WITH_OVERRIDE` | Approvable, but the return is **not** confirmed yet | `POST …/approve` with `overridePhysicalReturn: true` + `overrideReason` |
| `PROCESS` | `APPROVED` | `POST …/process` |
| `REJECT` | Any open refund (`REQUESTED`, `AWAITING_RETURN`, `APPROVED`) | `POST …/reject` |

Callers without `order:refund:global` always get `[]` — they can see the
refund, not act on it. Terminal refunds (`PROCESSED`, `REJECTED`) get `[]`.

| Refund state | `allowedActions` |
|---|---|
| `REQUESTED`, return required, not back yet | `CONFIRM_RETURN`, `APPROVE_WITH_OVERRIDE`, `REJECT` |
| `REQUESTED`, no return required | `APPROVE`, `REJECT` |
| `AWAITING_RETURN`, return confirmed | `APPROVE`, `REJECT` |
| `APPROVED` | `PROCESS`, `REJECT` |
| `PROCESSED` / `REJECTED` | — |

`allowedTransitions` (the raw next statuses) is still returned, but use
`allowedActions` for buttons — it knows about the return rule and the
caller's permission.

---

## 6. Refund endpoints

### 6.0 Placing a return — photos and description

A **return** is a refund where the item goes back
(`physicalReturnRequired: true`, the default). When the **buyer** places one,
two things are mandatory:

| Requirement | Rule | Error if missing |
|---|---|---|
| **Description** | `reason`, at least **20 characters** after trimming (max 1000). Say what is wrong, not just "return" | `400 PAYMENTS_RETURN_DESCRIPTION_TOO_SHORT` — `details: { minLength, length }` |
| **Photos** | `evidenceAssetIds`, **1 to 8** photos of the item, uploaded first | `400 PAYMENTS_RETURN_EVIDENCE_REQUIRED` — `details: { minPhotos }` |

**The return window: 10 days from delivery, then closed.** Counted from
`Order.deliveredAt` (`RETURN_WINDOW_DAYS`, default 10). Once it closes:

| Who | Return (`physicalReturnRequired: true`) | Refund with nothing sent back |
|---|---|---|
| Buyer | ❌ `400 PAYMENTS_RETURN_WINDOW_CLOSED` | ❌ same — otherwise "refund me, I'll keep it" gets round the rule |
| Staff (`order:refund:global`) | ❌ same — **there is no override** | ✅ allowed (goodwill, complaint settlement) |

`details`: `{ deliveredAt, returnWindowEndsAt, returnWindowDays }`. The photo
upload URL (below) is refused the same way, so the buyer is stopped before
photographing anything. An order not yet delivered (`deliveredAt: null`) has
no window running — a shipped order can still be returned. The order detail
shows the deadline as `money.returnWindowEndsAt` (3).

Neither photos nor a description are required when nothing is sent back (`physicalReturnRequired:
false`, e.g. `NOT_DELIVERED`, `DUPLICATE_CHARGE`), and neither is forced on
**staff** raising a return on a buyer's behalf (`order:refund:global`) — the
buyer may have reported it by phone. Both may still attach photos.

**The flow — three steps, client-side:**

```
1. POST /refunds/evidence/upload-url   { orderId, fileName, mimeType, sizeBytes }   ← once per photo
       → { assetId, uploadUrl, expiresIn: 300, requiredHeaders: { "Content-Type": "image/jpeg" } }

2. PUT  {uploadUrl}                    body = the file bytes, header Content-Type exactly as given
       → 200 from S3 (no API call)

3. POST /refunds                       { orderId, reasonCode, reason, evidenceAssetIds: [assetId, …] }
       → 201, the refund with evidence[] (6.3)
```

#### `POST /refunds/evidence/upload-url`

Same access as `POST /refunds`: the order's buyer, or a caller holding
`order:refund:global`. The order must be refundable **now** and have no open
refund — the same checks as step 3, so the buyer hears "this order can't be
refunded" before taking photos, not after.

```json
{ "orderId": "8c1e…", "fileName": "IMG_0042.HEIC", "mimeType": "image/heic", "sizeBytes": 2481152 }
```

| Field | Rules |
|---|---|
| `orderId` | Required, uuid |
| `fileName` | 1–255 chars. Only the extension is kept; the stored name is the asset id |
| `mimeType` | `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` |
| `sizeBytes` | Required, `file.size`, at most **15 MB** (15 728 640). Bound into the signature: S3 rejects a body of any other length |

Response `201`:

```json
{
  "data": {
    "assetId": "a91f…",
    "uploadUrl": "https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/return-evidence/orders/8c1e…/a91f….heic?X-Amz-…",
    "expiresIn": 300,
    "requiredHeaders": { "Content-Type": "image/heic" }
  }
}
```

Then `PUT` the file to `uploadUrl` within `expiresIn` seconds, with exactly
`requiredHeaders` (the browser sets `Content-Length` itself). Keep the
`assetId`s in the order the photos should display.

| Error | When |
|---|---|
| `400 UNSUPPORTED_MIME_TYPE` | Not one of the image types above (`details.allowed`) |
| `400 FILE_TOO_LARGE` | Over 15 MB (`details.maxBytes`) |
| `400 PAYMENTS_NOT_REFUNDABLE` | Order isn't `PAID`/`PROCESSING`/`SHIPPED`/`DELIVERED` |
| `409 PAYMENTS_INVALID_TRANSITION` | A refund is already open on the order |
| `400 PAYMENTS_RETURN_WINDOW_CLOSED` | Delivered more than 10 days ago |
| `403 PAYMENTS_FORBIDDEN` | Not your order, and no refund grant |
| `404 PAYMENTS_NOT_FOUND` | No such order |
| `400 PAYMENTS_EVIDENCE_STORAGE_UNAVAILABLE` | This deployment has no media bucket — returns can't be placed here at all |

Photos are **private**: they live under `return-evidence/` in the bucket,
which has no public read, and are only ever served through short-lived signed
URLs on the refund (6.3). Brand and artist staff never see them — they are not
organization-owned, so no organization-scoped media grant reaches them.

**Uploads are checked, not trusted.** At step 3 the server asks S3 whether
each object is actually there at the declared size. An `assetId` whose upload
never completed is refused (`NOT_UPLOADED`, below) — requesting an upload URL
is not the same as uploading.

### 6.1 `POST /refunds` — start a refund (or place a return)

A buyer can raise one on their own order; anyone raising it **for** a buyer
(support, an admin) needs `order:refund:global`.

```json
{
  "orderId": "8c1e…",
  "reasonCode": "DEFECTIVE_ITEM",
  "reason": "Print peeled after the first wash; the sleeve seam has split as well.",
  "amount": "29.00",
  "physicalReturnRequired": true,
  "evidenceAssetIds": ["a91f…", "b20c…"]
}
```

| Field | Rules |
|---|---|
| `orderId` | Required |
| `reasonCode` | `DEFECTIVE_ITEM`, `DEFECTIVE_TAG`, `NOT_AS_DESCRIBED`, `NOT_DELIVERED`, `DUPLICATE_CHARGE`, `BUYER_CHANGED_MIND`, `FRAUDULENT_CHARGE`, `OTHER` |
| `reason` | The description. 1–1000 chars, trimmed; **≥ 20 on a buyer's return** (6.0) |
| `amount` | Optional — omit for a full refund. A partial amount is allowed (never more than `money.refundable`), but **processing any refund marks the order `REFUNDED`**, so an order gets one refund — make it the right amount |
| `physicalReturnRequired` | Default `true`. Set `false` for e.g. `NOT_DELIVERED` or `DUPLICATE_CHARGE`, where there's nothing to send back |
| `evidenceAssetIds` | Photo asset ids from 6.0, in display order. 0–8, no duplicates. **At least 1 on a buyer's return** |

Each photo must have been uploaded **by the caller**, **for this order**, and
actually reached storage, and must not already belong to another refund.
Every bad photo is reported at once, so the UI can mark exactly which
thumbnails to retry:

```json
{
  "error": {
    "code": "PAYMENTS_RETURN_EVIDENCE_INVALID",
    "message": "Some photos cannot be attached to this return.",
    "details": {
      "problems": [
        { "assetId": "a91f…", "problem": "NOT_UPLOADED" },
        { "assetId": "c77d…", "problem": "NOT_FOUND" }
      ]
    }
  }
}
```

| `problem` | Meaning | What the UI should do |
|---|---|---|
| `NOT_UPLOADED` | An upload URL was issued but the `PUT` never completed (or was a different size) | Re-upload that photo (new upload URL) |
| `NOT_FOUND` | Unknown id, not a return photo, or uploaded by someone else | Drop it; re-upload |
| `WRONG_ORDER` | The photo was uploaded for a different order | Re-upload for this order |
| `ALREADY_ATTACHED` | The photo already belongs to another refund | Re-upload |
| `ARCHIVED` | The photo was removed | Re-upload |
| `REJECTED_BY_SCAN` | The malware scanner flagged it (only when scanning is enabled) | Use a different file |

The refund and its photos are written in one transaction — a return never
exists without the photos it was placed with. Two returns racing for the same
photo produce one success and a `409 PAYMENTS_RETURN_EVIDENCE_INVALID`.

Also refused when the order isn't `PAID`/`PROCESSING`/`SHIPPED`/`DELIVERED`
(`400 PAYMENTS_NOT_REFUNDABLE`), a refund is already open
(`409 PAYMENTS_INVALID_TRANSITION`, `details.refundRequestId`), or the amount
would over-refund (`400 PAYMENTS_AMOUNT_EXCEEDS_CAPTURE`, with
`details.orderAmount`, `alreadyRefunded`, `requested`).

Response `201`: the refund (6.3) including `evidence[]`. Status
`AWAITING_RETURN` when `physicalReturnRequired` is `true`, `REQUESTED` when it
is `false`.

### 6.2 `GET /admin/payments/refunds` — the queue

| Query | Notes |
|---|---|
| `status` | `REQUESTED`, `AWAITING_RETURN`, `APPROVED`, `PROCESSED`, `REJECTED` |
| `orderId` | One order's refunds |
| `reasonCode` | One reason |
| `gatewayStatus` | `PENDING`, `SUCCEEDED`, `FAILED`, `CANCELED` — `FAILED` is the "buyer not paid back" queue |
| `from`, `to` | ISO dates (created) |
| `page`, `limit` | Pagination |

Suggested tabs: **Requested · Awaiting return · Approved (ready to pay) ·
Processed · Rejected**, plus a red **Failed at Stripe** tab
(`gatewayStatus=FAILED`). Each item carries `allowedActions`, so the queue can
offer inline actions.

List items carry `evidenceCount` (show a 📷 2 badge) but **`evidence: null`**
— photo URLs are only minted on the detail, so a 20-row page doesn't sign 160
URLs nobody looks at. Open the detail to see the photos.

### 6.3 `GET /admin/payments/refunds/:refundId` — detail

The buyer reads their own refund at **`GET /refunds/:refundId`** — same
response, scoped to refunds on their own orders (anyone else's is a `404`),
with `allowedActions: []`.

```json
{
  "data": {
    "id": "cf2e…",
    "orderId": "8c1e…",
    "requestedById": "5a1f…",
    "reason": "Wrong size — would like to return it.",
    "reasonCode": "BUYER_CHANGED_MIND",
    "status": "AWAITING_RETURN",
    "amount": "29.00",
    "currency": "GBP",
    "physicalReturnRequired": true,
    "physicalReturnConfirmedAt": null,
    "nfcTagCondition": null,
    "approvedById": null,
    "approvedAt": null,
    "rejectionReason": null,
    "gatewayRefundId": null,
    "gatewayStatus": null,
    "gatewayFailureReason": null,
    "gatewayStatusAt": null,
    "processedAt": null,
    "claimRevokedAt": null,
    "resaleBlockedUntil": null,
    "createdAt": "2026-10-11T12:00:00.000Z",
    "evidenceCount": 2,
    "evidence": [
      {
        "assetId": "a91f…",
        "position": 0,
        "fileName": "IMG_0042.HEIC",
        "mimeType": "image/heic",
        "sizeBytes": 2481152,
        "url": "https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/return-evidence/orders/8c1e…/a91f….heic?X-Amz-Expires=300&…",
        "expiresIn": 300,
        "attachedAt": "2026-10-11T12:00:00.000Z"
      },
      {
        "assetId": "b20c…",
        "position": 1,
        "fileName": "label.jpg",
        "mimeType": "image/jpeg",
        "sizeBytes": 911204,
        "url": null,
        "expiresIn": null,
        "attachedAt": "2026-10-11T12:00:00.000Z"
      }
    ],
    "allowedTransitions": ["APPROVED", "REJECTED"],
    "allowedActions": ["CONFIRM_RETURN", "APPROVE_WITH_OVERRIDE", "REJECT"]
  }
}
```

| Field | Meaning |
|---|---|
| `evidenceCount` | Photos the buyer attached. On list rows too |
| `evidence[]` | The photos, in the buyer's order (`position` 0…). Detail responses only — `null` on list rows. Every write that returns the refund (confirm-return, approve, reject, process) returns it too |
| `evidence[].url` | Signed GET, valid **`expiresIn` = 300 s**. Render it directly (`<img src>`); don't store it. Re-fetch the refund for fresh URLs once they expire (e.g. on a 403 from S3 when the operator comes back to the tab) |
| `evidence[].url: null` | The photo is still attached but can't be shown — removed, flagged by a scanner, or no storage on this deployment. Show a "photo unavailable" placeholder; it still counts in `evidenceCount` |
| `evidence[].mimeType` | `image/heic` won't render in most desktop browsers outside Safari — show a download link or convert client-side for those |
| `nfcTagCondition` | Recorded at the return: `INTACT`, `DAMAGED`, `MISSING`, `TAMPERED` |
| `claimRevokedAt` | Set if the buyer had claimed the item and the refund took ownership back (7) |
| `resaleBlockedUntil` | Set when the returned tag wasn't intact — the unit can't be resold until then |
| `gatewayStatus` | Stripe's view of the money, separate from `status`: `null` (not reported) → `PENDING` → `SUCCEEDED`, or `FAILED` / `CANCELED` |
| `gatewayFailureReason` | Stripe's reason when it failed, e.g. `expired_or_canceled_card` |
| `gatewayStatusAt` | When Stripe last reported |

**`status: PROCESSED` + `gatewayStatus: FAILED`** means the workflow finished
but the money never reached the buyer. Nothing is undone automatically; an
operator contacts the buyer and pays them another way. Details:
[finance/stripe-adapter.md §6](../finance/stripe-adapter.md#6-refund-webhooks--what-happens-after-process).

### 6.4 `POST /admin/payments/refunds/:refundId/confirm-return` 🔒

The item arrived back at the warehouse. Record the tag's condition **now**,
while it's in hand.

```json
{ "nfcTagCondition": "INTACT", "note": "Box dented, item fine.", "receivedAt": "2026-10-14T09:30:00Z" }
```

`nfcTagCondition` is required. Moves the refund to `AWAITING_RETURN` with the
return confirmed — after which `allowedActions` offers plain `APPROVE`.

Show the buyer's `evidence[]` photos beside this dialog: the warehouse is
checking that what arrived is what the buyer photographed, and a mismatch
(different item, different damage) is grounds to **reject**.

### 6.5 `POST /admin/payments/refunds/:refundId/approve` 🔒

```json
{ "note": "Damage confirmed from photos." }
```

Overriding the return requirement (e.g. the courier lost the parcel):

```json
{ "overridePhysicalReturn": true, "overrideReason": "Courier confirmed the parcel was lost in transit." }
```

Without the override, approving before the return is confirmed is refused
(`400 PAYMENTS_RETURN_NOT_CONFIRMED`). An override without a reason is a `422`.

### 6.6 `POST /admin/payments/refunds/:refundId/reject` 🔒

```json
{ "rejectionReason": "Returned item doesn't match the order (different serial)." }
```

Allowed from any open state. Terminal.

### 6.7 `POST /admin/payments/refunds/:refundId/process` 🔒

Pays the money back. Allowed only when `APPROVED`.

```json
{}
```

**With the Stripe adapter wired** (`STRIPE_SECRET_KEY` set — see
[finance/stripe-adapter.md](../finance/stripe-adapter.md)), `{}` is enough: the
server issues the refund in Stripe itself and stores the returned `re_…` as
`gatewayRefundId`. If Stripe refuses or can't be reached, nothing changes here —
the refund stays `APPROVED` and Process can be pressed again (it can never
refund twice; the Stripe call is idempotent per refund).

**Without the adapter**, or for a refund already issued in the Stripe
dashboard, pass its id and the Stripe call is skipped (with the webhook set
up, a dashboard refund for the approved amount is picked up automatically —
no need to paste the id):

```json
{ "gatewayRefundId": "re_3Q…", "processedAt": "2026-10-14T11:00:00Z" }
```

No adapter and no `gatewayRefundId`: `400 PAYMENTS_GATEWAY_UNAVAILABLE`.
Stripe failures: `400 PAYMENTS_GATEWAY_REJECTED` / `PAYMENTS_GATEWAY_UNREACHABLE`
(see 11). See 7 for everything else this does.

All four actions return the updated refund (6.3).

🔒 = `order:refund:global` (System Admin, Order Manager).

---

## 7. What processing a refund actually does

`process` is one operation with several consequences, all handled by the
backend — the frontend just shows the result:

1. **Money moves** — refund issued at Stripe by the adapter (or the supplied `gatewayRefundId` recorded). If this step fails, nothing below happens and the refund stays `APPROVED`.
2. **The order becomes `REFUNDED`.**
3. **Ownership is taken back if the buyer had claimed the item** — the claim is stamped revoked (`claimRevokedAt`, never deleted), the unit's owner is cleared, the ownership period is closed, the item leaves the buyer's collection, and a `FLAG` row is appended to the unit's provenance chain (the `CLAIM` row is never rewritten).
4. **A damaged/missing/tampered tag blocks resale** for a period (`resaleBlockedUntil`) and puts the tag in `DISPUTED`.
5. **Royalties are reversed** — the artist's royalty for that sale is reversed with an adjustment entry, so the artist isn't paid for a refunded sale.

A unit that **shipped** is **not** put back on sale automatically: whether it
can be sold again is decided from the returned item's condition, through the
SKU inventory tools ([admin/sku-inventory-management.md](../admin/sku-inventory-management.md)).
A unit that **never shipped** (refunded while `PAID` / `PROCESSING`) goes
straight back on sale: its hold is released and the order's `skuId` is
cleared.

**Cancelling a paid order is a refund.** `PATCH …/status CANCELLED` refuses
`PAID` / `PROCESSING` orders (`ORDERS_CANCEL_REQUIRES_REFUND`). Raise a refund
with `physicalReturnRequired: false` instead; see
[checkout-sweep.md §4](checkout-sweep.md#4-cancelling-an-order-admin).

Over-refund protection: a refund can never take the total refunded past what
the order was charged — checked when the refund is requested.

Full detail: [finance/refunds-and-disputes.md](../finance/refunds-and-disputes.md).

---

## 8. Disputes (chargebacks)

A dispute is the buyer's bank pulling the money back, not a refund HitBox
chose to give. 🔒 writes need `payment-royalty:manage:global`.

| Method | Path | What |
|---|---|---|
| `GET` | `/admin/payments/disputes` | List — filter `orderId`, `status`, `dueBefore` (evidence deadline) |
| `GET` | `/admin/payments/disputes/:disputeId` | Detail |
| `POST` 🔒 | `/admin/payments/disputes` | Record one: `{ orderId, reasonCode, amount, currency, paymentTransactionId?, gatewayCaseRef?, reason?, feeAmount?, evidenceDueBy? }` |
| `POST` 🔒 | `/admin/payments/disputes/:disputeId/evidence` | `{ evidence: {…}, note? }` |
| `POST` 🔒 | `/admin/payments/disputes/:disputeId/resolve` | `{ outcome: WON \| LOST \| ACCEPTED \| WITHDRAWN, resolutionNote, feeAmount? }` |

Statuses: `OPEN`, `UNDER_REVIEW`, `EVIDENCE_SUBMITTED`, then one of `WON`,
`LOST`, `ACCEPTED`, `WITHDRAWN`. Reason codes: `FRAUDULENT`,
`PRODUCT_NOT_RECEIVED`, `PRODUCT_UNACCEPTABLE`, `DUPLICATE`,
`SUBSCRIPTION_CANCELED`, `CREDIT_NOT_PROCESSED`, `UNRECOGNIZED`, `OTHER`.

Show disputes with an approaching `evidenceDueBy` prominently — missing the
deadline loses the dispute.

---

## 9. Webhook events

`GET /admin/payments/webhook-events` 🔒 `payment-royalty:manage:global`

The raw Stripe events the backend received — useful when a payment "didn't
go through". Filter with `provider`, `eventType`
(e.g. `payment_intent.succeeded`), `unprocessedOnly=true`.

```json
{ "id": "evt_…", "provider": "STRIPE", "eventType": "payment_intent.succeeded",
  "signatureVerified": true, "processedAt": "…", "processingError": null, "receivedAt": "…" }
```

An event with `processingError` set or `processedAt: null` is the first place
to look when an order is stuck in `PENDING_PAYMENT` after the buyer paid.

Refund events (`refund.created`, `refund.updated`, `refund.failed`) keep each
refund's `gatewayStatus` current, flag refunds that fail after processing, and
auto-process an approved refund that someone paid out in the Stripe dashboard
instead of pressing Process. See
[finance/stripe-adapter.md §6](../finance/stripe-adapter.md#6-refund-webhooks--what-happens-after-process).

---

## 10. Who can do what

Checked by capability, never role name.

| Capability | Lets you | Seeded holders |
|---|---|---|
| `payment-royalty:read` | See `money`/`payments`/`refunds` on orders; read transactions, refunds, disputes | System Admin, Finance Admin |
| `order:refund:global` | Raise a refund for any buyer; confirm return, approve, reject, process | System Admin, Order Manager |
| `payment-royalty:manage:global` | Review payments, run disputes, read webhook logs | System Admin |
| *(none)* | A buyer raising a refund on **their own** order, uploading its return photos, and reading it back (`GET /refunds/:refundId`) | Any signed-in buyer |

Artists and brand staff can't see refunds or disputes. A caller who can read
but not refund sees every number, gets `money.refundBlockedReason:
"NO_PERMISSION"` and empty `allowedActions`.

---

## 11. Errors

| Status | Code | When |
|---|---|---|
| `400` | `PAYMENTS_NOT_REFUNDABLE` | Order status isn't refundable, or there's no settled charge to refund |
| `400` | `PAYMENTS_RETURN_NOT_CONFIRMED` | Approving before the return is confirmed, without an override |
| `400` | `PAYMENTS_AMOUNT_EXCEEDS_CAPTURE` | The refund would exceed what was charged (`details` has the numbers) |
| `400` | `PAYMENTS_GATEWAY_UNAVAILABLE` | Processing with no adapter wired (or no key for this config's `credentialsRef`) and no `gatewayRefundId` |
| `400` | `PAYMENTS_GATEWAY_REJECTED` | Stripe refused — e.g. already refunded, unknown charge. `details.providerCode` has Stripe's code. Nothing changed; refund stays `APPROVED` |
| `400` | `PAYMENTS_GATEWAY_UNREACHABLE` | Stripe down, timed out or rate-limited. Nothing changed — press Process again |
| `400` | `PAYMENTS_RETURN_WINDOW_CLOSED` | More than 10 days since delivery: no return by anyone, no refund by the buyer (6.0). `details.returnWindowEndsAt` |
| `400` | `PAYMENTS_RETURN_EVIDENCE_REQUIRED` | A buyer's return with no photos (6.0) |
| `400` | `PAYMENTS_RETURN_DESCRIPTION_TOO_SHORT` | A buyer's return whose `reason` is under 20 characters (`details.minLength`, `details.length`) |
| `400` | `PAYMENTS_RETURN_EVIDENCE_INVALID` | One or more photos can't be attached — `details.problems[]` per asset (6.1) |
| `409` | `PAYMENTS_RETURN_EVIDENCE_INVALID` | A photo was attached to another return at the same moment — re-upload it |
| `400` | `PAYMENTS_EVIDENCE_STORAGE_UNAVAILABLE` | No media bucket on this deployment, so return photos (and so buyer returns) aren't possible |
| `400` | `UNSUPPORTED_MIME_TYPE` / `FILE_TOO_LARGE` | Photo upload URL: not a JPEG/PNG/WebP/HEIC/HEIF, or over 15 MB |
| `403` | `PAYMENTS_FORBIDDEN` | Missing the capability for the action |
| `404` | `PAYMENTS_NOT_FOUND` | Refund, payment, dispute or order not found (or outside your scope) |
| `409` | `PAYMENTS_INVALID_TRANSITION` | The action isn't possible from the current status, a refund is already open, or someone changed it concurrently — reload |
| `422` | `VALIDATION_ERROR` | Malformed body (e.g. override without a reason, bad `reasonCode`) |

If the UI only offers buttons from `allowedActions` and enables Refund only on
`money.canRequestRefund`, the 400/409 cases above should only appear on a
race with another admin — show the message and reload.

---

## 12. Worked examples

### A damaged T-shirt, returned and refunded

```http
# Buyer app — one upload URL per photo, then PUT each straight to S3
POST /api/v1/refunds/evidence/upload-url
{ "orderId": "8c1e…", "fileName": "print.jpg", "mimeType": "image/jpeg", "sizeBytes": 911204 }
→ 201 { assetId: "a91f…", uploadUrl: "https://…s3…", expiresIn: 300, requiredHeaders: { Content-Type: image/jpeg } }

PUT https://…s3…   (Content-Type: image/jpeg, body = the file)
→ 200

POST /api/v1/refunds
{ "orderId": "8c1e…", "reasonCode": "DEFECTIVE_ITEM",
  "reason": "Print is peeling off the front after one wash.",
  "evidenceAssetIds": ["a91f…"] }
→ 201, status AWAITING_RETURN, evidenceCount 1, evidence[0].url signed for 300 s

# Admin app (allowedActions as seen by an order:refund:global holder)
GET /api/v1/admin/payments/refunds/cf2e…
→ allowedActions [CONFIRM_RETURN, APPROVE_WITH_OVERRIDE, REJECT], evidence[] with the photo

POST /api/v1/admin/payments/refunds/cf2e…/confirm-return
{ "nfcTagCondition": "INTACT" }
→ status AWAITING_RETURN, allowedActions [APPROVE, REJECT]

POST /api/v1/admin/payments/refunds/cf2e…/approve
{ "note": "Damage confirmed." }
→ status APPROVED, allowedActions [PROCESS, REJECT]

POST /api/v1/admin/payments/refunds/cf2e…/process
{}
→ status PROCESSED, gatewayRefundId "re_…"; order → REFUNDED,
  money.refunded "29.00", money.refundable "0.00", canRequestRefund false (ORDER_NOT_REFUNDABLE)
```

### A return refused for a photo that never uploaded

```http
POST /api/v1/refunds
{ "orderId": "8c1e…", "reasonCode": "NOT_AS_DESCRIBED",
  "reason": "Colour is navy, the listing showed black.", "evidenceAssetIds": ["a91f…", "b20c…"] }
→ 400 PAYMENTS_RETURN_EVIDENCE_INVALID
  details.problems [{ assetId: "b20c…", problem: "NOT_UPLOADED" }]
```

Re-upload `b20c…`'s file (new upload URL → new `assetId`), then resend with
`["a91f…", "<new id>"]`. Nothing was created by the failed attempt.

### Parcel lost in transit — no return possible

```http
POST /api/v1/refunds
{ "orderId": "…", "reasonCode": "NOT_DELIVERED", "reason": "Courier lost it.", "physicalReturnRequired": false }
→ allowedActions [APPROVE, REJECT]
POST …/approve   {}
POST …/process   {}
```

### Partial refund (goodwill)

```http
POST /api/v1/refunds  { "orderId": "…", "reasonCode": "OTHER", "reason": "Late delivery goodwill.", "amount": "500.00", "physicalReturnRequired": false }
→ approve → process → money.refunded "500.00", money.refundable "1999.00",
  but the order is now REFUNDED → canRequestRefund false (ORDER_NOT_REFUNDABLE)
```

Today an order gets one refund: processing marks it `REFUNDED` even when the
amount was partial. Asking for more than `money.refundable` is refused with
`400 PAYMENTS_AMOUNT_EXCEEDS_CAPTURE`.

---

## 13. Test data

`pnpm db:seed:test-refunds` adds one refund
in each workflow state to existing demo orders that have none — REQUESTED
(return needed, claimed unit), REQUESTED (no return), AWAITING_RETURN with an
INTACT tag, AWAITING_RETURN with a DAMAGED tag (claimed unit), APPROVED and
REJECTED — plus **G**, a PROCESSED refund whose Stripe refund FAILED
(`gatewayStatus: FAILED`, reuses a demo refund) for building the "buyer not
paid" UI — and lists orders you can start a new refund on. Non-destructive;
re-running uses the next orders without refunds.

Every buyer-placed return in the demo data carries **two return photos**
(`RefundEvidence` rows + `RETURN_EVIDENCE` media assets) — `db:seed:demo` adds
them to its open returns, `db:seed:test-refunds` to each scenario with
`physicalReturnRequired: true`. They are registry rows only — no bytes were
uploaded — so their signed URLs come back as `404` from S3. Use them to build
the gallery and its broken-image state; upload a real photo through 6.0 to see
one render. Demo refunds that were already `PROCESSED` before photos existed
have none (`evidenceCount: 0`).

Run from the repo root. Processing those refunds:

- **No `STRIPE_SECRET_KEY`:** send `{ "gatewayRefundId": "re_test_…" }`.
- **With a Stripe test key:** first run `pnpm db:stripe:test-charges`. Seeded
  payments have fake refs (`pi_demo_…`) Stripe doesn't know; this creates real
  test-mode charges behind every open `[TEST]` refund. Then Process with `{}`
  issues a real test refund, visible in the Stripe dashboard. Details:
  [finance/stripe-adapter.md §5](../finance/stripe-adapter.md#5-testing-it-locally).

## 14. Where the code lives

```
packages/orders/src/
  domain/order-money.ts            ← buildMoneySummary(): charged / paid / refunded / refundable / canRequestRefund
  repository/order.repository.ts   ← order detail select (payments + refunds fields)
  service/order.service.ts         ← maps them onto the order detail
packages/orders/tests/order-money.test.ts

packages/payments/src/
  domain/refund-workflow.ts        ← REFUND_TRANSITIONS + refundActions() (allowedActions)
  service/refund.service.ts        ← evidence upload / request / confirm-return / approve / reject / process
  domain/interfaces/return-evidence.interface.ts ← the port media implements (upload, inspect, signed views)
  repository/refund.repository.ts  ← refund + RefundEvidence rows in one transaction
  service/…                        ← payments, disputes, gateway configs, webhooks
  module.ts                        ← routes under /admin/payments and /refunds
  adapters/stripe-gateway.ts       ← the Stripe adapter (refunds + PaymentIntents)
  domain/gateway-error.ts          ← Stripe failures → PAYMENTS_GATEWAY_* errors
packages/payments/tests/refund-actions.test.ts
packages/payments/tests/return-evidence.test.ts ← photos + description rules, per-asset problems
packages/payments/tests/stripe-gateway.test.ts

packages/media/src/
  service/return-evidence.service.ts ← createUpload / inspect (S3 HEAD) / viewFiles (300 s signed GETs)
  domain/storage-key.ts            ← return-evidence/orders/{orderId}/{assetId}.{ext}

apps/backend/src/adapters/stripe-secrets.ts ← credentialsRef → Stripe key

apps/backend/src/bootstrap.ts      ← adminView.canRefund (order:refund:global) feeds money.canRequestRefund
```

`money.canRequestRefund` and `RefundService.request` apply the same rules from
two modules; `order-money.ts` documents that it mirrors the service, and
both are covered by tests.

---

## 15. Frontend checklist

**Order page — Payments & refunds card**
- [ ] Headline: `money.charged`, `money.paid`, `money.refunded`, `money.refundable` in `money.currency`.
- [ ] Red banner when `money.refundFailed` > 0: "A refund failed at Stripe — the buyer has not been paid back".
- [ ] Payments table from `payments[]`: status chip, amount, `gatewayRef` (link to Stripe), `failureReason` on failed rows, a "Needs review" flag.
- [ ] Refunds table from `refunds[]`: status chip, reason code, amount, dates; row click → refund detail.
- [ ] **Refund** button: enabled only when `money.canRequestRefund`; otherwise map `refundBlockedReason` (hide for `NO_PERMISSION`; "View refund in progress" → `openRefundId` for `REFUND_IN_PROGRESS`).
- [ ] Refund form: reason code select, reason text, optional partial amount (max `money.refundable`), "Item must be returned" toggle (default on; **forced off and disabled when `money.returnWindowOpen` is `false`**, with "Return window closed on {returnWindowEndsAt}"), optional photos (staff aren't required to attach any).

**Buyer app — Return this item**
- [ ] On delivered orders show "Return by {actions.returnWindowEndsAt}"; hide the Return button when `refundBlockedReason` is `RETURN_WINDOW_CLOSED`. Use the server's date, never `deliveredAt + 10` computed in the app.
- [ ] Photo picker: 1–8 images, JPEG/PNG/WebP/HEIC/HEIF, ≤ 15 MB each. Disable **Submit** until at least one has finished uploading.
- [ ] Description box with a live counter; disable **Submit** under 20 characters (after trimming). Placeholder: "What's wrong with it? e.g. the tag won't scan and the seam is split".
- [ ] Per photo: `POST /refunds/evidence/upload-url` → `PUT` the file with `requiredHeaders` → mark the thumbnail done. Upload in parallel; show progress per thumbnail.
- [ ] On `PAYMENTS_RETURN_EVIDENCE_INVALID`, mark each `details.problems[].assetId` thumbnail red with a **Retry** that re-uploads it. Don't resend the request until they're replaced.
- [ ] On `PAYMENTS_NOT_REFUNDABLE` / `PAYMENTS_INVALID_TRANSITION` from the upload-URL call, stop before the camera opens — the order can't take a return.
- [ ] After submit, the response already has `evidence[]` — show the confirmation with the photos. "My return" later: `GET /refunds/:refundId`.

**Refunds queue**
- [ ] Tabs by status; filters for reason code and date range; pagination.
- [ ] 📷 badge from `evidenceCount` (list rows have `evidence: null` — don't try to render photos here).

**Refund detail**
- [ ] Photo gallery from `evidence[]` (by `position`), with a lightbox. `url: null` → "photo unavailable" tile. URLs last 300 s: refetch the refund when an image fails to load after the tab sat idle.
- [ ] Put the gallery next to the **Confirm return** dialog — the warehouse checks the parcel against it.
- [ ] One button per `allowedActions` entry:
  - `CONFIRM_RETURN` → dialog with tag condition (INTACT / DAMAGED / MISSING / TAMPERED) + note.
  - `APPROVE` → confirm + optional note.
  - `APPROVE_WITH_OVERRIDE` → warning ("item not returned yet") + **required** override reason.
  - `PROCESS` → confirm "Pay back {amount} {currency}" and send `{}`. On `PAYMENTS_GATEWAY_UNAVAILABLE`, ask for the Stripe refund id and resend with `gatewayRefundId`. On `PAYMENTS_GATEWAY_REJECTED` show Stripe's message (offer the same "enter Stripe refund id" field — it usually means it was refunded in the dashboard). On `PAYMENTS_GATEWAY_UNREACHABLE` show "Stripe didn't respond — try again". Keep the button disabled while the request is in flight.
  - `REJECT` → required rejection reason.
- [ ] Show a timeline: requested → return confirmed (with tag condition) → approved → processed / rejected, and `claimRevokedAt` / `resaleBlockedUntil` when set.
- [ ] Stripe status chip from `gatewayStatus`: grey "Waiting for Stripe" (null), amber "On its way to card" (PENDING), green "Refunded to card" (SUCCEEDED), red "Failed at Stripe: {gatewayFailureReason}" (FAILED/CANCELED).
- [ ] Refunds queue: a **Failed at Stripe** tab → `?gatewayStatus=FAILED`.
- [ ] After any action, replace the page state with the response; reload on `409`.

**Payments & disputes**
- [ ] Payments list with a "Needs review" filter and the review dialog (APPROVE / REJECT + required note).
- [ ] Disputes list sorted by `evidenceDueBy`, with evidence and resolve dialogs.
