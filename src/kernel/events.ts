/**
 * Event bus with five dispatch semantics.
 *
 * Listeners are stored per event in registration order. The bus is purely
 * in-memory: callers are responsible for calling `off` (or `clear()`) when
 * they no longer need a subscription.
 */

/** Generic listener; each dispatch mode narrows this to its own shape. */
export type Listener = (...args: any[]) => any;

/** Listener used by `waterfall`: receives the current value and a `next`. */
export type WaterfallListener<T> = (
  value: T,
  next: (newValue: T) => void,
) => T | void | Promise<T | void>;

/** Thrown when a `waterfall` listener neither calls `next` nor completes. */
export class WaterfallStalledError extends Error {
  constructor(
    public readonly event: string,
    public readonly index: number,
  ) {
    super(
      `Waterfall "${event}" stalled at listener #${index}: it returned without calling next()`,
    );
    this.name = "WaterfallStalledError";
  }
}

export class EventBus {
  private readonly listeners = new Map<string, Listener[]>();
  private disposed = false;

  /**
   * Subscribe a listener. Registering the same function twice creates two
   * independent subscriptions; each matching `off` call removes one.
   * Returns an unsubscribe function for convenience.
   */
  on(event: string, listener: Listener): () => void {
    this.assertAlive();
    const list = this.listeners.get(event);
    if (list) {
      list.push(listener);
    } else {
      this.listeners.set(event, [listener]);
    }
    return () => void this.off(event, listener);
  }

  /**
   * Remove one matching subscription. A no-op when the listener is not
   * registered for that event.
   */
  off(event: string, listener: Listener): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index === -1) return;
    list.splice(index, 1);
    if (list.length === 0) {
      this.listeners.delete(event);
    }
  }

  /** Number of listeners registered for an event. */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** Whether anything listens to an event. */
  has(event: string): boolean {
    return this.listenerCount(event) > 0;
  }

  /** Drop every subscription for one event (or all events when omitted). */
  clear(event?: string): void {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
  }

  /**
   * Synchronous notification. Return values and rejections are deliberately
   * ignored — `emit` is fire-and-forget.
   */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.snapshot(event)) {
      try {
        const result = listener(...args);
        // A listener that returns a promise could reject later; swallow it so
        // fire-and-forget dispatch never produces unhandled rejections.
        if (result && typeof result.then === "function") {
          void result.then(undefined, () => {});
        }
      } catch {
        // emit does not propagate listener errors.
      }
    }
  }

  /** Run every listener concurrently and wait for all of them. */
  async parallel(event: string, ...args: unknown[]): Promise<unknown[]> {
    return Promise.all(this.snapshot(event).map((l) => l(...args)));
  }

  /** Run listeners one at a time, in registration order. */
  async serial(event: string, ...args: unknown[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const listener of this.snapshot(event)) {
      results.push(await listener(...args));
    }
    return results;
  }

  /**
   * Middleware-style dispatch.
   *
   * Each listener receives `(value, next)`. It may:
   *   - call `next(newValue)` to hand a new value to the following listener;
   *   - `return` a value to short-circuit and resolve with that value;
   *   - `return void` *after* awaiting its own async work and calling `next`
   *     to continue the chain.
   *
   * A listener that returns `void` without ever calling `next` is treated as
   * stalled and rejects with WaterfallStalledError rather than silently
   * dropping the remaining listeners.
   *
   * When the chain runs out, the last value is returned.
   */
  async waterfall<T>(event: string, initialValue: T): Promise<T> {
    const chain = this.snapshot(event) as WaterfallListener<T>[];
    let index = 0;

    /**
     * Drive the chain from position `index` with `value`. Each call invokes
     * exactly one listener and interprets its outcome:
     *   - `next(v)` was called  -> continue with the next listener and `v`
     *   - returns a value       -> short-circuit, resolve with it
     *   - returns undefined,
     *     never called next     -> stalled: reject
     */
    const run = async (value: T): Promise<T> => {
      while (index < chain.length) {
        const position = index;
        const listener = chain[position] as WaterfallListener<T>;
        index = position + 1;

        let nextCalled = false;
        let nextValue: T = value;
        const next = (newValue: T): void => {
          nextCalled = true;
          nextValue = newValue;
        };

        const result = await listener(value, next);

        if (result !== undefined) {
          return result as T; // short-circuit
        }
        if (nextCalled) {
          value = nextValue;
          continue;
        }
        if (index >= chain.length) {
          // Last listener finished without calling next: the chain simply
          // ends, keeping the current value.
          return value;
        }
        throw new WaterfallStalledError(event, position);
      }
      return value;
    };

    return run(initialValue);
  }

  /**
   * Run listeners in order and stop at the first one that returns something
   * other than `undefined`. Resolves to that value, or `undefined` when every
   * listener returned `undefined`.
   */
  async bail<T = unknown>(event: string, ...args: unknown[]): Promise<T | undefined> {
    for (const listener of this.snapshot(event)) {
      const result = await listener(...args);
      if (result !== undefined) {
        return result as T;
      }
    }
    return undefined;
  }

  /** Mark the bus disposed; any further subscription throws. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Copy the list so listeners may (un)subscribe during dispatch safely. */
  private snapshot(event: string): Listener[] {
    return [...(this.listeners.get(event) ?? [])];
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("EventBus has been disposed");
    }
  }
}
