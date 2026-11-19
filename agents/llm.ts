// One place for every model call.
//  - reads prompts/<name>.md  (text above "=== INPUT ===" is the system prompt, text below is the input template)
//  - fills {{variables}}
//  - calls OpenRouter (or any OpenAI-compatible server) and parses the JSON reply
//  - mock mode: no API call, the caller's mock function answers instead (free)

import fs from "node:fs";
import path from "node:path";

// ---------- .env ----------

function loadDotEnv(): void {
  const file = path.join(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

// ---------- settings (read at call time, so scripts can override env after import) ----------

export function settings() {
  const env = process.env;
  const apiKey = env.OPENROUTER_API_KEY || "";
  const mock = env.LLM_MOCK === "1" || (!apiKey && !env.LLM_BASE_URL);
  return {
    apiKey,
    baseUrl: env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
    mock,
    model: env.LLM_MODEL || "openai/gpt-5-mini",
    reasoningEffort: env.LLM_REASONING_EFFORT ?? "low",
    jsonMode: env.LLM_JSON_MODE !== "0",
    maxTokens: Number(env.LLM_MAX_TOKENS || 1500),
    temperature: env.LLM_TEMPERATURE ? Number(env.LLM_TEMPERATURE) : undefined,
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 45_000),
    dryRun: env.LLM_DRY_RUN === "1",
    strict: env.LLM_STRICT === "1",
    priceIn: Number(env.LLM_PRICE_IN || 0.25),
    priceOut: Number(env.LLM_PRICE_OUT || 2.0),
  };
}

export function llmInfo(): { mode: "mock" | "live"; model: string } {
  const s = settings();
  return { mode: s.mock ? "mock" : "live", model: s.mock ? "mock" : s.model };
}

// ---------- usage ----------

export const usage = { calls: 0, mockCalls: 0, promptTokens: 0, completionTokens: 0 };

export function usageSummary(): string {
  const s = settings();
  const cost = (usage.promptTokens / 1e6) * s.priceIn + (usage.completionTokens / 1e6) * s.priceOut;
  return (
    `API calls: ${usage.calls}   mock calls: ${usage.mockCalls}   ` +
    `tokens in/out: ${usage.promptTokens}/${usage.completionTokens}   est. cost: $${cost.toFixed(4)}`
  );
}

// ---------- prompts ----------

export type PromptTemplate = { system: string; user: string };

const promptCache = new Map<string, PromptTemplate>();

export function loadPrompt(name: string): PromptTemplate {
  const cached = promptCache.get(name);
  if (cached && process.env.NODE_ENV === "production") return cached;
  const dir = process.env.PROMPTS_DIR || path.join(process.cwd(), "prompts");
  const file = path.join(dir, `${name}.md`);
  // <!-- comments --> are notes for us and are not sent to the model
  const text = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const parts = text.split(/^===\s*INPUT\s*===\s*$/m);
  const tpl = {
    system: parts[0].trim(),
    user: (parts[1] ?? "Reply with the JSON object only.").trim(),
  };
  promptCache.set(name, tpl);
  return tpl;
}

export function fill(template: string, vars: Record<string, string | number>): string {
  const missing: string[] = [];
  const out = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (vars[key] === undefined) {
      missing.push(key);
      return "";
    }
    return String(vars[key]);
  });
  if (missing.length) throw new Error(`Prompt variables not provided: ${[...new Set(missing)].join(", ")}`);
  return out;
}

/** Pull the first JSON object out of a reply (handles ```json fences and extra words). */
export function extractJSON<T>(raw: string): T {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error("No JSON object in the model reply: " + raw.slice(0, 200));
  }
}

// ---------- the call ----------

export type LLMRecord = { prompt: string; system: string; user: string; raw: string; mocked: boolean; ms: number };
export type CallOpts = { maxTokens?: number; log?: (record: LLMRecord) => void };

async function request(system: string, user: string, maxTokens?: number): Promise<string> {
  const s = settings();
  const body: Record<string, unknown> = {
    model: s.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens ?? s.maxTokens,
  };
  if (s.jsonMode) body.response_format = { type: "json_object" };
  if (s.reasoningEffort) body.reasoning = { effort: s.reasoningEffort };
  if (s.temperature !== undefined) body.temperature = s.temperature;

  const res = await fetch(`${s.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${s.apiKey || "local"}`,
      "Content-Type": "application/json",
      "X-Title": "CrossCheck",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(s.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text) as {
    error?: { message?: string };
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: { finish_reason?: string; message?: { content?: string } }[];
  };
  if (json.error) throw new Error(`LLM error: ${json.error.message ?? text.slice(0, 400)}`);
  usage.calls++;
  usage.promptTokens += json.usage?.prompt_tokens ?? 0;
  usage.completionTokens += json.usage?.completion_tokens ?? 0;
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(
      `Empty reply (finish_reason=${json.choices?.[0]?.finish_reason}). ` +
        "If this is a reasoning model, raise LLM_MAX_TOKENS or lower LLM_REASONING_EFFORT.",
    );
  }
  return content;
}

/**
 * Run one prompt and get its JSON back.
 * `mock` answers instead of the model in mock mode, and is the fallback if the model fails twice
 * (unless LLM_STRICT=1, which the test scripts set so that failures are visible).
 */
export async function callJSON<T>(
  prompt: string,
  vars: Record<string, string | number>,
  mock: () => T,
  opts: CallOpts = {},
): Promise<T> {
  const s = settings();
  const tpl = loadPrompt(prompt);
  const system = fill(tpl.system, vars);
  const user = fill(tpl.user, vars);
  const started = Date.now();
  const done = (data: T, raw: string, mocked: boolean): T => {
    opts.log?.({ prompt, system, user, raw, mocked, ms: Date.now() - started });
    return data;
  };

  if (s.dryRun) {
    console.log(`\n────────── ${prompt} · SYSTEM ──────────\n${system}\n────────── ${prompt} · INPUT ──────────\n${user}\n`);
  }
  if (s.dryRun || s.mock) {
    usage.mockCalls++;
    const data = mock();
    return done(data, JSON.stringify(data), true);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await request(system, user, opts.maxTokens);
      return done(extractJSON<T>(raw), raw, false);
    } catch (err) {
      lastError = err;
    }
  }
  if (s.strict) throw lastError;
  console.error(`[llm] ${prompt} failed twice, using the mock answer instead:`, lastError instanceof Error ? lastError.message : lastError);
  usage.mockCalls++;
  const data = mock();
  return done(data, JSON.stringify(data), true);
}
