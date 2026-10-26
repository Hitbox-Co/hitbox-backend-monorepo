-- The buyer cancelling their own unpaid order (docs/orders/buyer-orders-api.md).
ALTER TYPE "OrderStatusSource" ADD VALUE IF NOT EXISTS 'BUYER';
