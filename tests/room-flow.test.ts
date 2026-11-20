import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { usage, useFixtureGenerator } from "../agents/llm";
import type { Card, UserView } from "../agents/protocol";
import { startServer } from "../server/index";

const live = process.env.CROSSCHECK_LIVE_TEST === "1";
const idea = "I could count the lunch queue by hand at the two cafeteria doors at ten-minute intervals.";
const unrelated = "I can proofread the invitation email for spelling.";
const prompt = "What field measurements could explain the lunchtime survey results? We need a concrete collection method.";
const decision = "Let's survey every cafeteria on campus this week.";
const published = "For the pilot, count the lines at just two cafeterias.";
const finalScope = "Pilot the study at two cafeterias first.";
const cards = (v: UserView): Card[] => v.private.flatMap(i => i.type === "card" ? [i.card] : []);
const isSuggestion = (c: Card) => c.kind === "share_suggestion" && c.source === "react";

type Context = {
  user: string; message: string; group: { text: string }[]; decision: string; labels: string[];
  options: string[]; privateHistory: { id: string; role: string; text: string }[];
  newMessage?: { text: string }; reference?: { draft?: string }; question: string;
};

test(live ? "OpenRouter meeting through HTTP" : "two participants see one group event, keep separate private histories and choose what to share", { timeout: live ? 420_000 : 12_000 }, async () => {
  // Pause just the private evidence check; a direct message must still finish.
  let releaseReview!: () => void;
  const reviewGate = new Promise<void>(resolve => { releaseReview = resolve; });
  let reviewStarted = false;
  const modelInputs: { promptName: string; user: string; input: string }[] = [];
  if (!live) {
    useFixtureGenerator(async (promptName, raw) => {
      const c = raw as Context;
      modelInputs.push({ promptName, user: c.user, input: JSON.stringify(c) });
      const note = c.privateHistory?.find(m => m.role === "user" && m.text === idea);
      const evidence = note ? [{ id: note.id, quote: note.text }] : [];
      switch (promptName) {
        case "personal/chat":
          return { reply: c.message.includes("17 + 8") ? "25" : c.reference?.draft || "We can explore that privately.", share_draft: null, concern: null };
        case "personal/react":
          if (note && c.newMessage?.text === prompt) {
            reviewStarted = true;
            await reviewGate;
            return { kind: "grounded", nudge: "Your manual counts would provide a field measurement.", draft: "Count the queue at both entrances.", evidence };
          }
          return { kind: "none", nudge: "", draft: "", evidence: [] };
        case "personal/angle_reply": return { kind: "none", nudge: "", draft: "", evidence: [] };
        case "personal/suggest_check_answer": return { suggested_option: null, why: note ? "How would campus-wide sampling fit a two-site pilot?" : "How does this scope sound?", evidence };
        case "moderator/find_missing_angle": return { action: "none", angle: "", group_prompt: "", reason: "" };
        case "moderator/detect_decision": {
          const found = c.group.at(-1)?.text === decision;
          return { is_decision: found, decision: found ? decision : "", ambiguity: "Scope", question: "What scope would you study?", options: ["Campus-wide", "Two cafeterias"], reason: "" };
        }
        case "moderator/compare_understanding": return { groups: [c.labels.map((_, index) => index + 1)], aligned: true, final_statement: c.decision, anonymous_question: "", reason: "" };
        default: throw new Error("Unexpected test prompt " + promptName);
      }
    });
  } else {
    assert.ok(process.env.OPENROUTER_API_KEY, "Set OPENROUTER_API_KEY for the opt-in live test.");
  }
  const server = startServer(0, "127.0.0.1");
  if (!server.listening) await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  let roomId: string;
  type Actor = { user: string; token: string };
  async function request(path: string, body?: object, who?: Actor) {
    return fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(who ? { "X-CrossCheck-Session": who.token } : {}) },
      body: body && JSON.stringify(body),
    });
  }
  async function post(action: string, who: Actor, data: object = {}) {
    const r = await request(`/rooms/${roomId}/${action}`, { user: who.user, ...data }, who);
    const out = await r.json();
    assert.ok(r.ok, `${action}: ${r.status} ${JSON.stringify(out)}`);
    return out;
  }
  async function view(who: Actor) {
    const r = await request(`/rooms/${roomId}/view?user=${who.user}`, undefined, who);
    assert.equal(r.status, 200);
    return await r.json() as UserView;
  }
  async function until(who: Actor, predicate: (v: UserView) => boolean, what: string) {
    const deadline = Date.now() + (live ? 100_000 : 4000);
    while (Date.now() < deadline) {
      const state = await view(who);
      if (predicate(state)) return state;
      await delay(live ? 350 : 15);
    }
    throw new Error("Timed out waiting for " + what);
  }
  try {
    const created = await request("/rooms", { host: "Chair", goal: "Understand cafeteria queues during lunch." });
    const creation = await created.json() as { roomId: string; sessionToken: string };
    roomId = creation.roomId;
    const host = { user: "Chair", token: creation.sessionToken };
    async function join(user: string) {
      const joined = await request(`/rooms/${roomId}/join`, { user });
      assert.ok(joined.ok);
      return { user, token: (await joined.json() as { sessionToken: string }).sessionToken };
    }
    const [min, jia] = await Promise.all([join("Min"), join("Jia")]);
    await Promise.all([post("private", min, { text: idea }), post("private", jia, { text: unrelated })]);
    const minBefore = await view(min);
    const ownerId = minBefore.private.find(i => i.type === "user" && i.text === idea)!.id;
    await post("group", host, { text: prompt });
    if (!live) {
      await until(min, () => reviewStarted, "a group reaction to start");
      await post("private", min, { text: "What is 17 + 8?" });
      assert.ok((await view(min)).private.some(i => i.type === "agent" && i.text.includes("25")));
      releaseReview();
    }
    const first = await until(min, v => cards(v).some(isSuggestion), "a grounded fieldwork suggestion");
    const card = cards(first).find(isSuggestion);
    assert.ok(card?.kind === "share_suggestion");
    assert.ok(card.evidenceIds?.includes(ownerId));
    assert.ok(!(await view(jia)).private.some(i => i.type === "user" && i.text === idea));
    assert.ok(!cards(await view(jia)).some(isSuggestion));
    await post("private", min, { cardId: card.id, text: "Briefly explain the collection method in this card." });
    const contextual = (await view(min)).private.filter(i => i.type === "agent").at(-1);
    assert.ok(contextual?.type === "agent" && /count|queue|entrance|door|line|interval|observ/i.test(contextual.text));
    await post("private", min, { text: "New topic. What is 17 + 8? Answer just the number." });
    const afterChat = await view(min);
    const newReply = afterChat.private.filter(i => i.type === "agent").at(-1);
    assert.ok(newReply?.type === "agent" && newReply.text.includes("25"));
    assert.ok(cards(afterChat).some(c => c.id === card.id && c.status === "open"));
    assert.equal(afterChat.group.length, 1);

    const signed = { cardId: card.id, text: published, mode: "anonymous" };
    assert.equal((await request(`/rooms/${roomId}/view?user=Min`, undefined, jia)).ok, false);
    assert.equal((await request(`/rooms/${roomId}/share`, { user: "Jia", ...signed }, jia)).ok, false);
    await post("share", min, signed);
    const shared = (await view(jia)).group.at(-1)!;
    assert.equal(shared.text, published);
    assert.ok(!JSON.stringify(shared).includes("Min") && !JSON.stringify(shared).includes(ownerId));
    assert.ok(!("evidenceIds" in shared) && !("cardId" in shared));
    await post("group", host, { text: decision });
    let active = await view(host);
    if (live && !active.agreement) {
      await delay(8_000);
      active = await view(host);
      if (!active.agreement) await post("check/start", host);
    }
    const stateV1 = await until(min, v => !!v.agreement && cards(v).some(c =>
      c.kind === "understanding_check" && c.checkId === v.agreement?.checkId && !!c.why), "private review of proposal v1");
    const v1 = stateV1.agreement!;
    assert.equal(v1.answered, 0);
    assert.equal(v1.approvedCount, 0);
    await post("check/answer", min, { checkId: v1.checkId, label: "Campus-wide", approve: true });
    assert.equal((await view(host)).agreement?.answered, 1);
    await post("check/revise", host, { checkId: v1.checkId, decision: finalScope });
    const revised = await until(min, v => !!v.agreement && v.agreement.checkId !== v1.checkId && cards(v).some(c =>
      c.kind === "understanding_check" && c.checkId === v.agreement?.checkId && !!c.why), "private review of proposal v2");
    assert.equal(revised.agreement?.answered, 0);
    assert.equal(revised.agreement?.approvedCount, 0);
    assert.equal(revised.agreement?.version, v1.version + 1);
    assert.equal(revised.agreement?.decision, finalScope);
    assert.equal((await request(`/rooms/${roomId}/check/answer`, { user: min.user, checkId: v1.checkId, label: "Campus-wide", approve: true }, min)).ok, false);
    assert.ok(!cards(await view(jia)).some(isSuggestion));
    if (live) {
      assert.equal(usage.mockCalls, 0);
      assert.ok(usage.calls > 0);
      console.log(JSON.stringify({ model: first.llm.model, completedModelCalls: usage.calls, suggestion: card.nudge, cardReply: contextual.text, anonymousText: shared.text, revisedApprovals: revised.agreement?.approvedCount }));
    } else {
      assert.ok(modelInputs.filter(x => x.promptName.startsWith("moderator/") || x.user !== min.user).every(x => !x.input.includes(idea)), "private note was sent to another agent");
    }
  } finally {
    releaseReview();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
