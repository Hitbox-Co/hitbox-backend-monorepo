# Media Storage — S3 Configuration

> How to create and secure the bucket behind `@hitbox/media`: environment
> variables, CORS, bucket policy, IAM, lifecycle rules, and a local MinIO
> setup.
>
> Companion reading: [admin API reference](../admin/admin-api-reference.md)
> (the upload endpoints a client calls), [database
> architecture](../database-architecture.md) (`MediaAsset`, the registry).

---

## 0. The architecture, in one picture

```text
 Browser / Admin UI
        │
        │ 1. POST /api/v1/admin/media/upload-url   { assetType, fileName,
        ▼                                            mimeType, ownerType,
 ┌──────────────────┐                                 ownerId, sizeBytes }
 │ Railway backend  │  permission + scope check, MIME + size check,
 │  apps/backend    │  MediaAsset row, presign
 └──────────────────┘
        │ 2. { assetId, uploadUrl, storageRef, publicUrl }
        ▼
 Browser ── 3. PUT the bytes, same Content-Type ──▶  S3  (hitbox-media-prod,
                                                          ap-south-1)
        │
        │ 4. reading it back depends on the prefix:
        ├── drop-images/ · profile-images/  ──▶ permanent public S3 URL
        └── everything else                ──▶ GET /admin/media/:assetId/url
                                                (60s presigned GET, after a
                                                 permission check)
```

**There is no SQS queue, no scan worker and no scan callback in this
deployment.** See §8 for what that means and what was left in place.

The backend never proxies file bytes. A 500 MB `EXCLUSIVE_CONTENT` upload
never touches a Railway dyno — only the ~1 KB presign request does.

---

## 1. What the application expects

| Variable | Required | Production value | Notes |
|---|---|---|---|
| `MEDIA_S3_BUCKET` | for media to work at all | `hitbox-media-prod` | Absent ⇒ media routes are **not mounted** |
| `MEDIA_S3_REGION` | yes in practice | `ap-south-1` | Falls back to `us-east-1`; a wrong region fails at S3, not at boot |
| `AWS_ACCESS_KEY_ID` | yes on Railway | `AKIA…` | Read by the SDK's own credential chain |
| `AWS_SECRET_ACCESS_KEY` | yes on Railway | — | Never commit. Railway service variable only |
| `MEDIA_S3_PUBLIC_BASE_URL` | no | *(unset)* | Overrides where public URLs point. Set it to a CloudFront domain to move image traffic to a CDN without a code change |
| `MEDIA_S3_ENDPOINT` | **no — local only** | *(must be unset)* | MinIO. Also switches on path-style addressing |

⚠ **`MEDIA_S3_ENDPOINT` must not be set in production.** It redirects both the
presigner and every public URL away from S3, and turns on path-style
addressing. It exists for MinIO (§10) and nothing else.

Credentials are deliberately **not** part of `packages/shared/config/env.ts`.
The AWS SDK resolves them from the process environment itself, so no code in
this repo ever holds a secret in a variable it could log.

**Without `MEDIA_S3_BUCKET`** every `/api/v1/admin/media/*` route returns
`503 STORAGE_UNAVAILABLE`. That is deliberate: an upload endpoint that creates a
`MediaAsset` row and *then* fails to presign leaves an orphaned registry entry
pointing at an object that does not exist.

### Railway

Set these under the backend service → **Variables**. Railway injects them into
the process environment, which is exactly where the AWS SDK looks.

```env
MEDIA_S3_BUCKET=hitbox-media-prod
MEDIA_S3_REGION=ap-south-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Rotate the key pair on a schedule and whenever someone with dashboard access
leaves. Railway has no equivalent of an EC2 instance role, so a long-lived IAM
user key is the only option here — which makes §5's least privilege the thing
that limits the blast radius if it leaks.

---

## 2. The bucket

One production bucket:

```
hitbox-media-prod        ap-south-1
```

```bash
aws s3api create-bucket \
  --bucket hitbox-media-prod \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1
