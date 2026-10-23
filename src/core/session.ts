/**
 * Session: event-sourced conversation state.
 *
 * The only source of truth is an append-only JSONL log. Nothing derived (such
 * as the LLM message list) is ever mutated in place: it is recomputed by
 * folding the log, so the projection can always be rebuilt from scratch.
 *
 * Log format: one JSON object per line, each with at least `type` and `seq`.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assistantMessageFrom,
  type Message,
  type ToolCall,
  type ToolResult,
} from "./llm.js";

// --- Event types ----------------------------------------------------------

export interface SessionEventBase {
  /** Monotonic sequence number, assigned by the session. */
  seq: number;
  /** Wall-clock time in ms. */
  ts: number;
  type: string;
}

export interface SessionCreatedEvent extends SessionEventBase {
  type: "session.created";
  sessionId: string;
  title?: string;
}

export interface UserMessageEvent extends SessionEventBase {
  type: "message.user";
  content: string;
}

export interface SystemMessageEvent extends SessionEventBase {
  type: "message.system";
  content: string;
}

export interface AssistantMessageEvent extends SessionEventBase {
  type: "message.assistant";
  content?: string;
  toolCalls?: ToolCall[];
}

export interface ToolResultEvent extends SessionEventBase {
  type: "tool.result";
  tool: ToolResult;
}

export interface ProviderChangedEvent extends SessionEventBase {
  type: "llm.provider-changed";
  provider?: string;
}

/** Escape hatch so applications can log domain events on the same timeline. */
export interface CustomEvent extends SessionEventBase {
  type: string;
  [key: string]: unknown;
}

export type AnySessionEvent = { seq: number; ts: number; type: string } & Record<
  string,
  unknown
>;

/** Events that project into LLM messages. */
export type MessageEvent =
  | UserMessageEvent
  | SystemMessageEvent
  | AssistantMessageEvent
  | ToolResultEvent;

// --- Options --------------------------------------------------------------

export interface SessionOptions {
  /** Explicit id; otherwise generated. */
  id?: string;
  title?: string;
  /** Optional JSONL file to mirror every append into. */
  file?: string;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Whether to record the `session.created` event. Defaults to true. */
  emitCreated?: boolean;
}

// --- Session --------------------------------------------------------------

export class Session {
  readonly id: string;
  readonly title?: string;

  private readonly events: AnySessionEvent[] = [];
  private readonly file?: string;
  private readonly now: () => number;
  /** Serialises file writes so concurrent appends cannot interleave lines. */
  private writeChain: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(options: SessionOptions = {}) {
    this.id = options.id ?? generateId();
    this.title = options.title;
    this.file = options.file;
    this.now = options.now ?? (() => Date.now());

    if (options.emitCreated !== false) {
      this.append({ type: "session.created", sessionId: this.id, ...(this.title !== undefined ? { title: this.title } : {}) });
    }
  }

  /**
   * Append one event.
   *
   * `seq` and `ts` are stamped by the session and override anything the caller
   * passes, so the log stays internally consistent. Returns the stored event.
   */
  append<T extends { type: string }>(event: T): T & { seq: number; ts: number } {
    if (!event || typeof event.type !== "string" || event.type.length === 0) {
      throw new Error("Session event requires a non-empty `type`");
    }
    const stored = {
      ...event,
      seq: this.seq++,
      ts: this.now(),
    } as T & { seq: number; ts: number };

    this.events.push(stored as unknown as AnySessionEvent);

    if (this.file) {
      const line = JSON.stringify(stored) + "\n";
      this.writeChain = this.writeChain.then(async () => {
        await mkdir(dirname(this.file as string), { recursive: true });
        await appendFile(this.file as string, line, "utf8");
      });
    }
    return stored;
  }

  /** Convenience wrappers for the common event kinds. */
  appendUserMessage(content: string): UserMessageEvent {
    return this.append({ type: "message.user", content }) as UserMessageEvent;
  }

  appendSystemMessage(content: string): SystemMessageEvent {
    return this.append({ type: "message.system", content }) as SystemMessageEvent;
  }

  appendAssistantMessage(
    content: string | undefined,
    toolCalls: ToolCall[] = [],
  ): AssistantMessageEvent {
    const event: { type: "message.assistant"; content?: string; toolCalls?: ToolCall[] } = {
      type: "message.assistant",
    };
    if (content !== undefined) event.content = content;
    if (toolCalls.length > 0) event.toolCalls = toolCalls;
    return this.append(event) as AssistantMessageEvent;
  }

  appendToolResult(tool: ToolResult): ToolResultEvent {
    return this.append({ type: "tool.result", tool }) as ToolResultEvent;
  }

