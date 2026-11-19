// One meeting room: its state, and the rules for when each agent runs and what it may see.
//
// The prompts decide WHAT an agent says. This file decides WHEN an agent is called, WHO receives the
// result, and WHAT crosses the privacy boundary. Those three things are never left to a prompt.
//
//   group message ──► personal agents of the others: "does this connect to my user's notes?"   (ideation)
//                 └─► moderator: "is the team settling on a decision?"  ──► agreement check
//   silence 60 s  ──► moderator: "is an angle missing?" ──► every personal agent ──► private nudge  (ideation)
//   private message ► that user's personal agent only
//   all answers in ─► moderator compares anonymous labels ──► "Agreed n/n" or one anonymous question

import { randomUUID } from "node:crypto";
import { llmInfo, type LLMRecord } from "./llm";
import * as moderator from "./moderator";
import * as personal from "./personal";
import { DEFAULT_RULES, type Rules } from "./rules";
import type {
  AgentToModerator,
  Card,
  ChatLine,
  Check,
  ConcernCard,
  DecisionDetection,
  DecisionRecord,
  GroupMessage,
  ModeratorNote,
  ModeratorToAgent,
  PrivateItem,
  PrivateTurn,
  ShareSuggestionCard,
  Stage,
  TraceEvent,
  UnderstandingCheckCard,
  UserView,
} from "./protocol";

export type MeetingOptions = {
  id?: string;
  goal: string;
  host: string;
  rules?: Partial<Rules>;
  /** Injectable clock, so tests can fast-forward the silence timer. */
  now?: () => number;
};

export class Meeting {
  readonly id: string;
  readonly goal: string;
  readonly host: string;
  readonly rules: Rules;

  stage: Stage = "ideation";
  participants: string[] = [];
  group: GroupMessage[] = [];
  check: Check | null = null;
  decisions: DecisionRecord[] = [];
  trace: TraceEvent[] = [];

  private windows = new Map<string, PrivateItem[]>();
  private typing = new Map<string, number>();
  private lastProactiveAt = new Map<string, number>();
  private anglesAsked: string[] = [];
  private userMsgsAtLastAngleRun = 0;
  private angleBusy = false;
  private detectBusy = false;
  private comparing = false;
  private seq = 0;
  private now: () => number;

  constructor(opts: MeetingOptions) {
    this.id = opts.id ?? randomUUID().slice(0, 8);
    this.goal = opts.goal.trim() || "Untitled meeting";
    this.host = opts.host.trim();
    this.rules = { ...DEFAULT_RULES, ...opts.rules };
    this.now = opts.now ?? Date.now;
    this.join(this.host);
  }

  // =====================================================================
  // Actions. The web server calls these. Each one returns when all the agent work it triggered is done;
  // the server does not wait for that (the UI polls), the tests do.
  // =====================================================================

  join(name: string): void {
    const user = name.trim();
    if (!user) throw new Error("Name is required");
    if (user.toLowerCase() === "moderator") throw new Error('"Moderator" is reserved');
    if (this.participants.includes(user)) return;
    this.participants.push(user);
    this.windows.set(user, []);
  }

  /** A participant posts in the group chat. */
  async postGroupMessage(user: string, text: string): Promise<void> {
    this.requireUser(user);
    const body = text.trim();
    if (!body) throw new Error("Empty message");
    const msg = this.addGroup(user, "user", body);
    this.log("user_to_group", `user:${user}`, "group", { text: body });

    const jobs: Promise<void>[] = [];
    if (this.stage === "ideation") jobs.push(this.runReactions(msg));
    if (!this.checkOpen()) jobs.push(this.runDetect("new_message"));
    await Promise.all(jobs);
  }

