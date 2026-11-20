// Browser-facing API. Each room lives in this server process; authorization travels in a per-tab header.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Meeting, PersonalAgentUnavailable } from "../agents/meeting";
import { llmInfo } from "../agents/llm";

type Body = Record<string, unknown>;
type Room = { meeting: Meeting; sessions: Map<string, string> }; // private token -> display name
const text = (v: unknown): string => typeof v === "string" ? v : "";
const acknowledge = { ok: true };

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function issueSession(room: Room, user: string) {
  const token = randomBytes(32).toString("base64url");
  room.sessions.set(token, user);
  return token;
}

function shareMode(value: unknown): "named" | "anonymous" {
  if (value !== "named" && value !== "anonymous") throw new HttpError(400, "Choose how to share the confirmed text");
  return value;
}

// Group actions are persisted synchronously in the meeting; slower agent results arrive on poll.
// Surface immediate validation failures, but do not hold a group post open during a model request.
async function run(job: Promise<void>) {
  await Promise.race([job, Promise.resolve()]);
  job.catch(() => console.error("[CrossCheck] background agent work failed"));
  return acknowledge;
}

async function route(rooms: Map<string, Room>, method: string, path: string, query: URLSearchParams, body: Body, token: string) {
  if (method === "GET" && path === "/") return { name: "CrossCheck API", llm: llmInfo(), rooms: rooms.size, docs: "docs/api.md" };
  if (method === "POST" && path === "/rooms") {
    const host = text(body.host).trim();
    const meeting = new Meeting({ goal: text(body.goal), host });
    const room = { meeting, sessions: new Map<string, string>() };
    rooms.set(meeting.id, room);
    return { roomId: meeting.id, sessionToken: issueSession(room, host) };
  }

  const parts = path.match(/^\/rooms\/([\w-]+)\/(.+)$/);
  if (!parts || parts[2] === "trace") throw new HttpError(404, "Unknown endpoint");
  const room = rooms.get(parts[1]);
  if (!room) throw new HttpError(404, "Room not found (rooms are lost when the server restarts)");
  const { meeting } = room;
  const action = method + " " + parts[2];
  const requested = (text(body.user) || query.get("user") || "").trim();
  const owner = room.sessions.get(token);
  if (action === "POST join") {
    const existing = meeting.participants.find(name => name.toLowerCase() === requested.toLowerCase());
    if (existing) {
      if (owner !== existing || requested !== owner) throw new HttpError(403, "That name is already in use. Resume from your original tab or choose another name.");
      return { ...acknowledge, sessionToken: token };
    }
    meeting.join(requested);
    return { ...acknowledge, sessionToken: issueSession(room, requested) };
  }
  if (!owner || (requested && requested !== owner)) throw new HttpError(403, "A session for this participant and meeting is required");

  switch (action) {
    case "GET view": return meeting.view(owner);
    case "POST group": return run(meeting.postGroupMessage(owner, text(body.text)));
    case "POST private": {
      const intent = body.intent;
      if (intent !== undefined && intent !== "invite_brainstorm") throw new HttpError(400, "Unknown private intent");
      await meeting.sendPrivateMessage(owner, text(body.text), { cardId: text(body.cardId) || undefined,
        groupMessageId: text(body.groupMessageId) || undefined, intent });
      return acknowledge;
    }
    case "POST share": return run(meeting.shareCard(owner, text(body.cardId), text(body.text), shareMode(body.mode)));
    case "POST concern": return run(meeting.raiseConcern(owner, text(body.cardId), shareMode(body.mode), text(body.text)));
    case "POST dismiss":
      meeting.dismissCard(owner, text(body.cardId));
      return acknowledge;
    case "POST angle": {
      const intent = body.intent;
      if (intent !== "find_contribution" && intent !== "invite_brainstorm") throw new HttpError(400, "Specify the moderator angle intent");
      await meeting.requestAngle(owner, text(body.angle), intent);
      return acknowledge;
    }
    case "POST check/answer":
      if (typeof body.approve !== "boolean") throw new HttpError(400, "Choose whether to approve this proposal");
      return run(meeting.answerCheck(owner, text(body.checkId), text(body.label), body.approve));
    case "POST check/revise": return run(meeting.reviseCheck(owner, text(body.checkId), text(body.decision)));
    case "POST check/start": return run(meeting.startCheck(owner));
    case "POST check/compare": return run(meeting.compareNow(owner));
    default: throw new HttpError(404, "Unknown endpoint");
  }
}

export function startServer(port: number, host?: string): http.Server {
  const rooms = new Map<string, Room>();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CrossCheck-Session");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body: Body = raw ? JSON.parse(raw) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
      const result = await route(rooms, req.method ?? "GET", url.pathname.replace(/\/+$/, "") || "/", url.searchParams,
        body, text(req.headers["x-crosscheck-session"]));
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof PersonalAgentUnavailable ? 503 : 400;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify({ error: err instanceof Error ? err.message : "Bad request" }));
    }
  });
  const timer = setInterval(() => {
    for (const { meeting } of rooms.values()) meeting.tick().catch(() => console.error("[CrossCheck] background meeting update failed"));
  }, 5000);
  server.once("close", () => clearInterval(timer));
  return server.listen(port, host);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  startServer(port).on("listening", () => console.log(`CrossCheck API on http://localhost:${port} (${llmInfo().mode})`));
}
