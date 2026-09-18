# Tax documents on S3

Where invoice PDFs, return documents and artist tax paperwork are stored, how
they are reached, and what the bucket must be configured to do.

Companion to [media/s3-configuration.md](../media/s3-configuration.md), which
covers the same bucket's user-upload side. The two share a bucket and nothing
else.

---

## 1. Why not `@hitbox/media`

`@hitbox/media` presigns a **PUT** URL for a browser to upload through. That is
exactly right for a user uploading a drop image, and exactly wrong for a tax
document: the invoice PDF is produced by the server, from server-side data, and
never passes through a client. A presign step would mean handing out a URL that
lets someone else write the invoice.

So `@hitbox/tax` has its own adapter, `S3DocumentStorage`, which:

- **puts bytes directly** and returns a key and a SHA-256, never a write URL;
- issues only short-lived **GET** URLs, after a permission check, per request,
  never cached;
- refuses any key outside its own three prefixes.

They point at the same bucket and share no code, which is the right amount of
sharing: a change to how user uploads are signed must not be able to change how
an invoice is stored.

Credentials are never passed in. The SDK resolves them from its own chain — on
Railway, the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` service variables.
There is no constructor parameter for a secret, so there is nothing for a caller
to log or hardcode. Same rule `@hitbox/media` follows.

---

## 2. Key layout

```text
s3://hitbox-media-{env}/
  tax-invoices/{country}/{fiscalYear}/{invoiceNumber}.pdf
  tax-filings/{country}/{filingType}/{period}/{filingId}.pdf
  tax-artist-documents/artists/{artistId}/{documentType}/{documentId}.{ext}
