import { withSessionLock } from "./locking.js";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { Adapter } from "./adapters/index.js";
import { createAdapter } from "./adapters/index.js";
import {
  initWorkspace,
  listSessions,
  loadConfig,
  loadSession,
  saveSession,
  sessionExists,
  StorageError,
} from "./storage.js";
import type {
  CheckResult,
  Role,
  Session,
  SessionStatus,
  SpawnOptions,
  Turn,
  WorkspaceConfig,
} from "./types.js";
import { checkDeliveryContract } from "./check.js";

export interface HarnessOptions {
  cwd?: string;
  /** Inject adapter (tests). */
  adapter?: Adapter;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newTurn(role: Turn["role"], content: string): Turn {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: nowIso(),
  };
}

/**
 * Orchestrates parallel named workstream sessions with local state
 * and a pluggable LLM adapter.
 */
export class Harness {
  readonly cwd: string;
  private adapterOverride?: Adapter;

  constructor(options: HarnessOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.adapterOverride = options.adapter;
  }

  async init(
    name: string,
    options: { adapter?: WorkspaceConfig["adapter"]; model?: string; force?: boolean } = {},
  ): Promise<WorkspaceConfig> {
    return initWorkspace(name, options, this.cwd);
  }

  async config(): Promise<WorkspaceConfig> {
    return loadConfig(this.cwd);
  }

  private async resolveAdapter(): Promise<Adapter> {
    if (this.adapterOverride) return this.adapterOverride;
    const cfg = await loadConfig(this.cwd);
    return createAdapter(cfg.adapter, { model: cfg.model });
  }

  async spawn(options: SpawnOptions): Promise<Session> {
    await loadConfig(this.cwd);
    return withSessionLock(options.name, this.cwd, () => this.spawnUnlocked(options));
  }

  private async spawnUnlocked(options: SpawnOptions): Promise<Session> {
    const { name, role, prompt, criteriaFile, run = true } = options;
    if (await sessionExists(name, this.cwd)) {
      throw new StorageError(
        `Session "${name}" already exists. Use a different --name or send follow-ups with \`ws send\`.`,
      );
    }

    const createdAt = nowIso();
    const session: Session = {
      name,
      role,
      status: "idle",
      prompt,
      createdAt,
      updatedAt: createdAt,
      turns: [newTurn("system", `Spawned as role=${role}. Assignment: ${prompt}`)],
      ...(criteriaFile ? { criteriaFile } : {}),
    };

    await saveSession(session, this.cwd);

    if (run) {
      return this.sendUnlocked(name, prompt);
    }
    return session;
  }

  async send(name: string, message: string, options: { signal?: AbortSignal } = {}): Promise<Session> {
    return withSessionLock(name, this.cwd, () => this.sendUnlocked(name, message, options));
  }

  private async sendUnlocked(name: string, message: string, options: { signal?: AbortSignal } = {}): Promise<Session> {
    const session = await loadSession(name, this.cwd);
    const userTurn = newTurn("user", message);
    session.turns.push(userTurn);
    session.status = "running";
    session.updatedAt = nowIso();
    session.lastError = undefined;
    await saveSession(session, this.cwd);

    try {
      const adapter = await this.resolveAdapter();
      const response = await adapter.generate({
        session,
        message,
        history: session.turns.slice(0, -1),
        signal: options.signal,
      });
      session.turns.push(newTurn("assistant", response.content));
      session.status = "idle";
      session.updatedAt = nowIso();
      await saveSession(session, this.cwd);
      return session;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      session.status = "failed";
      session.lastError = msg;
      session.updatedAt = nowIso();
      await saveSession(session, this.cwd);
      throw err;
    }
  }

  async list(): Promise<Session[]> {
    await loadConfig(this.cwd);
    return listSessions(this.cwd);
  }

  async get(name: string): Promise<Session> {
    return loadSession(name, this.cwd);
  }

  /**
   * Mark a session as waiting, optionally poll until status leaves "waiting"
   * or timeout. Local-state semantics — useful for director loops.
   */
  async wait(
    name: string,
    options: { timeoutMs?: number; pollMs?: number; markOnly?: boolean } = {},
  ): Promise<Session> {
    const session = await this.setStatus(name, "waiting");

    if (options.markOnly) {
      return session;
    }

    const timeoutMs = options.timeoutMs ?? 0;
    const pollMs = options.pollMs ?? 100;

    if (timeoutMs <= 0) {
      return session;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await loadSession(name, this.cwd);
      if (current.status !== "waiting") {
        return current;
      }
      await sleep(pollMs);
    }

    return loadSession(name, this.cwd);
  }

  async setStatus(name: string, status: SessionStatus): Promise<Session> {
    return withSessionLock(name, this.cwd, async () => {
      const session = await loadSession(name, this.cwd);
      session.status = status;
      session.updatedAt = nowIso();
      await saveSession(session, this.cwd);
      return session;
    });
  }

  async status(): Promise<{
    config: WorkspaceConfig;
    sessions: Session[];
    counts: Record<SessionStatus, number>;
  }> {
    const config = await loadConfig(this.cwd);
    const sessions = await listSessions(this.cwd);
    const counts: Record<SessionStatus, number> = {
      idle: 0,
      running: 0,
      waiting: 0,
      done: 0,
      failed: 0,
    };
    for (const s of sessions) {
      counts[s.status] += 1;
    }
    return { config, sessions, counts };
  }

  async check(name?: string, options: { runCommands?: boolean; timeoutMs?: number } = {}): Promise<CheckResult[]> {
    const sessions = name
      ? [await loadSession(name, this.cwd)]
      : await listSessions(this.cwd);
    const results: CheckResult[] = [];
    for (const session of sessions) {
      results.push(await checkDeliveryContract(session, this.cwd, options));
    }
    return results;
  }
}

export function parseRole(value: string): Role {
  if (value === "fast" || value === "good") return value;
  throw new StorageError(`Invalid role "${value}". Expected fast|good.`);
}
