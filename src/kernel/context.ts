/**
 * Micro-kernel service context.
 *
 * Holds registered services keyed by string / symbol, and records disposers
 * that must run when the kernel shuts down. Disposal is strictly LIFO.
 */

export type ServiceKey = string | symbol;

export type Disposer = () => void | Promise<void>;

interface ServiceRecord {
  service: unknown;
  disposer?: Disposer;
}

export class Context {
  private readonly services = new Map<ServiceKey, ServiceRecord>();
  private readonly disposers: Disposer[] = [];
  private disposed = false;

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
