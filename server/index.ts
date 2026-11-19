// A small HTTP API in front of agents/meeting.ts, so the web UI can be built in any stack.
// Rooms live in memory and are lost on restart. There is no login: the client sends its user name.
// Full reference with examples: docs/api.md
//
//   npm run dev:api      -> http://localhost:8787

import http from "node:http";
import { Meeting } from "../agents/meeting";
import { llmInfo } from "../agents/llm";

const PORT = Number(process.env.PORT || 8787);
const TICK_MS = 5_000;
const rooms = new Map<string, Meeting>();

type Body = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v : "");

const logFailure = (err: unknown) => console.error("[agent work failed]", err instanceof Error ? err.message : err);

/**
 * Agent work runs in the background, and the UI sees the result on its next poll of /view.
 * Input checks ("not joined", "empty message", ...) throw before the first await inside Meeting,
 * so they surface here right away and become a 400 for the caller.
 */
async function run(job: Promise<void>): Promise<{ ok: true }> {
  await Promise.race([job, Promise.resolve()]);
  job.catch(logFailure);
  return { ok: true };
}

async function route(method: string, path: string, query: URLSearchParams, body: Body): Promise<unknown> {
  if (method === "GET" && path === "/") {
    return { name: "CrossCheck API", llm: llmInfo(), rooms: rooms.size, docs: "docs/api.md" };
  }
  if (method === "POST" && path === "/rooms") {
    const meeting = new Meeting({ goal: text(body.goal), host: text(body.host) });
    rooms.set(meeting.id, meeting);
    return { roomId: meeting.id };
  }

  const m = path.match(/^\/rooms\/([\w-]+)\/(.+)$/);
  if (!m) throw new HttpError(404, "Unknown endpoint");
  const meeting = rooms.get(m[1]);
  if (!meeting) throw new HttpError(404, "Room not found (rooms are lost when the server restarts)");
  const action = `${method} ${m[2]}`;
  const user = text(body.user) || query.get("user") || "";

  switch (action) {
    case "POST join":
      meeting.join(user);
      return { ok: true };
    case "GET view":
      return meeting.view(user);
    case "GET trace":
      return meeting.trace;
    case "POST group":
      return run(meeting.postGroupMessage(user, text(body.text)));
    case "POST private":
      return run(meeting.sendPrivateMessage(user, text(body.text)));
    case "POST share":
      return run(meeting.shareCard(user, text(body.cardId), text(body.text) || undefined));
    case "POST dismiss":
      meeting.dismissCard(user, text(body.cardId));
      return { ok: true };
    case "POST concern":
      return run(meeting.raiseConcern(user, text(body.cardId), body.mode === "named" ? "named" : "anonymous"));
    case "POST check/answer":
      return run(meeting.answerCheck(user, text(body.checkId), text(body.label)));
    case "POST check/start":
      return run(meeting.startCheck(user));
    case "POST check/compare":
      return run(meeting.compareNow(user));
    default:
      throw new HttpError(404, "Unknown endpoint");
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as Body) : {};
    const result = await route(req.method ?? "GET", url.pathname.replace(/\/+$/, "") || "/", url.searchParams, body);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err instanceof Error ? err.message : "Bad request" }));
  }
});

// Time-based rules: the silence trigger and the check timeout.
setInterval(() => {
  for (const meeting of rooms.values()) meeting.tick().catch(logFailure);
}, TICK_MS);

server.listen(PORT, () => {
  const info = llmInfo();
  console.log(`CrossCheck API on http://localhost:${PORT}   agents: ${info.mode === "mock" ? "MOCK (no API key, free)" : info.model}`);
});
