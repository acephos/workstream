import type { GenerateRequest, GenerateResponse } from "../types.js";

/** Pluggable LLM backend for workstream sessions. */
export interface Adapter {
  readonly kind: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}

export interface AdapterFactoryOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}