```

Real examples, both live in `hitbox-media-dev`:

```text
tax-invoices/IN/2026-27/INV-2026-27-IN-001234.pdf
tax-invoices/US/2026/INV-2026-US-001234.pdf
```

Three top-level prefixes rather than one `tax/`, because the three differ in
exactly the ways a prefix expresses:

| | Retention | IAM | Sensitivity |
| --- | --- | --- | --- |
| `tax-invoices/` | 8 years | finance tooling may read | Customer name + address |
| `tax-filings/` | 8 years | finance tooling may read | Aggregates, plus artist certificates |
| `tax-artist-documents/` | relationship + 7 years | **separate grant** | A W-9 carries an SSN |

A finance operator's export tooling can be granted `tax-invoices/*` and
`tax-filings/*` without ever being able to read a W-9.

**The filename is never user-supplied.** It is the invoice number, the filing id
or the document id — derivable from the database row alone, collision-free, and
with no user string in a path to traverse with. `document-storage-key.ts`
additionally validates every segment against `^[A-Za-z0-9._-]{1,120}$` and
throws on anything else:

```ts
invoiceDocumentKey({ countryCode: 'IN', fiscalYear: '../../drop-images', … })
// Error: Unsafe fiscal year for a storage key: "../../drop-images"
```

---

## 3. Nothing here is public — and a test says so

The bucket policy grants anonymous `s3:GetObject` on `drop-images/*` and
`profile-images/*` and nothing else. **No tax prefix is in that list, and none
may ever be.** An invoice carries a customer's name and postal address; a W-9
carries a taxpayer identification number.

This is asserted rather than left to review, because the failure mode is silent
and permanent — nothing would break, no error would be logged, and the documents
would simply be on the open internet:

```ts
// packages/tax/tests/document-storage-key.test.ts
it('no tax prefix sits under a publicly readable one', () => {
    for (const taxPrefix of TAX_PREFIXES) {
        for (const publicPrefix of PUBLIC_PREFIXES) {
            expect(taxPrefix.startsWith(publicPrefix)).toBe(false);
        }
    }
});
```

The adapter also refuses at runtime:

```ts
// Refusing to touch "drop-images/x.pdf": tax documents live under
// tax-invoices/, tax-filings/ or tax-artist-documents/ only.
```

`put` sets **no ACL**. An explicit public-read would be the one line that undoes
all of the above.

---

## 4. Reaching a document

Only ever through a presigned GET, issued after a permission check:

| Document | TTL | Route |
| --- | --- | --- |
| Invoice PDF | 300 s | `GET /invoices/:id/download` (buyer) · `GET /admin/tax/invoices/:id/download` |
| Artist tax document | **120 s** | `GET /admin/tax/artist-documents/:id/download` |

Two minutes for a W-9 rather than five: it carries a taxpayer identification
number, and the window in which a leaked URL is useful should be about as long
as it takes to click it.

Presigned rather than proxied — the bytes go straight from S3 to the client and
never through this process, which matters when a finance operator pulls a
quarter's invoices. Both are audited (`tax.invoice.download`,
`tax.artist-document.download`): fetching one of these is a disclosure of
personal data, and "who looked at this" is a question both a tax audit and a
data-subject request will ask.

`pdfStorageRef` is **never returned to a buyer or an artist**. The key is the
one string that makes a bucket worth probing.

---

## 5. Integrity

Every `put` computes SHA-256 over the bytes, sends it as `ChecksumSHA256` so S3
rejects a body that does not match, and stores it on the row
(`Invoice.pdfSha256`, `ArtistTaxDocument.documentSha256`).

That digest is what proves the object in the bucket is still the document that
was issued. Because the renderer is a pure projection of the invoice row,
re-rendering an unchanged invoice reproduces the same bytes and the same digest
— so "has this document been tampered with" is answerable years later without
keeping a second copy. The determinism is pinned by a test.

Object metadata carries `invoice-number`, `country-code`, `fiscal-year` and
`document-class`, so an object is identifiable from the bucket alone during an
incident.

---

## 6. Verification run

Performed against the live `hitbox-media-dev` bucket (`us-east-2`) on
2026-09-17, via `pnpm --filter @hitbox/tax demo:invoice -- --upload`. The
digests below are for the current artwork — they change whenever the brand mark
does, because the logo bytes are part of the document:

```text
INV-2026-27-IN-001234  INR 2240.00  24147 bytes
   uploaded s3://hitbox-media-dev/tax-invoices/IN/2026-27/INV-2026-27-IN-001234.pdf
   sha256   e95bd76264534fc7363c03ef22d978f6f4e89d6727ded91bf6adbcfcafa602d9
   presigned GET (15 min): https://hitbox-media-dev.s3.us-east-2.amazonaws.com/…

INV-2026-US-001234  USD 27.16  23952 bytes
   uploaded s3://hitbox-media-dev/tax-invoices/US/2026/INV-2026-US-001234.pdf
   sha256   a9d3084f8ca226f236c82f98b86eca2b55fea0122cc195047c31c91aa144110b
```

This exercises the real path end to end — the same `S3DocumentStorage`, the same
key convention, the same checksum binding and the same presigner the service
uses. A successful run proves the bucket, the region, the credentials and the
prefix are wired correctly. Re-running it reproduced both digests exactly, which
is the determinism claim in 5 demonstrated rather than asserted.

To repeat it:

```bash
pnpm --filter @hitbox/tax demo:invoice -- --upload
```

(needs `MEDIA_S3_BUCKET`, `MEDIA_S3_REGION` and AWS credentials in the
environment; `tsx --env-file=.env` will load them from the repo root.)

---

## 7. Before first production use

- [x] ~~**Run the migration.**~~ Applied 2026-09-18 as `20260918000000_tax_invoicing_and_staff_invitations`.
- [ ] **Confirm the bucket policy** still grants anonymous read on
      `drop-images/*` and `profile-images/*` only.
- [ ] **Add lifecycle rules** on the three prefixes — 8 years for
      `tax-invoices/` and `tax-filings/` (India's GST record requirement is 72
      months from the annual return due date; 7 years is the common US
      practice), relationship + 7 years for `tax-artist-documents/`. Transition
      to Glacier Instant Retrieval after ~1 year: these are read rarely but must
      be produced quickly when asked for.
- [ ] **Enable versioning** on the bucket if it is not already on. An invoice is
      a statutory record and an accidental overwrite should be recoverable.
- [ ] **Consider a separate KMS key** for `tax-artist-documents/*` and set
      `TAX_S3_KMS_KEY_ID`. The bucket default already encrypts; a separate key
      is worth it for the prefix that holds SSNs.
- [ ] **Scope the IAM policy** so the application role has
      `s3:PutObject`/`s3:GetObject` on the three tax prefixes and any export
      tooling has `s3:GetObject` on `tax-invoices/*` and `tax-filings/*` only.
- [ ] **Set the supplier profile** for each jurisdiction that will be invoiced
      (`TAX_SUPPLIER_IN_GSTIN` is the one that blocks issue).
- [ ] **Seed the rate table** — at minimum a country-default row per
      jurisdiction, or every invoice fails with `TAX_NO_CONFIGURATION`.
