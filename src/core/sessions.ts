/**
 * Session service: a registry of live sessions, plus the factory used by
 * plugins so they never have to reach for the `Session` class directly.
 *
 * Mounted as `ctx.sessions`. Sessions created through the service are tracked
 * and disposed with the kernel; `Session` itself has no timers or handles, so
 * disposal means "forget it", not "tear it down" — the JSONL on disk stays.
 */

import type { Context } from "../kernel/context.js";
import { Session, type SessionOptions } from "./session.js";

export interface SessionServiceOptions {
  /** Default options applied to every session created via `create()`. */
  defaults?: SessionOptions;
  /** Directory to write `<id>.jsonl` files into. Omit for memory-only. */
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

  /** Create a session, register it, and emit `sessions:created`. */
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

  /** Adopt an externally constructed session (e.g. from `Session.load`). */
  register(session: Session): Session {
    this.sessions.set(session.id, session);
    this.ctx.emit(SessionService.CREATED, { sessionId: session.id, session });
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Get a session or throw — for call sites that require an existing one. */
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

  /** Forget a session (the JSONL file is untouched). */
  remove(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** Flush every tracked session's pending writes. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.flush()));
  }
}
