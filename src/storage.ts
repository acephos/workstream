import { mkdir, readFile, readdir, rename, writeFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Session, WorkspaceConfig } from "./types.js";

export const WORKSTREAM_DIR = ".workstream";
export const CONFIG_FILE = "config.json";
export const SESSIONS_DIR = "sessions";

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export function resolveWorkstreamRoot(cwd: string = process.cwd()): string {
  return path.resolve(cwd, WORKSTREAM_DIR);
}

export function resolveConfigPath(cwd: string = process.cwd()): string {
  return path.join(resolveWorkstreamRoot(cwd), CONFIG_FILE);
}

export function resolveSessionsDir(cwd: string = process.cwd()): string {
  return path.join(resolveWorkstreamRoot(cwd), SESSIONS_DIR);
}

export function resolveSessionPath(name: string, cwd: string = process.cwd()): string {
  assertSessionName(name);
  return path.join(resolveSessionsDir(cwd), `${name}.json`);
}

const SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function assertSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new StorageError(
      `Invalid session name "${name}". Use 1–64 chars: letters, digits, . _ - (must start alphanumeric).`,
    );
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(tmp, filePath);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function workspaceExists(cwd: string = process.cwd()): Promise<boolean> {
  return exists(resolveConfigPath(cwd));
}

export async function initWorkspace(
  name: string,
  options: { adapter?: WorkspaceConfig["adapter"]; model?: string; force?: boolean } = {},
  cwd: string = process.cwd(),
): Promise<WorkspaceConfig> {
  const root = resolveWorkstreamRoot(cwd);
  const configPath = resolveConfigPath(cwd);

  if ((await exists(configPath)) && !options.force) {
    throw new StorageError(
      `Workspace already initialized at ${root}. Pass --force to overwrite config.`,
    );
  }

  const config: WorkspaceConfig = {
    version: 1,
    name,
    adapter: options.adapter ?? "mock",
    createdAt: new Date().toISOString(),
    ...(options.model ? { model: options.model } : {}),
  };

  await mkdir(resolveSessionsDir(cwd), { recursive: true });
  await writeJsonAtomic(configPath, config);
  return config;
}

export async function loadConfig(cwd: string = process.cwd()): Promise<WorkspaceConfig> {
  const configPath = resolveConfigPath(cwd);
  if (!(await exists(configPath))) {
    throw new StorageError(
      `No workstream workspace found in ${cwd}. Run \`ws init\` first.`,
    );
  }
  return readJson<WorkspaceConfig>(configPath);
}

export async function saveConfig(
  config: WorkspaceConfig,
  cwd: string = process.cwd(),
): Promise<void> {
  await writeJsonAtomic(resolveConfigPath(cwd), config);
}

export async function loadSession(
  name: string,
  cwd: string = process.cwd(),
): Promise<Session> {
  const filePath = resolveSessionPath(name, cwd);
  if (!(await exists(filePath))) {
    throw new StorageError(`Session "${name}" not found.`);
  }
  return readJson<Session>(filePath);
}

export async function saveSession(
  session: Session,
  cwd: string = process.cwd(),
): Promise<void> {
  assertSessionName(session.name);
  await writeJsonAtomic(resolveSessionPath(session.name, cwd), session);
}

export async function listSessions(cwd: string = process.cwd()): Promise<Session[]> {
  const dir = resolveSessionsDir(cwd);
  if (!(await exists(dir))) {
    return [];
  }
  const entries = await readdir(dir);
  const sessions: Session[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const session = await readJson<Session>(path.join(dir, entry));
      sessions.push(session);
    } catch {
      throw new StorageError(`Cannot read session ${entry}; repair or restore the corrupt file.`);
    }
  }
  sessions.sort((a, b) => a.name.localeCompare(b.name));
  return sessions;
}

export async function sessionExists(
  name: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  return exists(resolveSessionPath(name, cwd));
}
