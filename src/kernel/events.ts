/**
 * 事件总线，提供五种派发语义。
 *
 * 监听器按事件分组、按注册顺序存放。总线是纯内存结构：
 * 不再需要订阅时由调用方负责 `off` 或 `clear()`。
 */

/**
 * 通用监听器；各派发模式会给出更精确的签名。
 *
 * 这里的 any 是刻意保留的：事件总线承载异构载荷，
 * 类似 DOM `addEventListener` 无法给出完美的泛型约束。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 理由：事件总线处理异构载荷的必要边界
export type Listener = (...args: any[]) => any;

/** `waterfall` 使用的监听器：接收当前值与 `next` 回调。 */
export type WaterfallListener<T> = (
  value: T,
  next: (newValue: T) => void,
) => T | void | Promise<T | void>;

/** 当 waterfall 链路中的监听器既没调用 next 也没返回时抛出。 */
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
   * 订阅监听器。同一个函数注册两次会产生两个独立订阅，
   * 每次 `off` 只移除一个。
   * 返回值是一个便捷的取消订阅函数。
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
   * 移除一个匹配的订阅。
   * 若该监听器未在此事件上注册，则静默无操作。
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

  /** 某事件当前的监听器数量。 */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** 某事件是否有监听器。 */
  has(event: string): boolean {
    return this.listenerCount(event) > 0;
  }

  /** 清空某个事件的订阅（省略参数则清空全部）。 */
  clear(event?: string): void {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
  }

  /**
   * 同步通知。返回值与异常都被刻意忽略——`emit` 是「发出即忘」语义。
   */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.snapshot(event)) {
      try {
        const result = listener(...args);
        // 若监听器返回 Promise，其后续 rejection 会被吞掉，
        // 以免「发出即忘」的派发产生 unhandled rejection。
        if (result && typeof result.then === "function") {
          void result.then(undefined, () => {});
        }
      } catch {
        // emit 不向外传播监听器异常。
      }
    }
  }

  /** 并行执行所有监听器并等待全部完成。 */
  async parallel(event: string, ...args: unknown[]): Promise<unknown[]> {
    return Promise.all(this.snapshot(event).map((l) => l(...args)));
  }

  /** 按注册顺序逐个 await 执行。 */
  async serial(event: string, ...args: unknown[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const listener of this.snapshot(event)) {
      results.push(await listener(...args));
    }
    return results;
  }

  /**
   * 中间件式派发。
   *
   * 每个监听器收到 `(value, next)`，可以：
   *   - 调用 `next(newValue)` 把新值交给下一个监听器；
   *   - `return` 一个值来短路，并以该值结束；
   *   - 完成自身异步工作并调用 `next` 后返回 `void` 以继续链路。
   *
   * 若某个监听器返回 `void` 却从未调用 `next`，视为「卡住」，
   * 抛出 WaterfallStalledError，而不是静默吞掉后续监听器（fail-closed）。
   *
   * 链路走完后返回最后一个值。
   */
  async waterfall<T>(event: string, initialValue: T): Promise<T> {
    const chain = this.snapshot(event) as WaterfallListener<T>[];
    let index = 0;

    /**
     * 从位置 `index` 开始、以 `value` 驱动链路。每次调用恰好执行一个监听器：
     *   - 调用了 next(v)        -> 带着 v 继续下一个监听器
     *   - 返回了值              -> 短路，以该值结束
     *   - 返回 undefined 且没 next -> 卡住，抛错
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
          return result as T; // 短路
        }
        if (nextCalled) {
          value = nextValue;
          continue;
        }
        if (index >= chain.length) {
          // 最后一个监听器未调用 next 就结束了：链路自然收尾，保留当前值。
          return value;
        }
        throw new WaterfallStalledError(event, position);
      }
      return value;
    };

    return run(initialValue);
  }

  /**
   * 按顺序执行监听器，遇到第一个返回「非 undefined」的监听器即停止。
   * 都返回 undefined 时解析为 undefined。
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

  /** 标记总线已销毁；此后任何订阅都会抛错。 */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 复制监听器列表，使监听器在派发过程中增删订阅也安全。 */
  private snapshot(event: string): Listener[] {
    return [...(this.listeners.get(event) ?? [])];
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("EventBus has been disposed");
    }
  }
}
