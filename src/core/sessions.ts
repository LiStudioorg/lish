/**
 * 会话服务：活跃会话的注册表，同时也是创建会话的工厂，
 * 这样插件无需直接依赖 `Session` 类。
 *
 * 以 `ctx.sessions` 挂载。通过本服务创建的会话会被登记，并随内核一起销毁；
 * `Session` 本身不持有定时器或文件句柄，所以「销毁」等同于「忘掉它」，
 * 磁盘上的 JSONL 文件不受影响。
 */

import type { Context } from "../kernel/context.js";
import { Session, type SessionOptions } from "./session.js";

export interface SessionServiceOptions {
  /** 通过 `create()` 创建会话时应用的默认选项。 */
  defaults?: SessionOptions;
  /** 写入 `<id>.jsonl` 的目录；省略则纯内存运行。 */
  dir?: string;
}

export class SessionService {
  static readonly KEY = "sessions";
  static readonly CREATED = "sessions:created";

  private readonly sessions = new Map<string, Session>();
  private readonly ctx: Context;
  private readonly options: SessionServiceOptions;

  constructor(ctx: Context, options: SessionServiceOptions = {}) {
    this.ctx = ctx;
    this.options = options;
  }

  /** 创建并登记一个会话，同时发出 `sessions:created` 事件。 */
  create(options: SessionOptions = {}): Session {
    const merged: SessionOptions = {
      ...this.options.defaults,
      ...options,
    };
    if (!merged.file && this.options.dir) {
      const provisionalTitle = merged.id ?? `sess_${Date.now().toString(36)}`;
      merged.file = `${this.options.dir}/${provisionalTitle}.jsonl`;
    }

    const session = new Session(merged);
    this.sessions.set(session.id, session);
    this.ctx.emit(SessionService.CREATED, { sessionId: session.id, session });
    return session;
  }

  /** 接管一个在外部构造好的会话（例如来自 `Session.load`）。 */
  register(session: Session): Session {
    this.sessions.set(session.id, session);
    this.ctx.emit(SessionService.CREATED, { sessionId: session.id, session });
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** 取会话，不存在则抛错——用于「必须已存在」的调用点。 */
  require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return session;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }

  get size(): number {
    return this.sessions.size;
  }

  /** 忘记一个会话（磁盘上的 JSONL 文件保持不变）。 */
  remove(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** 冲洗所有已登记会话的待写入数据。 */
  async flushAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.flush()));
  }
}
