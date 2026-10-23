/**
 * 微内核服务上下文（Context）。
 *
 * 职责：
 *   1. 按 key（字符串或 symbol）保存已注册的服务，并提供 `provide` / `resolve`；
 *   2. 记录清理函数（disposer），在 `dispose()` 时按 LIFO（后进先出）逆序执行；
 *   3. 持有本内核的 EventBus，并以 `events` 服务对外暴露。
 *
 * 销毁语义：`dispose()` 会把事件总线留到最后才销毁，这样其它插件在
 * 自身清理阶段仍可以 `emit` 事件，不会出现「监听器已被清空」的时序问题。
 */

import { EventBus } from "./events.js";

/** 服务 key：字符串或 symbol。 */
export type ServiceKey = string | symbol;

/** 清理函数：可同步也可异步。 */
export type Disposer = () => void | Promise<void>;

interface ServiceRecord {
  service: unknown;
  disposer?: Disposer;
}

/** 事件总线在本上下文中的注册 key。 */
export const EVENTS_KEY = "events";

export class Context {
  private readonly services = new Map<ServiceKey, ServiceRecord>();
  private readonly disposers: Disposer[] = [];
  private readonly bus: EventBus;
  private disposed = false;

  constructor() {
    this.bus = new EventBus();
    // 事件总线是一等内核服务：插件可以写 `inject: ["events"]` 直接依赖它。
    // 注意这里「最先注册」=> LIFO 下「最后销毁」，保证其它清理函数执行时总线仍可用。
    this.services.set(EVENTS_KEY, {
      service: this.bus,
      disposer: () => this.bus.dispose(),
    });
  }

  /** 内核事件总线；也可通过 `resolve("events")` 取得。 */
  get events(): EventBus {
    return this.bus;
  }

  // --- EventBus 代理方法（便于插件直接写 ctx.on / ctx.emit）--------------

  /** 订阅事件，返回取消订阅函数。 */
  on(event: string, listener: (...args: any[]) => any): () => void {
    return this.bus.on(event, listener);
  }

  /** 取消某个监听器。 */
  off(event: string, listener: (...args: any[]) => any): void {
    this.bus.off(event, listener);
  }

  /** 同步派发，不等待返回值（fire-and-forget）。 */
  emit(event: string, ...args: unknown[]): void {
    this.bus.emit(event, ...args);
  }

  /** 并行派发，等待全部监听器完成。 */
  parallel(event: string, ...args: unknown[]): Promise<unknown[]> {
    return this.bus.parallel(event, ...args);
  }

  /** 串行派发，按注册顺序逐个 await。 */
  serial(event: string, ...args: unknown[]): Promise<unknown[]> {
    return this.bus.serial(event, ...args);
  }

  /** 中间件式链路派发，支持短路。 */
  waterfall<T>(event: string, initialValue: T): Promise<T> {
    return this.bus.waterfall(event, initialValue);
  }

  /** 遇到第一个返回值非 undefined 的监听器即停止并返回该值。 */
  async bail<T = unknown>(
    event: string,
    ...args: unknown[]
  ): Promise<T | undefined> {
    return this.bus.bail<T>(event, ...args);
  }

  // --- 服务注册与解析 -----------------------------------------------------

  /**
   * 注册服务，并可附带其清理函数。
   * 同一 key 重复注册属于编程错误，直接抛错。
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

  /** 取出服务；未注册则抛错。 */
  resolve<T>(key: ServiceKey): T {
    const record = this.services.get(key);
    if (!record) {
      throw new Error(`Service not registered: ${String(key)}`);
    }
    return record.service as T;
  }

  /** 仅探测服务是否存在，不抛错。 */
  has(key: ServiceKey): boolean {
    return this.services.has(key);
  }

  /**
   * 登记任意副作用清理函数。
   * 执行顺序与注册顺序相反（LIFO），与 `provide` 的清理函数共用同一个栈。
   */
  effect(disposer: Disposer): Disposer {
    this.assertAlive();
    this.disposers.push(disposer);
    return disposer;
  }

  /**
   * 销毁上下文：按 LIFO 逆序执行所有清理函数。
   *
   * - 单个清理函数抛错不会阻断其余清理，最终会把第一个错误重新抛出；
   * - 事件总线在用户清理函数之后才销毁。
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
    // 兜底：无论上面发生什么，都不能留下任何监听器。
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