  /** A participant talks to their own agent (Task 1). Only that agent is called. */
  async sendPrivateMessage(user: string, text: string): Promise<void> {
    this.requireUser(user);
    const body = text.trim();
    if (!body) throw new Error("Empty message");
    const history = this.privateTurns(user);
    this.addPrivate(user, { type: "user", text: body });
    this.log("user_to_agent", `user:${user}`, `agent:${user}`, {});
    this.typing.set(user, (this.typing.get(user) ?? 0) + 1);
    try {
      const res = await personal.chat(
        { user, goal: this.goal, stage: this.stage, group: this.groupContext(), privateHistory: history, message: body },
        this.llmLog(`agent:${user}`),
      );
      this.addPrivate(user, { type: "agent", text: res.reply });
      if (res.share_draft) this.addSuggestion(user, "chat", "Here is a draft you can post in the group chat.", res.share_draft);
      if (res.concern) {
        this.addCard(user, { kind: "concern", id: this.nextId("card"), label: res.concern.label, draft: res.concern.draft, status: "open" });
      }
    } finally {
      this.typing.set(user, Math.max(0, (this.typing.get(user) ?? 1) - 1));
    }
  }

  /** The user presses [Share to chat] on a suggestion. This is the only way private content reaches the group. */
  async shareCard(user: string, cardId: string, editedText?: string): Promise<void> {
    const card = this.findCard(user, cardId);
    if (card.kind !== "share_suggestion" || card.status !== "open") throw new Error("This suggestion is not open");
    card.status = "shared";
    await this.postGroupMessage(user, editedText?.trim() || card.draft);
  }

  dismissCard(user: string, cardId: string): void {
    const card = this.findCard(user, cardId);
    if (card.kind === "understanding_check") throw new Error("A check cannot be dismissed");
    if (card.status === "open") card.status = "dismissed";
  }

  /** The user raises a concern their agent helped them pin down (Task 3). */
  async raiseConcern(user: string, cardId: string, mode: "named" | "anonymous"): Promise<void> {
    const card = this.findCard(user, cardId);
    if (card.kind !== "concern" || card.status !== "open") throw new Error("This concern is not open");
    if (mode === "named") {
      card.status = "raised_named";
      await this.postGroupMessage(user, card.draft);
      return;
    }
    card.status = "raised_anonymous";
    this.toModerator(user, { type: "concern", label: card.label });
    if (this.check?.status === "collecting") {
      this.check.concerns.push(card.label); // shown together with the anonymous question
    } else {
      this.moderatorSays(`A concern was raised anonymously: ${card.label}`, { type: "concern" });
    }
  }

  /** The user answers the agreement check in their private window. */
  async answerCheck(user: string, checkId: string, label: string): Promise<void> {
    this.requireUser(user);
    const check = this.check;
    if (!check || check.id !== checkId || check.status !== "collecting") throw new Error("This check is closed");
    const answer = label.trim();
    if (!answer) throw new Error("Answer is required");
    check.answers[user] = answer;
    const card = this.checkCard(user, checkId);
    if (card) {
      card.status = "answered";
      card.answer = answer;
    }
    this.toModerator(user, { type: "check_reply", checkId, label: answer });
    if (check.askedOf.every((p) => check.answers[p])) await this.runCompare();
  }

  /** Host only: check agreement now, without waiting for the moderator to spot a decision. */
  async startCheck(user: string): Promise<void> {
    this.requireHost(user);
    if (this.checkOpen()) throw new Error("A check is already open");
    await this.runDetect("host_request");
  }

  /** Host only: stop waiting and compare the answers so far. */
  async compareNow(user: string): Promise<void> {
    this.requireHost(user);
    if (!this.checkOpen()) throw new Error("No open check");
    if (Object.keys(this.check!.answers).length < 2) throw new Error("Need at least two answers");
    await this.runCompare();
  }

  /** Call every few seconds. Handles the rules that depend on time. */
  async tick(): Promise<void> {
    const t = this.now();
    const check = this.check;
    if (check?.status === "collecting" && t - check.createdAt >= this.rules.checkTimeoutMs && Object.keys(check.answers).length >= 2) {
      await this.runCompare();
    }
    if (this.stage !== "ideation" || this.angleBusy || this.anglesAsked.length >= this.rules.maxAngleQueries) return;
    const userMsgs = this.group.filter((m) => m.kind === "user").length;
    const last = this.group[this.group.length - 1];
    const quiet = last !== undefined && t - last.at >= this.rules.silenceMs;
    if (quiet && userMsgs >= this.rules.minIdeasBeforeAngle && userMsgs > this.userMsgsAtLastAngleRun) {
      await this.runMissingAngle(userMsgs);
    }
  }

