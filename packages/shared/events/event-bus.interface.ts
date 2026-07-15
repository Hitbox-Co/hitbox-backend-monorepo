export type EventHandler<T = unknown> = (payload: T) => Promise<void> | void;

export interface Subscription {
    unsubscribe(): void;
}

/**
 *
 * Today:      InProcessEventBus (same Node.js process, zero infrastructure)
 * Tomorrow:   RedisEventBus / RabbitMqEventBus / KafkaEventBus implementing
 *             this exact interface + a transactional outbox for reliability.
 *
 * publish() is already async and handlers are already written to be
 * idempotent-ish and failure-isolated, swapping the implementation does not
 * touch a single feature module. This interface IS the microservice
 * migration path for inter-module communication.
 */
export interface IEventBus {
    publish<T>(event: string, payload: T): Promise<void>;
    subscribe<T>(event: string, handler: EventHandler<T>): Subscription;
}