  /** All events, in append order. */
  get log(): readonly AnySessionEvent[] {
    return this.events;
  }

  get length(): number {
    return this.events.length;
  }

  /** The JSONL representation of everything logged so far. */
  toJSONL(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : "");
  }

  /** Wait for pending file writes to land. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Fold the log into the message list sent to the LLM.
   *
   * Rules:
   *   - `message.user` / `message.system` become user/system messages;
   *   - `message.assistant` becomes an assistant message (tool calls kept);
   *   - `tool.result` becomes a `tool` message referencing its call id;
   *   - every other event type is ignored.
   *
   * Consecutive system messages are preserved (the caller may hoist them).
   */
  deriveMessages(): Message[] {
    return this.events.reduce<Message[]>((messages, event) => {
      const projected = projectEvent(event);
      if (projected) messages.push(projected);
      return messages;
    }, []);
  }

  // --- Persistence --------------------------------------------------------

  /** Write the whole log to `file`, replacing its contents. */
  async persist(file = this.file): Promise<string> {
    if (!file) {
      throw new Error("persist() requires a target file path");
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, this.toJSONL(), "utf8");
    return file;
  }

  /**
   * Rebuild a session from a JSONL file. Events already on disk are kept
   * verbatim (their seq/ts are not re-stamped) and the sequence counter
   * continues after the highest existing `seq`.
   */
  static async load(file: string, options: Omit<SessionOptions, "file"> = {}): Promise<Session> {
    const content = await readFile(file, "utf8");
    const rawEvents = parseJsonl(content);

    // The log is the source of truth: recover identity from `session.created`
    // rather than minting a fresh id on every load. Explicit options win.
    const meta = readSessionMeta(rawEvents);
    const session = new Session({
      ...options,
      id: options.id ?? meta.id,
      title: options.title ?? meta.title,
      file,
      emitCreated: false,
    });
    session.restore(rawEvents);
    return session;
  }

  /** Restore from an array of raw events (already-parsed JSONL records). */
  restore(rawEvents: unknown[]): void {
    let maxSeq = -1;
    for (const raw of rawEvents) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as AnySessionEvent;
      if (typeof event.type !== "string") continue;
      this.events.push(event);
      if (typeof event.seq === "number" && event.seq > maxSeq) maxSeq = event.seq;
    }
    this.seq = maxSeq + 1;
  }
}

// --- Projection -----------------------------------------------------------

function projectEvent(event: AnySessionEvent): Message | undefined {
  switch (event.type) {
    case "message.user":
      return { role: "user", content: String(event.content ?? "") };

    case "message.system":
      return { role: "system", content: String(event.content ?? "") };

    case "message.assistant": {
      const message: Message = { role: "assistant" };
      if (typeof event.content === "string" && event.content.length > 0) {
        message.content = event.content;
      }
      if (Array.isArray(event.toolCalls) && event.toolCalls.length > 0) {
        message.toolCalls = event.toolCalls as ToolCall[];
      }
      if (message.content === undefined && message.toolCalls === undefined) {
        message.content = "";
      }
      return message;
    }

    case "tool.result": {
      const tool = event.tool as ToolResult | undefined;
      if (!tool) return undefined;
      return { role: "tool", tool };
    }

    default:
      // session.created, llm.provider-changed, custom events: not messages.
      return undefined;
  }
}

/** Turn a `GenerateResult` into message event payloads. */
export function assistantEventsFrom(result: {
  text: string;
  toolCalls: ToolCall[];
}): Array<{ type: "message.assistant"; content?: string; toolCalls?: ToolCall[] }> {
  const message = assistantMessageFrom({
    text: result.text,
    toolCalls: result.toolCalls,
    finishReason: result.toolCalls.length ? "tool_calls" : "stop",
    provider: "session",
  });
  // Skip empty assistant turns entirely: they add noise to the log.
  if (!message.content && !message.toolCalls) return [];
  return [
    {
      type: "message.assistant",
      ...(message.content !== undefined ? { content: message.content } : {}),
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    },
  ];
}

// --- Helpers --------------------------------------------------------------

/** Recover session identity from the first `session.created` event. */
function readSessionMeta(rawEvents: unknown[]): {
  id?: string;
  title?: string;
} {
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    if (event.type !== "session.created") continue;
    const id = typeof event.sessionId === "string" ? event.sessionId : undefined;
    const title = typeof event.title === "string" ? event.title : undefined;
    return { id, title };
  }
  return {};
}

function parseJsonl(content: string): unknown[] {
  const out: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A torn final line (crash mid-write) is skipped rather than fatal:
      // the rest of the durable log is still recoverable.
      continue;
    }
  }
  return out;
}

let idCounter = 0;
function generateId(): string {
  idCounter++;
  return `sess_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}