  // =====================================================================
  // Views. What one participant is allowed to see.
  // =====================================================================

  view(user: string): UserView {
    this.requireUser(user);
    const c = this.check;
    return {
      roomId: this.id,
      me: user,
      isHost: user === this.host,
      goal: this.goal,
      stage: this.stage,
      participants: [...this.participants],
      group: this.group,
      private: this.windows.get(user) ?? [],
      agentTyping: (this.typing.get(user) ?? 0) > 0,
      agreement: c
        ? {
            checkId: c.id,
            status: c.status,
            decision: c.decision,
            question: c.question,
            answered: Object.keys(c.answers).length,
            askedOf: c.askedOf.length,
            agreed: c.agreed,
            total: c.total,
            statement: c.statement,
          }
        : null,
      decisions: this.decisions,
      llm: llmInfo(),
    };
  }

  /** What each user typed in private. Used by the privacy check in tests. */
  privateUserTexts(user: string): string[] {
    return (this.windows.get(user) ?? []).flatMap((i) => (i.type === "user" ? [i.text] : []));
  }

  // =====================================================================
  // Pipelines
  // =====================================================================

  /** Ideation: a teammate posted. Each other member's agent checks its own user's notes for a connection. */
  private async runReactions(msg: GroupMessage): Promise<void> {
    const others = this.participants.filter((p) => p !== msg.author && this.hasPrivateNotes(p) && this.cooledDown(p));
    await Promise.all(
      others.map(async (p) => {
        const res = await personal.react(
          { user: p, goal: this.goal, group: this.groupContext(), privateHistory: this.privateTurns(p), newMessage: msg },
          this.llmLog(`agent:${p}`),
        );
        if (res.suggest && this.stage === "ideation") this.addSuggestion(p, "react", res.nudge, res.draft);
      }),
    );
  }

  /** Ideation: the chat went quiet. The moderator looks for a missing angle and asks the personal agents. */
  private async runMissingAngle(userMsgs: number): Promise<void> {
    this.angleBusy = true;
    this.userMsgsAtLastAngleRun = userMsgs;
    try {
      const res = await moderator.findMissingAngle(
        { goal: this.goal, group: this.groupContext(), anglesAsked: this.anglesAsked },
        this.llmLog("moderator"),
      );
      if (res.action !== "ask_angle" || this.stage !== "ideation") return;
      this.anglesAsked.push(res.angle);
      this.toAgents({ type: "angle_query", angle: res.angle });

      const found = await Promise.all(
        this.participants.map(async (p) => {
          if (!this.hasPrivateNotes(p)) return false; // nothing private to look at: no call, no cost
          const reply = await personal.angleReply(
            { user: p, goal: this.goal, group: this.groupContext(), privateHistory: this.privateTurns(p), angle: res.angle },
            this.llmLog(`agent:${p}`),
          );
          // Only the label crosses to the moderator. The draft stays in the user's private window.
          this.toModerator(p, { type: "angle_reply", hasView: reply.has_view, label: reply.label });
          if (reply.has_view) this.addSuggestion(p, "missing_angle", reply.nudge, reply.draft);
          return reply.has_view;
        }),
      );
      // Nobody has a private thought on it: the moderator offers the angle to the whole group instead.
      if (!found.some(Boolean) && res.group_prompt) {
        this.moderatorSays(res.group_prompt, { type: "angle_prompt", angle: res.angle });
      }
    } finally {
      this.angleBusy = false;
    }
  }

  /** Any stage: is the newest group message a decision? If yes, open an agreement check. */
  private async runDetect(trigger: "new_message" | "host_request"): Promise<void> {
    if (this.detectBusy || this.checkOpen()) return;
    this.detectBusy = true;
    try {
      const d = await moderator.detectDecision({ goal: this.goal, group: this.groupContext(), trigger }, this.llmLog("moderator"));
      if (d.is_decision && !this.checkOpen()) await this.openCheck(d);
    } finally {
      this.detectBusy = false;
    }
  }