```

### Block Public Access — three ON, two OFF

This is the setting that trips people up. The bucket serves two public
prefixes through a **bucket policy**, so the two policy-related blocks must be
off; the two ACL-related blocks stay on, because ACLs are disabled entirely.

```bash
aws s3api put-public-access-block --bucket hitbox-media-prod \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"
```

| Setting | Value | Why |
|---|---|---|
| `BlockPublicAcls` | `true` | ACLs are disabled; nothing should ever try |
| `IgnorePublicAcls` | `true` | Same |
| `BlockPublicPolicy` | **`false`** | Otherwise the §4 policy is rejected outright |
| `RestrictPublicBuckets` | **`false`** | Otherwise the policy is accepted but anonymous reads still fail |

Turning the last two off does **not** make the bucket public. It makes a
*policy* able to grant public access — and the policy in §4 grants it on
exactly two prefixes. Everything else stays private because nothing grants it.

### ACLs disabled (Bucket Owner Enforced)

```bash
aws s3api put-bucket-ownership-controls --bucket hitbox-media-prod \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
```

With ACLs off, object-level permissions cannot exist — access is decided by
the bucket policy and IAM alone, which is one place instead of three. It also
means a presigned PUT cannot smuggle an `x-amz-acl` header.

### Versioning, encryption, bucket key

```bash
aws s3api put-bucket-versioning --bucket hitbox-media-prod \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket hitbox-media-prod \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
```

SSE-S3 (`AES256`), not SSE-KMS: no per-object KMS charge, no key policy to keep
in sync with the IAM policy, and nothing for the presigned PUT to have to
declare. `BucketKeyEnabled` is harmless under SSE-S3 and correct to leave on if
encryption is ever moved to KMS.

Versioning matters because `DELETE /admin/media/:assetId` is a **soft** delete —
it sets `archivedAt` and never touches the object. Versioning protects against
the accidental overwrite instead.

> ⚠ **Do not add a bucket policy that denies `PutObject` without an
> `x-amz-server-side-encryption` header.** That is a common hardening snippet
> and it will break every upload here: the presigned PUT is signed with only
> `Content-Type` and `Content-Length`, so the client sends no encryption header
> and the request is denied. *Default* bucket encryption encrypts server-side
> with no client header at all, which is why it is the right mechanism for a
> presigned-upload flow.

---

## 3. CORS — the one that breaks uploads

The browser PUTs the file **directly to S3**, so without CORS the upload fails
in the browser while working perfectly from `curl`. This is the single most
common cause of "the upload URL doesn't work".

```json
[
  {
    "AllowedOrigins": [
      "https://admin.hitbox.example",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

```bash
aws s3api put-bucket-cors --bucket hitbox-media-prod \
  --cors-configuration file://cors.json
```

Replace `https://admin.hitbox.example` with the real production frontend
origin before applying. Origin match is exact — scheme, host and port — so
`https://admin.hitbox.example` does not cover `https://www.admin.hitbox.example`.

Notes that matter:

- `AllowedHeaders` must include **`content-type`**, because the signature binds
  it — the browser sends it and the preflight must permit it.
- Include **`content-length`** too. The API always binds the exact length into
  the signature (§9). A browser sets that header itself from the request body
  and will not list it in the preflight, but allowing it costs nothing and
  covers non-browser clients that set it explicitly.
- `ExposeHeaders: ["ETag"]` lets the client read the upload's ETag, which is
  what you would compare against `MediaAsset.checksum`.
- `GET`/`HEAD` are here for the **public** prefixes, which browsers fetch
  cross-origin directly. A plain `<img src>` needs no CORS, but `fetch`,
  canvas reads and `crossorigin` image loads do.
- List real origins. `"*"` works and is the wrong habit to build.

---

## 4. Bucket policy

Two statements: anonymous read on the two public prefixes, and a blanket TLS
requirement. Per-caller authorization already happens in the application, so
nothing else belongs here.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadImagePrefixes",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": [
        "arn:aws:s3:::hitbox-media-prod/drop-images/*",
        "arn:aws:s3:::hitbox-media-prod/profile-images/*"
      ]
    },
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::hitbox-media-prod",
        "arn:aws:s3:::hitbox-media-prod/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

```bash
aws s3api put-bucket-policy --bucket hitbox-media-prod --policy file://policy.json
```

**The `Resource` list in `PublicReadImagePrefixes` and `PUBLIC_PREFIXES` in
`packages/media/src/domain/storage-key.ts` are the same fact written twice.**
If the policy is narrower than the code, images 403 in the browser. If it is
wider, the API hands out URLs for objects it believes are private — but worse,
objects become readable whether or not the API ever names them. A test pins
every asset type to its intended side; there is no equivalent guard on the
policy, so change them together.

`Action` is `s3:GetObject` only. Not `s3:*`, not `s3:ListBucket` — anonymous
`ListBucket` would let anyone enumerate every key, which for
`profile-images/users/{userId}/` leaks the user id space.

The `DenyInsecureTransport` statement applies to *everything*, including the
public reads, so an `http://` fetch of a drop image is refused too.

### What NOT to put in the bucket policy

| Tempting | Why it breaks or misleads |
|---|---|
| Deny `PutObject` without `x-amz-server-side-encryption` | Breaks every presigned upload (§2) |
| `s3:content-length-range` condition | Not a valid condition key for `PutObject` in a bucket policy — it exists only in presigned **POST** policy documents. Size is handled in §9. |
| Anonymous read on the whole bucket | Publishes `legal-documents/` and `exclusive-content/`. The prefix scoping is the entire point of the key layout |
| Per-organization prefix rules | The app resolves an asset's owning organization from the owner record and scopes on it. A policy cannot see that, and a second half-correct copy of the rule is worse than none. |

### Optional: CloudFront in front of the image prefixes

Only if you add a CDN later. Use Origin Access Control, scope it to the same
two prefixes, and set `MEDIA_S3_PUBLIC_BASE_URL` to the distribution domain so
every public URL the API returns points at the CDN. Note that with the
anonymous-read statement above already in place, OAC is a performance
choice rather than an access-control one.

---

## 5. IAM policy for the Railway backend

Least privilege, and notably **no `s3:DeleteObject`** — the API never deletes an
object, because `MediaAsset` is an append-only registry that `ProductImage` and
`ContentBundleItem` point at. `DELETE /admin/media/:assetId` sets `archivedAt`
and leaves the bytes alone.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PresignUploadsAndReads",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::hitbox-media-prod/*"
    },
    {
      "Sid": "ListForAdminTooling",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::hitbox-media-prod"
    }
  ]
}
```

Note the two resource shapes: object actions take `bucket/*`, `ListBucket`
takes the bucket ARN with no `/*`. Getting that backwards is the usual cause
of a policy that looks right and denies everything.

Attach it to a dedicated IAM **user** (Railway offers no role-based identity),
create one access key for it, and put that key in Railway's variables.

```bash
aws iam create-user --user-name hitbox-railway-backend
aws iam put-user-policy --user-name hitbox-railway-backend \
  --policy-name hitbox-media-access --policy-document file://iam-policy.json
aws iam create-access-key --user-name hitbox-railway-backend
```

That user should have **no console access** and no other attached policy.

A presigned URL carries the **signer's** authority, so the backend needs
`PutObject`/`GetObject` even though it never moves bytes itself. The corollary
is worth internalising: anyone holding this key can read every private object
in the bucket, including `legal-documents/`. That is why it is a dedicated
user with one policy and nothing else.

### Presigned URL lifetime is capped by the credential

A presigned URL dies when the credentials that signed it expire. With a
long-lived IAM user key that is not a practical limit — but it means a leaked
upload URL stays valid for its full 300 s no matter what, and revoking it
means deleting the access key. The TTLs here (300 s upload, 60 s download) are
deliberately short for exactly that reason.

---

## 6. Key layout and lifecycle

The application computes every key; nothing else should write into the bucket.

```
s3://hitbox-media-prod/
├── drop-images/          products/{productId}/{assetId}.{ext}          PUBLIC
├── profile-images/       users/{userId}/{assetId}.{ext}                PUBLIC
│                         artists/{artistId}/{assetId}.{ext}            PUBLIC
├── exclusive-content/    products/{productId}/{assetId}.{ext}          private
│                         collections/{collectionId}/{assetId}.{ext}    private
├── legal-documents/      organizations/{organizationId}/{assetId}.{ext} private
├── supply-spreadsheets/  vendors/{vendorId}/{assetId}.{ext}            private
└── other/                {ownerType}/{ownerId}/{assetId}.{ext}         private
```

The filename is the `MediaAsset.id`, never the uploaded name — so the key is
derivable from the database row alone, two uploads can never collide, and a
user-supplied string never reaches an S3 key. Only the extension survives, and
only if it matches `^[a-z0-9]{1,8}$`.

Folder-first-by-type exists precisely so the things below can differ per
prefix: **public vs private** (§4), lifecycle policy, and CDN routing. That is
the payoff.

```bash
aws s3api put-bucket-lifecycle-configuration --bucket hitbox-media-prod \
  --lifecycle-configuration file://lifecycle.json
```

```json
{
  "Rules": [
    {
      "ID": "profile-images-tiering",
      "Filter": { "Prefix": "profile-images/" },
      "Status": "Enabled",
      "Transitions": [{ "Days": 30, "StorageClass": "INTELLIGENT_TIERING" }]
    },
    {
      "ID": "supply-spreadsheets-archive",
      "Filter": { "Prefix": "supply-spreadsheets/" },
      "Status": "Enabled",
      "Transitions": [{ "Days": 90, "StorageClass": "GLACIER_IR" }]
    },
    {
      "ID": "abort-incomplete-multipart",
      "Filter": { "Prefix": "" },
      "Status": "Enabled",
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    },
    {
      "ID": "expire-old-versions",
      "Filter": { "Prefix": "" },
      "Status": "Enabled",
      "NoncurrentVersionExpiration": { "NoncurrentDays": 90 }
    }
  ]
}
```

Deliberately **no expiration rule on `exclusive-content/` or
`legal-documents/`** — those are retention-sensitive, and an object that expires
out from under a `MediaAsset` row leaves a registry entry pointing at nothing.

Note that `supply-spreadsheets/` moving to `GLACIER_IR` at 90 days does not
affect the presigned GET — Glacier Instant Retrieval reads in milliseconds
like any other class, just at a higher per-request price.

The abort-incomplete-multipart rule is the one people forget; without it,
failed large uploads bill indefinitely.

---

## 7. Public vs private reads

This is the part that differs most from a signed-everything setup.

| Prefix | Bucket policy | How a client reads it |
|---|---|---|
| `drop-images/` | anonymous `s3:GetObject` | Permanent URL, straight from the API response — `publicUrl` on the upload response and on every list item |
| `profile-images/` | anonymous `s3:GetObject` | Same |
| `exclusive-content/` | none | `GET /admin/media/:assetId/url` → 60 s presigned GET |
| `legal-documents/` | none | Same |
| `supply-spreadsheets/` | none | Same |
| `other/` | none | Same |

`GET /admin/media/:assetId/url` works for **both**. For a public key it returns
the permanent URL with `expiresIn: null` and `public: true`; for a private key
it mints a signed one with `expiresIn: 60` and `public: false`. Clients that
just read `url` and render it need no branching.

The permission and scope check runs either way. For a public object that check
governs who may *learn the address* — the bytes themselves are readable by
anyone holding the URL, which is the trade you accept for not paying a signing
round-trip per image render.

**What that means in practice:** an unpublished drop's artwork sitting in
`drop-images/` is anonymously readable by anyone who obtains its URL. Keys are
UUIDs so they are not guessable, and `ListBucket` is not granted anonymously so
they are not enumerable — but "private until launch" is not a guarantee this
architecture makes. Anything that genuinely must not leak before a date belongs
in `exclusive-content/`.

---

## 8. There is no scan pipeline — and what that changed

This deployment has **no S3 event notification, no SQS queue, no scan worker
and no scan callback.** Do not add the `put-bucket-notification-configuration`
from an earlier draft of this document.

`@hitbox/media` was originally written assuming one. Rather than tear that out,
it was made configurable — deleting it would have meant deleting the only
working design for adding scanning back later.

### What is live

`createMediaModule` in `apps/backend/src/bootstrap.ts` passes **no**
`scanPipeline` and **no** `scanCallback`, which means:

- `scanPipeline` defaults to `'disabled'`, so new assets are created
  **`SKIPPED`** — the value `media.prisma` already reserves for "trusted
  internal upload that bypassed the scanner".
- `SKIPPED` and `CLEAN` are both servable. `PENDING` and `INFECTED` are not.
- `POST /admin/media/scan-result` is **not mounted**; the route only exists
  when a `scanCallback.authenticate` middleware is supplied.

**This was the load-bearing change.** The original code created every asset
`PENDING` and served only `CLEAN`. With nothing to flip the status, every
asset would have been permanently unreadable — `GET /:assetId/url` returning
404 forever, on a correctly configured bucket, with no error anywhere to
explain it.

### What was kept, unreachable

| Kept | Why not deleted |
|---|---|
| `VirusScanStatus` enum + `MediaAsset.virusScanStatus` | Existing rows carry it; the admin dashboard counts by it; removing it is a migration for no benefit |
| `PENDING`/`INFECTED` → 404 gate | Still correct. `INFECTED` must never be servable, and a `PENDING` row means nothing has vouched for it |
| `POST /scan-result` handler, `scanResultSchema`, `recordScanResult` | Unreachable without `scanCallback`. It is the entire re-enable path; ~40 lines |
| `?virusScanStatus=` list filter | Still useful for finding legacy rows |

### Re-enabling scanning later

Two lines in bootstrap, no schema change:

```ts
createMediaModule({
    /* … */
    scanPipeline: 'enabled',
    scanCallback: { authenticate: verifyScannerSignature },
});
```

Set **both or neither**. `scanPipeline: 'enabled'` without a `scanCallback`
recreates exactly the permanent-404 bug described above. Existing `SKIPPED`
rows stay servable; only new uploads start as `PENDING`.

---

## 9. Size limits — what is and is not enforced

Be precise about this one.

| Layer | Enforced? |
|---|---|
| API rejects `sizeBytes > MAX_SIZE_BYTES[assetType]` before signing | ✅ always — `sizeBytes` is a **required** field |
| Signature binds `Content-Length` to the declared size | ✅ always — S3 rejects a body of any other length |
| Bucket policy `content-length-range` | ❌ not a valid condition for `PutObject` — presigned POST only |
| Ingest worker re-checks the stored object | ❌ **there is no worker** |

Current caps (`packages/media/src/constants/media.constant.ts`):

| Asset type | Cap |
|---|---|
| `DROP_IMAGE`, `PROFILE_IMAGE` | 15 MB |
| `EXCLUSIVE_CONTENT` | 500 MB |
| `LEGAL_DOCUMENT`, `SUPPLY_SPREADSHEET`, `OTHER` | 25 MB |

**`sizeBytes` is required, and that is a consequence of dropping the worker.**
It was optional in the original design because an ingest worker re-checked the
stored object's real length afterwards. With no worker, an upload that
declared no size would be bound by nothing at all — a 5 GB PUT against a 15 MB
cap, succeeding. The two checks above are now the only ones that exist, and
both need a declared size, so a request without one is refused with a 422
rather than silently waved through.

Clients send `file.size`. The browser sets the `Content-Length` header itself
from the request body — script cannot set it — so it matches automatically as
long as the file being PUT is the one that was measured.

---

## 10. Local development with MinIO

```yaml
# docker-compose.yml
services:
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    ports: ["9000:9000", "9001:9001"]
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes: ["minio-data:/data"]
volumes:
  minio-data:
