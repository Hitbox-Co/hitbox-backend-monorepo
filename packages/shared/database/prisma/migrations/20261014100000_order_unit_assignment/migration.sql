-- ============================================================================
-- Order unit assignment (scan-to-assign at packing).
--
-- At checkout an order holds *a* unit of its variant so stock can't be
-- oversold. Which physical unit — which NFC tag — goes into the parcel is
-- decided when a packer scans one at packing. These two columns record that
-- confirmation; until they are set the order's unit is provisional and the
-- order cannot ship.
--
-- Additive and nullable. Existing orders read as "not yet confirmed"; scanning
-- their current unit confirms it.
-- See docs/orders/order-unit-assignment-api.md.
-- ============================================================================

ALTER TABLE "Order" ADD COLUMN "unitAssignedAt" TIMESTAMP(3),
ADD COLUMN "unitAssignedById" UUID;
