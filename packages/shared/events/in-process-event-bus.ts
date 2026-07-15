import type { Logger } from 'pino';
import type { EventHandler, IEventBus, Subscription } from './event-bus.interface';

/**
 * In-memory event bus for the modular-monolith phase.
 *
 *  - handlers run asynchronously; the publisher is NEVER blocked by them
 *  - a throwing handler is logged and isolated — it cannot fail the publisher
 *    or other subscribers
 *  - no ordering guarantees across events, at-most-once delivery (a broker
 *    upgrade later gives you at-least-once + retries; write handlers
 *    idempotently from day one)
 */
export class InProcessEventBus implements IEventBus {
    private readonly handlers = new Map<string, Set<EventHandler>>();

    constructor(private readonly logger: Logger) { }

    async publish<T>(event: string, payload: T): Promise<void> {
        const subscribers = this.handlers.get(event);
        if (!subscribers || subscribers.size === 0) {
            this.logger.debug({ event }, 'event published with no subscribers');
            return;
        }

        // Fire handlers on the next tick so the publisher's request/transaction
        // finishes first — mimicking broker behavior.
        for (const handler of subscribers) {
            setImmediate(() => {
                Promise.resolve()
                    .then(() => handler(payload))
                    .catch((error: unknown) => {
                        this.logger.error({ err: error, event }, 'event handler failed');
                    });
            });
        }

        this.logger.debug({ event, subscribers: subscribers.size }, 'event published');
    }

    subscribe<T>(event: string, handler: EventHandler<T>): Subscription {
        const set = this.handlers.get(event) ?? new Set<EventHandler>();
        set.add(handler as EventHandler);
        this.handlers.set(event, set);

        return {
            unsubscribe: () => {
                set.delete(handler as EventHandler);
            },
        };
    }
}