```

```bash
# .env — LOCAL ONLY. MEDIA_S3_ENDPOINT must never be set in production.
MEDIA_S3_BUCKET=hitbox-media-dev
MEDIA_S3_REGION=us-east-1
MEDIA_S3_ENDPOINT=http://localhost:9000
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
```

Setting `MEDIA_S3_ENDPOINT` also turns on path-style addressing
(`localhost:9000/bucket/key` rather than `bucket.localhost:9000/key`), which
MinIO needs, and points public URLs at
`http://localhost:9000/hitbox-media-dev/...`.

```bash
mc alias set local http://localhost:9000 minioadmin minioadmin
mc mb local/hitbox-media-dev
mc anonymous set download local/hitbox-media-dev/drop-images
mc anonymous set download local/hitbox-media-dev/profile-images
mc admin config set local api cors_allow_origin="http://localhost:3000"
```

The two `mc anonymous set download` lines are MinIO's equivalent of the §4
public-read statement — without them, public URLs 403 locally while working in
production, which is a confusing way to spend an afternoon.

---

## 11. Verification checklist

### A. Bucket configuration

```bash
# 1. Block Public Access — expect ACLs true, Policy/RestrictPublic FALSE
aws s3api get-public-access-block --bucket hitbox-media-prod

# 2. ACLs disabled
aws s3api get-bucket-ownership-controls --bucket hitbox-media-prod
#    expect ObjectOwnership: BucketOwnerEnforced

# 3. Versioning
aws s3api get-bucket-versioning --bucket hitbox-media-prod   # Status: Enabled

# 4. Default encryption — expect AES256 and BucketKeyEnabled true
aws s3api get-bucket-encryption --bucket hitbox-media-prod

# 5. CORS lists your real origin, PUT/GET/HEAD, content-type + content-length
aws s3api get-bucket-cors --bucket hitbox-media-prod

# 6. Bucket policy — expect exactly the two statements from §4
aws s3api get-bucket-policy --bucket hitbox-media-prod --output text | jq .

# 7. Lifecycle — expect the four rules from §6
aws s3api get-bucket-lifecycle-configuration --bucket hitbox-media-prod
```

