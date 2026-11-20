# CrossCheck

Team X-MAS, CS473 design project.

CrossCheck helps a small team in a text-chat meeting. Each member has a private assistant (personal agent). One moderator agent watches the group chat. Together they help the team bring out more ideas and leave the meeting with the same understanding of what was decided.

- Design summary: [docs/design.md](docs/design.md)
- API for the web UI: [docs/api.md](docs/api.md)

## Quick start

Use Node 20 or newer. Create the ignored server `.env` from `.env.example` and set `OPENROUTER_API_KEY`, or export the key in the API process environment. Personal Agent calls `openai/gpt-5-mini` through OpenRouter.

```bash
npm ci
npm run dev:api                 # API on http://localhost:8787
```

In the [team website repository](https://github.com/ahdahioui/crosscheck), serve the `web/` directory with `python3 -m http.server 5173 --directory web`. Open http://localhost:5173. Each tab has its own participant session. The server keeps rooms in memory for its process lifetime.

```bash
npm run typecheck
npm test                        # model validation + actual HTTP routes with injected replies
npm run test:prompts -- --mock  # offline prompt fixtures
npm run test:live               # opt-in real OpenRouter meeting using a synthetic scenario
```

The live test checks a relevant private suggestion for only one of two recipients, an unrelated private follow-up with its card open, an edited anonymous post, and approval invalidation on revision. Model errors surface to the private client. Scripted model outputs and sample participants belong to the test runners.

## Who owns what

| Path | What it is | Owner |
|---|---|---|
| `prompts/moderator/*.md` | Moderator system prompts (3 files) | Jeehye |
| `agents/moderator.ts` | Calls the moderator prompts, cleans the output | Jeehye |
| `tests/fixtures/moderator/` | Test cases for the moderator | Jeehye |
| `prompts/personal/*.md` | Personal agent system prompts (4 files) | Jaewon |
| `agents/personal.ts` | Calls the personal prompts, cleans the output | Jaewon |
| `tests/fixtures/personal/` | Test cases for the personal agent | Jaewon |
| `web/` | The web UI | Hamza, Jiyeon |
| `agents/protocol.ts` | Data shapes shared by agents and UI | Shared. Tell the team before you change it. |
| `agents/meeting.ts` | Runs one meeting: who is called when, what crosses the privacy boundary | Shared |
| `agents/rules.ts` | Timing numbers (silence = 60 s, and so on) | Shared |
| `agents/llm.ts` | OpenRouter call, prompt loading, cost counter | Shared |
| `tests/mocks.ts` | Offline model fixtures | Shared |
| `server/index.ts` | HTTP API used by the web UI | Shared |
| `tests/run.ts`, `tests/simulate.ts` | Prompt tests and the full-meeting simulation | Shared |

## How it works

```
 Jiwoo  <-- private chat -->  Jiwoo's agent  --+
 Taeho  <-- private chat -->  Taeho's agent  --+-- labels only -->  Moderator  --> short messages in the group chat
 Minsu  <-- private chat -->  Minsu's agent  --+ <-- requests ----
```

| | Personal agent (one per member) | Moderator (one per meeting) |
|---|---|---|
| Reads | Group chat + its own user's private chat | Group chat + labels from the personal agents |
| Writes | Private replies and cards for its own user | Requests to the personal agents, short group messages |
| Never | Posts in the group chat. Only the user can post. | Reads private chat. Names who said what. |

The moderator acts at three moments:

1. The group chat is silent for 60 s during ideation. It picks a missing angle and asks the personal agents. An agent whose user has a related private note suggests a draft to that user.
2. A message looks like a decision. It opens a private agreement check for every member.
3. All answers are in. It compares them. Matching interpretations and explicit approval from every participant on this version record the decision. If not, it posts one anonymous question.

## Each prompt in one line

| Prompt file | Function | When it runs |
|---|---|---|
| `moderator/find_missing_angle.md` | `moderator.findMissingAngle` | Chat silent for 60 s |
| `moderator/detect_decision.md` | `moderator.detectDecision` | Every new group message |
| `moderator/compare_understanding.md` | `moderator.compareUnderstanding` | All members answered the check |
| `personal/chat.md` | `personal.chat` | User writes to their agent |
| `personal/angle_reply.md` | `personal.angleReply` | Moderator asks about an angle |
| `personal/react.md` | `personal.react` | A teammate posts in the group chat |
| `personal/suggest_check_answer.md` | `personal.suggestCheckAnswer` | An agreement check opens |

## How to work on a prompt

Personal prompts take a structured JSON context with the public timeline, the owner’s private history and the event. Moderator prompt files have two parts. Text above `=== INPUT ===` is the system prompt. Text below is the input template. `{{name}}` is replaced with meeting data. `<!-- comments -->` are not sent to the model.

The loop:

1. Edit the `.md` file.
2. Look at exactly what the model will receive (free): `npm run test:prompts -- --dry-run --only <fixture id>`
3. Run your fixtures with the real model: `npm run test:moderator` or `npm run test:personal`
4. Read the outputs. A fixture can pass and still sound bad.
5. When a case fails in a new way, add it as a fixture so it stays fixed.
6. Run `npm run simulate` to see your agent inside a whole meeting.

A fixture looks like this (`tests/fixtures/<agent>/*.json`):

```json
{
  "id": "angle_similar_ideas",
  "fn": "moderator.findMissingAngle",
  "note": "Two ideas, both about connecting people. A different angle should be asked.",
  "input": { "goal": "...", "anglesAsked": [], "group": [{ "author": "Minsu", "text": "..." }] },
  "expect": { "action": "ask_angle", "angle": { "max_words": 8, "not_includes_any": ["minsu"] } }
}
```

Checks you can use in `expect`: an exact value, or `one_of`, `includes_any`, `includes_all`, `not_includes_any`, `max_words`, `min_length`, `max_length`, `length`, `is_null`, `is_empty`, `not_empty`. Add `"mock": "skip"` to a fixture that only a real model can pass.

## Commands

| Command | What it does |
|---|---|
| `npm run simulate` | Full meeting in the terminal. Add `-- --mock` to force mock mode, `-- --quiet` to hide agent messages. |
| `npm run test:prompts` | All fixtures. `npm run test:moderator` and `npm run test:personal` run one agent. |
| `npm run test:prompts -- --only angle` | Fixtures whose id or function contains "angle" |
| `npm run test:prompts -- --repeat 3` | Each fixture 3 times, to check consistency |
| `npm run test:prompts -- --dry-run` | Print the filled prompts. No API call. |
| `npm run test:prompts -- --model <id>` | Try another Moderator model |
| `npm run dev:api` | API server for the web UI on http://localhost:8787 |
| `npm run typecheck` | TypeScript check. Run before you push. |

Test results are saved in `tests/results/` (not committed).

## Cost

Personal Agent uses `openai/gpt-5-mini`. The prompt test runner reports provider token usage and an estimate based on `LLM_PRICE_IN` and `LLM_PRICE_OUT`. Use `--mock` or `--dry-run` for offline fixture checks.

## Team rules

- The API key goes only in `.env`. This file is ignored by git. Never paste the key in code, docs, issues, or chat.
- Check before every commit: `git status` must not list `.env`.
- Change `agents/protocol.ts` only after telling the team. The web UI depends on it.
- Small changes to your own prompt files can go straight to `main`. For shared files, open a pull request.
- Run `npm run typecheck` and `npm run test:prompts -- --mock` before you push.

## Status

- The paired web client uses the room API and tab-scoped participant sessions. Personal Agent has offline and opt-in live acceptance tests.
- Room data is in process memory. Restarting the API ends existing rooms and sessions.
