/**
 * @hitbox/orders
 *
 * The purchase record: order listing, full order detail with its serialized
 * SKU units, and the fulfilment status transitions.
 *
 * Money movement is the payments module and margin postings are finance —
 * this module owns only the order's own lifecycle and the stock it holds.
 *
 * Two things the list deliberately resolves at the database rather than
 * returning ids for: the buyer's **email** and the product's **groupCode**.
 * An operator scanning the table is looking for a person and a drop, and a
 * pair of UUIDs answers neither without a second lookup.
 */

export { createOrdersModule } from './module';
export type { OrdersModule, OrdersModuleDeps, OrdersPermissionGuard } from './module';

export {
    ORDER_BUYER_CAPABILITY,
    ORDER_EVENTS,
    ORDER_MONEY_CAPABILITY,
    ORDER_READ_CAPABILITY,
    ORDER_WRITE_CAPABILITY,
    ORDERS_ERROR_CODES,
    ORDERS_MODULE,
} from './constants/orders.constant';

// The lifecycle graph — exported so a UI can render the same rule the API
// enforces instead of keeping a second copy of it.
export {
    ADMIN_SETTABLE_STATUSES,
    ORDER_STATUS_TRANSITIONS,
    canTransition,
} from './domain/order-status';

export { changeOrderStatusSchema, listOrdersQuerySchema } from './dto/order.dto';
export type {
    ChangeOrderStatusDto,
    ListOrdersQuery,
    OrderAddressView,
    OrderDetail,
    OrderListItem,
    OrderSkuUnit,
} from './dto/order.dto';

export type { OrderCallerResolver } from './controller/order.controller';
export type { OrderService, OrderView } from './service/order.service';
