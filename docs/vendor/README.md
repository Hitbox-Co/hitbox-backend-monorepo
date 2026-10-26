# Vendor Portal

Vendors (the factories that make our figures, jerseys, cards… with the NFC chip
already inside) can now **sign in** and record their own supply, instead of
HitBox staff typing it in for them.

| Doc | Read it if you are… |
|---|---|
| [vendor-onboarding-flow.md](vendor-onboarding-flow.md) | Anyone — the whole flow end to end: add vendor → invite → set password → assign drops → vendor books supply → HitBox accepts |
| [vendor-admin-api.md](vendor-admin-api.md) | Building the **admin console** screens: invite/revoke vendor users, assign/unassign drops |
| [vendor-portal-api.md](vendor-portal-api.md) | Building the **vendor portal** itself: profile, my drops, my consignments, chip manifest upload |

Related, unchanged and still the reference for everything staff-side:
[admin/supply-inventory-api.md](../admin/supply-inventory-api.md) (vendors,
consignments, chip manifest, QC, metrics).

## The flow in one picture

```
 System Admin (admin console)                         Vendor user
 ────────────────────────────                         ───────────
 1. POST /admin/supply/vendors                 (create the vendor record)
 2. POST /admin/supply/vendors/:id/members     ──email──▶ 3. Clerk sign-up link
                                                           sets their password
                                                           → account created
                                                           → VENDOR role granted
                                                           → member ACTIVE
 4. POST /admin/supply/vendors/:id/drops       (assign drop + allot per variant:
                                                Red/S 100 · Red/M 100 · Red/L 100)
                                                        5. GET  /vendor/me, /vendor/drops
                                                           (allotted / booked / remaining per variant)
                                                        6. POST /vendor/batches          (qty per variant; may
                                                           exceed the allotment — flagged)
 7. POST /admin/supply/batches/:id/decision    {status: VALIDATED}
                                                        8. POST /vendor/batches/:id/tags (chip UIDs, one per
                                                           product, each naming its variant — CSV in examples/)
 9. POST /admin/supply/batches/:id/decision    {status: ACCEPTED} — needs every unit chipped
    (PATCH …/drops/:dropId/allotment first        and the allotment covering it; then mints one
     if over the allotment)                       SKU per good chip into the drop, bound to it
```

## Rules that hold everywhere

- **One account acts for one vendor.** Which vendor is never sent by the
  client — it is read from the caller's membership on every request.
- **A vendor supplies only its assigned drops.** Checked when a consignment is
  booked *and* again when a manifest is registered, so unassigning a drop stops
  further uploads immediately.
- **Supply is variant-wise.** A drop with variants is allotted per variant;
  consignments are split into per-variant lines; every chip names the variant
  of the product it's embedded in.
- **Over-supply is booked, not accepted.** A vendor may book beyond its
  allotment; HitBox accepts it only after raising the allotment.
- **Accept / reject stays with HitBox.** A vendor books supply in; it never
  decides it. Chips are uploaded only after HitBox **validates**, and an
  **accept** needs every unit chipped. It then mints the units into the drop,
  so they show up in its SKU list and availability.
- **Revoking a member closes the portal on the next request.**

## Where the code lives

| Piece | Path |
|---|---|
| Schema (`VendorMember`, `VendorDropAssignment`, `VendorVariantAllotment`, `SupplyBatchLine`, `NfcTag.variantId`) | `packages/supply/prisma/supply.prisma` |
| Migrations | `…/migrations/20261025100000_vendor_portal/`, `…/20261025120000_vendor_variant_allotments/` |
| Allotment rules (shape, caps, progress) | `packages/supply/src/service/allotment.ts` |
| VENDOR role + `vendor-supply:*` permissions | `packages/access-control/src/domain/{role,permission}-catalog.ts` |
| Admin service (members, drop assignments) | `packages/supply/src/service/vendor-admin.service.ts` |
| Portal service (vendor self-service) | `packages/supply/src/service/vendor-portal.service.ts` |
| Routes | `packages/supply/src/module.ts` (`createRouter`, `createVendorRouter`) |
| Invitation adapter (VENDOR role → staff invitation) | `apps/backend/src/bootstrap.ts` |
| Tests | `packages/supply/tests/vendor-portal.test.ts` |
