/**
 * Micro-kernel service context.
 *
 * Holds registered services keyed by string / symbol, and records disposers
 * that must run when the kernel shuts down. Disposal is strictly LIFO.
 *
 * Every Context owns an EventBus, exposed as the `events` service and via
 * thin proxy methods. Disposing the Context disposes the bus, so listeners
 * registered through `ctx.on` never outlive the kernel.
 */

import { EventBus } from "./events.js";

export type ServiceKey = string | symbol;

export type Disposer = () => void | Promise<void>;

interface ServiceRecord {
  service: unknown;
  disposer?: Disposer;
}

/** Service key under which the Context's EventBus is registered. */
export const EVENTS_KEY = "events";

export class Context {
  private readonly services = new Map<ServiceKey, ServiceRecord>();
  private readonly disposers: Disposer[] = [];
  private readonly bus: EventBus;
  private disposed = false;

  constructor() {
    this.bus = new EventBus();
    // The bus is a first-class kernel service: plugins can `inject: ["events"]`.
    // Disposing it last (registered first => popped last) keeps it alive for
    // every other disposer, which may still want to emit during teardown.
    this.services.set(EVENTS_KEY, {
      service: this.bus,
      disposer: () => this.bus.dispose(),
    });
  }

  /** The kernel's event bus, also available via `resolve("events")`. */
  get events(): EventBus {
    return this.bus;
  }

  // --- EventBus proxies ---------------------------------------------------

  /** Subscribe to an event; returns an unsubscribe function. */
  on(event: string, listener: (...args: any[]) => any): () => void {
    return this.bus.on(event, listener);
  }

  /** Unsubscribe a previously registered listener. */
  off(event: string, listener: (...args: any[]) => any): void {
    this.bus.off(event, listener);
  }

  /** Fire-and-forget synchronous dispatch. */
  emit(event: string, ...args: unknown[]): void {
    this.bus.emit(event, ...args);
  }

  /** Dispatch to all listeners concurrently. */
  parallel(event: string, ...args: unknown[]): Promise<unknown[]> {
    return this.bus.parallel(event, ...args);
  }

  /** Dispatch to listeners one at a time. */
  serial(event: string, ...args: unknown[]): Promise<unknown[]> {
    return this.bus.serial(event, ...args);
  }

  /** Middleware-style chain with short-circuit support. */
  waterfall<T>(event: string, initialValue: T): Promise<T> {
    return this.bus.waterfall(event, initialValue);
  }

  /** Stop at the first listener returning a non-undefined value. */
  async bail<T = unknown>(
    event: string,
    ...args: unknown[]
  ): Promise<T | undefined> {
    return this.bus.bail<T>(event, ...args);
  }

  // --- Services -----------------------------------------------------------

  /**
   * Register a service and (optionally) a disposer for it.
   * A service may not be registered twice — that is a programming error.
   */
  provide<T>(key: ServiceKey, service: T, disposer?: Disposer): T {
    this.assertAlive();
    if (this.services.has(key)) {
      throw new Error(`Service already provided: ${String(key)}`);
    }
    this.services.set(key, { service, disposer });
    if (disposer) {
      this.disposers.push(disposer);
    }
    return service;
  }

  /** Resolve a previously provided service, or throw if missing. */
  resolve<T>(key: ServiceKey): T {
    const record = this.services.get(key);
    if (!record) {
      throw new Error(`Service not registered: ${String(key)}`);
    }
    return record.service as T;
  }

  /** Non-throwing variant of resolve. */
  has(key: ServiceKey): boolean {
    return this.services.has(key);
  }

  /**
   * Record an arbitrary side effect that must be undone on dispose.
   * Ordering is the registration order; dispose() runs them in reverse.
   */
  effect(disposer: Disposer): Disposer {
    this.assertAlive();
    this.disposers.push(disposer);
    return disposer;
  }

  /**
   * Run every recorded disposer in reverse (LIFO) order.
   * All disposers are attempted even if some throw; the first error is
   * rethrown afterwards so callers can still see the failure.
   *
   * The EventBus is disposed last, after user disposers have run.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const errors: unknown[] = [];
    while (this.disposers.length > 0) {
      const disposer = this.disposers.pop() as Disposer;
      try {
        await disposer();
      } catch (err) {
        errors.push(err);
      }
    }
    // Belt and braces: whatever happened above, no listener may survive.
    this.bus.dispose();
    this.services.clear();

    if (errors.length > 0) {
      throw errors[0];
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("Context has already been disposed");
    }
  }
}
