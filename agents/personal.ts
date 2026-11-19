// The Personal agent (one per participant). Owner: Jaewon.
//
// A personal agent reads the group chat and ITS OWN user's private window. It never sees another
// user's private window. What it sends to the moderator is a short label, never the private text.
//
// One function = one prompt in prompts/personal/. Timing (when each is called) lives in meeting.ts.

import { callJSON, type LLMRecord } from "./llm";
import { formatChat, formatPrivate, norm, str } from "./format";
import * as mocks from "./mocks";
import type { AngleReply, ChatLine, ChatResult, CheckSuggestion, PrivateTurn, ReactResult, Stage } from "./protocol";

type Log = (record: LLMRecord) => void;

type Base = { user: string; goal: string; group: ChatLine[]; privateHistory: PrivateTurn[] };

// ---------- 1. Private chat: the user talks to their agent (Task 1, any time) ----------

export type ChatInput = Base & { stage: Stage; message: string };

export async function chat(input: ChatInput, log?: Log): Promise<ChatResult> {
  const data = await callJSON<ChatResult>(
    "personal/chat",
    {
      user: input.user,
      goal: input.goal,
      stage: input.stage,
      groupChat: formatChat(input.group),
      privateChat: formatPrivate(input.privateHistory, input.user),
      message: input.message,
    },
    () => mocks.chat(input),
    { log },
  );
  const concern =
    data.concern && str(data.concern.label) ? { label: str(data.concern.label), draft: str(data.concern.draft) } : null;
  return {
    reply: str(data.reply) || "Sorry, I could not come up with an answer. Could you say it another way?",
    share_draft: str(data.share_draft) || null,
    concern,
  };
}

// ---------- 2. The moderator asks: does your user have a view on this angle? (Task 2) ----------

export type AngleReplyInput = Base & { angle: string };

export async function angleReply(input: AngleReplyInput, log?: Log): Promise<AngleReply> {
  const data = await callJSON<AngleReply>(
    "personal/angle_reply",
    {
      user: input.user,
      goal: input.goal,
      angle: input.angle,
      groupChat: formatChat(input.group),
      privateChat: formatPrivate(input.privateHistory, input.user),
    },
    () => mocks.angleReply(input),
    { log },
  );
  const has = Boolean(data.has_view) && str(data.draft).length > 0;
  return {
    has_view: has,
    label: has ? str(data.label) : "",
    nudge: has ? str(data.nudge) : "",
    draft: has ? str(data.draft) : "",
  };
}

// ---------- 3. A teammate posted an idea: does it connect to what my user said in private? (Task 2) ----------

export type ReactInput = Base & { newMessage: ChatLine };

export async function react(input: ReactInput, log?: Log): Promise<ReactResult> {
  const data = await callJSON<ReactResult>(
    "personal/react",
    {
      user: input.user,
      goal: input.goal,
      newMessage: `[${input.newMessage.author}] ${input.newMessage.text}`,
      groupChat: formatChat(input.group),
      privateChat: formatPrivate(input.privateHistory, input.user),
    },
    () => mocks.react(input),
    { log },
  );
  const suggest = Boolean(data.suggest) && str(data.draft).length > 0;
  return { suggest, nudge: suggest ? str(data.nudge) : "", draft: suggest ? str(data.draft) : "" };
}

// ---------- 4. Agreement check: which option does my user most likely mean? (Task 3) ----------

export type CheckSuggestInput = Base & { decision: string; question: string; options: string[] };

export async function suggestCheckAnswer(input: CheckSuggestInput, log?: Log): Promise<CheckSuggestion> {
  const data = await callJSON<CheckSuggestion>(
    "personal/suggest_check_answer",
    {
      user: input.user,
      decision: input.decision,
      question: input.question,
      options: input.options.map((o) => `- ${o}`).join("\n"),
      groupChat: formatChat(input.group),
      privateChat: formatPrivate(input.privateHistory, input.user),
    },
    () => mocks.suggestCheckAnswer(input),
    { log },
  );
  // Only accept a suggestion that is exactly one of the options.
  const wanted = norm(str(data.suggested_option));
  const match = wanted ? input.options.find((o) => norm(o) === wanted) : undefined;
  return { suggested_option: match ?? null, why: match ? str(data.why) : "" };
}
