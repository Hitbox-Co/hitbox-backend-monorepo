import { createModuleLogger } from '../logger';
import { InProcessEventBus } from './in-process-event-bus';
import type { IEventBus } from './event-bus.interface';

export type { EventHandler, IEventBus, Subscription } from './event-bus.interface';
export { InProcessEventBus } from './in-process-event-bus';

/**
 * The bus every module imports. To move to Redis/RabbitMQ later, change this
 * ONE line to instantiate the broker-backed implementation — feature modules
 * are untouched.
 */
export const eventBus: IEventBus = new InProcessEventBus(createModuleLogger('event-bus'));
