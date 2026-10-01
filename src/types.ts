/** Role routing for workstream sessions. */
export type Role = "fast" | "good";

/** Lifecycle status for a session. */
export type SessionStatus =
  | "idle"
  | "running"
  | "waiting"
  | "done"
  | "failed";

/** Adapter backend identifier. */
export type AdapterKind = "mock" | "openai";

/** One conversational turn in a session log. */
export interface Turn {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

/** Persistent session record. */
export interface Session {
  name: string;
  role: Role;
  status: SessionStatus;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
  /** Optional path (relative to workspace) to a delivery-contract criteria file. */
  criteriaFile?: string;
  lastError?: string;
}

/** Workspace-level config written by `ws init`. */
export interface WorkspaceConfig {
  version: 1;
  name: string;
  adapter: AdapterKind;
  createdAt: string;
  /** Default model for OpenAI-compatible adapters. */
  model?: string;
}

/** Result of a delivery-contract check. */
export interface CheckResult {
  session: string;
  ok: boolean;
  criteriaFile?: string;
  missing: string[];
  notes: string[];
}

/** Options for spawning a session. */
export interface SpawnOptions {
  name: string;
  role: Role;
  prompt: string;
  criteriaFile?: string;
  /** If true, invoke the adapter immediately after registering. */
  run?: boolean;
}

/** Adapter generation request. */
export interface GenerateRequest {
  session: Session;
  message: string;
  history: Turn[];
  signal?: AbortSignal;
}

/** Adapter generation response. */
export interface GenerateResponse {
  content: string;
  model?: string;
}