  private async openCheck(d: DecisionDetection): Promise<void> {
    const check: Check = {
      id: this.nextId("check"),
      decision: d.decision,
      question: d.question,
      options: d.options,
      status: "collecting",
      askedOf: [...this.participants],
      answers: {},
      concerns: [],
      createdAt: this.now(),
    };
    this.check = check;
    this.stage = "agreement";
    this.toAgents({ type: "check_request", checkId: check.id, decision: d.decision, question: d.question, options: d.options });

    for (const p of check.askedOf) {
      this.addCard(p, {
        kind: "understanding_check",
        id: this.nextId("card"),
        checkId: check.id,
        decision: d.decision,
        question: d.question,
        options: d.options,
        status: "open",
      });
    }
    // Each agent pre-selects the option its own user most likely means. It arrives a moment after the card.
    await Promise.all(
      check.askedOf.map(async (p) => {
        if (!this.hasPrivateNotes(p)) return;
        const s = await personal.suggestCheckAnswer(
          { user: p, goal: this.goal, group: this.groupContext(), privateHistory: this.privateTurns(p), decision: d.decision, question: d.question, options: d.options },
          this.llmLog(`agent:${p}`),
        );
        const card = this.checkCard(p, check.id);
        if (card && card.status === "open" && s.suggested_option) {
          card.suggested = s.suggested_option;
          card.why = s.why;
        }
      }),
    );
  }

  /** The answers are in. The moderator sees shuffled labels without names. */
  private async runCompare(): Promise<void> {
    const check = this.check;
    if (!check || check.status !== "collecting" || this.comparing) return;
    this.comparing = true;
    try {
      const labels = shuffle(Object.values(check.answers));
      const res = await moderator.compareUnderstanding(
        { decision: check.decision, question: check.question, labels, concerns: check.concerns },
        this.llmLog("moderator"),
      );
      const total = labels.length;
      const agreed = Math.max(...res.groups.map((g) => g.length));
      const missing = check.askedOf.length - total;
      const missingNote = missing > 0 ? ` (${missing} did not answer)` : "";
      check.agreed = agreed;
      check.total = total;

      if (res.aligned) {
        check.status = "aligned";
        check.statement = res.final_statement;
        this.decisions.push({ id: this.nextId("decision"), checkId: check.id, statement: res.final_statement, at: this.now() });
        this.stage = "done";
        this.moderatorSays(`Agreed ${agreed}/${total}${missingNote}. ${res.final_statement}`, {
          type: "agreed",
          agreed,
          total,
          statement: res.final_statement,
        });
      } else {
        check.status = "mismatch";
        this.moderatorSays(`Agreement ${agreed}/${total}${missingNote}. ${res.anonymous_question}`, { type: "agreement_count", agreed, total });
      }
      for (const p of check.askedOf) {
        const card = this.checkCard(p, check.id);
        if (card && card.status === "open") card.status = "closed";
      }
    } finally {
      this.comparing = false;
    }
  }

  // =====================================================================
  // Helpers
  // =====================================================================

  private checkOpen(): boolean {
    return this.check?.status === "collecting";
  }

  private requireUser(user: string): void {
    if (!this.participants.includes(user)) throw new Error(`${user} has not joined this meeting`);
  }

  private requireHost(user: string): void {
    this.requireUser(user);
    if (user !== this.host) throw new Error("Only the host can do this");
  }

  private nextId(prefix: string): string {
    return `${prefix}_${++this.seq}`;
  }

  /** The group chat as the agents read it. This is ALL the moderator ever gets, plus labels. */
  private groupContext(): ChatLine[] {
    return this.group.slice(-this.rules.groupContextMessages).map((m) => ({ author: m.author, text: m.text, kind: m.kind }));
  }

  private privateTurns(user: string): PrivateTurn[] {
    const turns: PrivateTurn[] = [];
    for (const item of this.windows.get(user) ?? []) {
      if (item.type === "user") turns.push({ role: "user", text: item.text });
      else if (item.type === "agent") turns.push({ role: "agent", text: item.text });
    }
    return turns.slice(-this.rules.privateContextTurns);
  }

