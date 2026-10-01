import type { Adapter, AdapterFactoryOptions } from "./types.js";
import type { GenerateRequest, GenerateResponse, Turn } from "../types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * Optional OpenAI-compatible HTTP adapter.
 * Disabled unless WORKSTREAM_API_KEY (or options.apiKey) is set.
 */
export class OpenAIAdapter implements Adapter {
  readonly kind = "openai";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: AdapterFactoryOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
    const apiKey = options.apiKey ?? process.env.WORKSTREAM_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAI adapter requires WORKSTREAM_API_KEY (or apiKey option). Use adapter=mock for offline mode.",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (
      options.baseUrl ??
      process.env.WORKSTREAM_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, "");
    this.model = options.model ?? process.env.WORKSTREAM_MODEL ?? DEFAULT_MODEL;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const messages = this.buildMessages(request);
    const url = `${this.baseUrl}/chat/completions`;

    const res = await fetch(url, {
      signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: request.session.role === "fast" ? 0.2 : 0.5,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `OpenAI-compatible request failed (${res.status}): ${body.slice(0, 400)}`,
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("OpenAI-compatible response missing message content.");
    }

    return {
      content,
      model: data.model ?? this.model,
    };
  }

  private buildMessages(
    request: GenerateRequest,
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const system = [
      `You are a ${request.session.role} workstream agent named "${request.session.name}".`,
      request.session.role === "fast"
        ? "Prefer mechanical, precise execution. Minimize speculation."
        : "Apply careful judgment. Call out risks and tradeoffs.",
      `Original assignment: ${request.session.prompt}`,
    ].join("\n");

    const history = request.history
      .filter((t): t is Turn & { role: "user" | "assistant" } => t.role !== "system")
      .map((t) => ({ role: t.role, content: t.content }));

    return [
      { role: "system", content: system },
      ...history,
      { role: "user", content: request.message },
    ];
  }
}