### B. IAM identity

```bash
# 8. The backend's key resolves to the dedicated user
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... aws sts get-caller-identity
#    expect .../hitbox-railway-backend

# 9. It can reach the bucket
aws s3api head-bucket --bucket hitbox-media-prod

# 10. It CANNOT delete — this must fail with AccessDenied
aws s3api delete-object --bucket hitbox-media-prod --key drop-images/probe.txt
```

### C. End-to-end upload

```bash
# 11. Ask the API for an upload URL (sizeBytes is REQUIRED)
curl -sX POST https://<railway-app>/api/v1/admin/media/upload-url \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"assetType":"DROP_IMAGE","fileName":"hero.jpg","mimeType":"image/jpeg",
       "ownerType":"product","ownerId":"<productId>","sizeBytes":482113}'
#    expect 201 { assetId, uploadUrl, expiresIn: 300, storageRef, bucket, publicUrl }

# 12. Omitting sizeBytes is refused
curl -sX POST https://<railway-app>/api/v1/admin/media/upload-url \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"assetType":"DROP_IMAGE","fileName":"hero.jpg","mimeType":"image/jpeg",
       "ownerType":"product","ownerId":"<productId>"}'
#    expect 422 VALIDATION_ERROR

# 13. Upload with the SAME content type and the exact declared byte count
curl -i -X PUT "<uploadUrl>" -H 'Content-Type: image/jpeg' --data-binary @hero.jpg
#    expect 200, and an ETag header
```