  private hasPrivateNotes(user: string): boolean {
    return (this.windows.get(user) ?? []).some((i) => i.type === "user");
  }

  private cooledDown(user: string): boolean {
    const last = this.lastProactiveAt.get(user);
    return last === undefined || this.now() - last >= this.rules.suggestionCooldownMs;
  }

  private addGroup(author: string, kind: "user" | "moderator", text: string, note?: ModeratorNote): GroupMessage {
    const msg: GroupMessage = { id: this.nextId("msg"), author, kind, text, at: this.now(), ...(note ? { note } : {}) };
    this.group.push(msg);
    return msg;
  }

  private moderatorSays(text: string, note: ModeratorNote): void {
    this.addGroup("Moderator", "moderator", text, note);
    this.log("mod_to_group", "moderator", "group", { text, note });
  }

  private addPrivate(user: string, item: { type: "user" | "agent"; text: string }): void {
    this.windows.get(user)!.push({ id: this.nextId("p"), at: this.now(), ...item });
  }

  private addCard(user: string, card: Card): void {
    this.windows.get(user)!.push({ id: this.nextId("p"), at: this.now(), type: "card", card });
  }

  /** An agent offers a draft. A newer unprompted suggestion replaces an older one that is still open. */
  private addSuggestion(user: string, source: ShareSuggestionCard["source"], nudge: string, draft: string): void {
    if (source !== "chat") {
      for (const c of this.cards(user)) {
        if (c.kind === "share_suggestion" && c.status === "open" && c.source !== "chat") c.status = "superseded";
      }
      this.lastProactiveAt.set(user, this.now());
    }
    this.addCard(user, { kind: "share_suggestion", id: this.nextId("card"), source, nudge, draft, status: "open" });
  }

  private cards(user: string): Card[] {
    return (this.windows.get(user) ?? []).flatMap((i) => (i.type === "card" ? [i.card] : []));
  }

  private findCard(user: string, cardId: string): ShareSuggestionCard | ConcernCard | UnderstandingCheckCard {
    this.requireUser(user);
    const card = this.cards(user).find((c) => c.id === cardId);
    if (!card) throw new Error("Card not found");
    return card;
  }

  private checkCard(user: string, checkId: string): UnderstandingCheckCard | undefined {
    return this.cards(user).find((c): c is UnderstandingCheckCard => c.kind === "understanding_check" && c.checkId === checkId);
  }

  // ---------- trace ----------

  private log(type: TraceEvent["type"], from: string, to: string, data: Record<string, unknown>): void {
    this.trace.push({ at: this.now(), type, from, to, data });
  }

  private toAgents(message: ModeratorToAgent): void {
    this.log("mod_to_agents", "moderator", "agents", message);
  }

  private toModerator(user: string, message: AgentToModerator): void {
    this.log("agent_to_mod", `agent:${user}`, "moderator", message);
  }

  private llmLog(who: string): (record: LLMRecord) => void {
    return (r) => this.log("llm_call", who, "llm", { prompt: r.prompt, input: r.user, output: r.raw, mocked: r.mocked, ms: r.ms });
  }
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Privacy check used by the tests: no agent other than a user's own may ever receive that user's private text.
 * Returns a list of problems. Empty list = the boundary held.
 */
export function findPrivacyLeaks(meeting: Meeting): string[] {
  const leaks: string[] = [];
  const groupTexts = meeting.group.map((m) => m.text);
  for (const user of meeting.participants) {
    const secrets = meeting
      .privateUserTexts(user)
      .filter((t) => t.length >= 15 && !groupTexts.some((g) => g.includes(t)));
    for (const ev of meeting.trace) {
      if (ev.type !== "llm_call" || ev.from === `agent:${user}`) continue;
      const input = String(ev.data.input ?? "");
      for (const s of secrets) {
        if (input.includes(s)) leaks.push(`${ev.from} (${String(ev.data.prompt)}) received ${user}'s private text: "${s.slice(0, 50)}"`);
      }
    }
  }
  return leaks;
}