### D. Public reads work

```bash
# 14. The publicUrl from step 11 is readable with NO credentials
curl -I "<publicUrl>"                       # expect 200
curl -I "$(echo "<publicUrl>" | sed 's/^https/http/')"   # expect 403 (TLS deny)

# 15. And through the API, unsigned
curl -s https://<railway-app>/api/v1/admin/media/<assetId>/url \
  -H "Authorization: Bearer $TOKEN"
#    expect { url: "<no X-Amz- query params>", expiresIn: null, public: true }
```

### E. Private prefixes stay private

```bash
# 16. Upload a LEGAL_DOCUMENT the same way, then:
curl -I "https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/<storageRef>"
#    expect 403 AccessDenied — this is the test that matters most

# 17. The API still serves it, signed
curl -s https://<railway-app>/api/v1/admin/media/<assetId>/url \
  -H "Authorization: Bearer $TOKEN"
#    expect { url: "...X-Amz-Signature=...", expiresIn: 60, public: false }

# 18. That signed URL works now and 404s/403s after 60 seconds
```

### F. Browser

19. From the real frontend origin, `fetch(uploadUrl, { method: 'PUT', body: file,
    headers: { 'Content-Type': file.type } })` — succeeds, no CORS error in the
    console.
20. The returned `publicUrl` renders in an `<img>` with no credentials.

**Troubleshooting.** `403 SignatureDoesNotMatch` on step 13 is almost always a
`Content-Type` differing from the one declared in step 11, or a body whose
length differs from `sizeBytes`. If it fails only in a browser, it is CORS
(§3). If step 14 returns 403, re-check `BlockPublicPolicy`/
`RestrictPublicBuckets` are **false** (§2) before suspecting the policy.

---

## 12. Status of this document

The permission checks, scope isolation, key convention, MIME/size validation,
public-vs-private routing and soft delete in `@hitbox/media` are covered by
tests (36 of them, `packages/media/tests/media.test.ts`).

**The presigning calls have never run against a live bucket** — this
environment has no AWS credentials — so treat §11 as the first real exercise of
that path rather than a regression check. Steps 13, 14 and 16 are the three
that have never been executed and matter most.
