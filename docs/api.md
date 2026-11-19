# API for the web UI

The web UI never calls the model. It talks to this small server. The server runs the agents and keeps the API key.

```
Browser (web UI)  --HTTP-->  server/index.ts  -->  agents/meeting.ts  -->  OpenRouter
```

Start it:

```bash
npm run dev:api        # http://localhost:8787
```

Without a key in `.env` it runs in mock mode (fake agents, free). That is enough to build and test the UI.

## Basics

- All bodies are JSON. Send the header `Content-Type: application/json`.
- There is no login. The client sends the user's name as `user`.
- Rooms are kept in memory. They are lost when the server restarts.
- Errors return status 400 or 404 with `{ "error": "message" }`.
- A `POST` returns `{ "ok": true }` right away. The agents work in the background. The result appears in the next `view`.

## Endpoints

| Method and path | Body | What it does |
|---|---|---|
| `POST /rooms` | `{ goal, host }` | Creates a meeting. Returns `{ roomId }`. The host has joined. |
| `POST /rooms/:id/join` | `{ user }` | Joins the meeting. |
| `GET /rooms/:id/view?user=NAME` | | Everything this user may see. Poll it every 1 to 2 s. |
| `POST /rooms/:id/group` | `{ user, text }` | Posts a message in the group chat. |
| `POST /rooms/:id/private` | `{ user, text }` | Sends a message to the user's own agent. |
| `POST /rooms/:id/share` | `{ user, cardId, text? }` | Posts a suggestion card's draft in the group chat. `text` = the edited draft. |
| `POST /rooms/:id/dismiss` | `{ user, cardId }` | Closes a suggestion or concern card. |
| `POST /rooms/:id/concern` | `{ user, cardId, mode }` | Raises a concern. `mode` is `"named"` or `"anonymous"`. |
| `POST /rooms/:id/check/answer` | `{ user, checkId, label }` | Answers the agreement check. `label` is one of the options, or free text. |
| `POST /rooms/:id/check/start` | `{ user }` | Host only. Starts an agreement check now. |
| `POST /rooms/:id/check/compare` | `{ user }` | Host only. Compares the answers so far (needs 2 or more). |
| `GET /rooms/:id/trace` | | Debug log of every agent call. It contains private text. Remove it before a public deploy. |

## The view

`GET /rooms/:id/view?user=Jiwoo` returns one object. Draw the whole screen from it. Types are in `agents/protocol.ts` (`UserView`).

```json
{
  "roomId": "0de50b85",
  "me": "Jiwoo",
  "isHost": false,
  "goal": "Pick one topic for our team project",
  "stage": "agreement",
  "participants": ["Minsu", "Seoyeon", "Jiwoo", "Taeho"],
  "group": [
    { "id": "msg_3", "author": "Minsu", "kind": "user", "text": "Let's go with crowding prediction then.", "at": 1795073067625 },
    { "id": "msg_9", "author": "Moderator", "kind": "moderator", "text": "Agreement 2/4. Quick check before we move on. ...", "at": 1795073069000,
      "note": { "type": "agreement_count", "agreed": 2, "total": 4 } }
  ],
  "private": [
    { "id": "p_1", "at": 1795073067616, "type": "user", "text": "Crowding prediction sounds good, but can we get the data?" },
    { "id": "p_2", "at": 1795073067617, "type": "agent", "text": "Noted. It stays between us." },
    { "id": "p_6", "at": 1795073067652, "type": "card",
      "card": { "kind": "share_suggestion", "id": "card_5", "source": "missing_angle",
                "nudge": "Nobody has brought up real campus data yet. Want to share your idea?",
                "draft": "What about predicting how crowded the cafeteria and library are?", "status": "open" } },
    { "id": "p_11", "at": 1795073067700, "type": "card",
      "card": { "kind": "understanding_check", "id": "card_10", "checkId": "check_7",
                "decision": "We will do crowding prediction using campus data.",
                "question": "What scope do you have in mind for this?",
                "options": ["Library and cafeteria only", "The whole campus", "Not sure yet"],
                "suggested": "Library and cafeteria only", "why": "You talked about the cafeteria and the library.",
                "status": "open" } }
  ],
  "agentTyping": false,
  "agreement": { "checkId": "check_7", "status": "collecting", "decision": "...", "question": "...", "answered": 1, "askedOf": 4 },
  "decisions": [],
  "llm": { "mode": "mock", "model": "mock" }
}
```

`stage` is `"ideation"`, `"agreement"`, or `"done"`.

## Screen element to API

| Screen element | Read from the view | Call on user action |
|---|---|---|
| Start screen: goal + name | | `POST /rooms`, then share `roomId` with the team |
| Join screen: room code + name | | `POST /rooms/:id/join` |
| Header: goal, stage, members | `goal`, `stage`, `participants` | |
| Group chat list | `group[]`. `kind: "moderator"` gets the moderator style. | |
| Group chat input | | `POST /group` |
| Agreement badge ("2/4", "Agreed 4/4") | `note` on a moderator message, or `agreement.agreed` and `agreement.total` | |
| Private chat list | `private[]` items with `type: "user"` or `"agent"` | |
| Private chat input | | `POST /private` |
| "Agent is typing" | `agentTyping` | |
| Suggestion card: nudge, editable draft, Share, Dismiss | `private[]` item with `card.kind: "share_suggestion"` and `status: "open"` | `POST /share` (send `text` if edited), `POST /dismiss` |
| Agreement check card: question, option buttons, pre-selected option | `card.kind: "understanding_check"`. Pre-select `suggested` and show `why`. | `POST /check/answer` |
| "Waiting for answers 2/4" | `agreement.answered`, `agreement.askedOf` | |
| Concern card: label, Raise with my name, Raise anonymously | `card.kind: "concern"` | `POST /concern` |
| Final decision panel | `decisions[]` | |
| Host buttons: Check agreement now, Compare now | show when `isHost` | `POST /check/start`, `POST /check/compare` |

Show a card's buttons only while its `status` is `"open"`. Other statuses: `shared`, `dismissed`, `superseded` (a newer suggestion replaced it), `answered`, `closed`, `raised_named`, `raised_anonymous`.

## Minimal client code

```js
const API = "http://localhost:8787";
const post = (path, body) =>
  fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

// create and join
const { roomId } = await post("/rooms", { goal: "Pick a project topic", host: "Minsu" });
await post(`/rooms/${roomId}/join`, { user: "Jiwoo" });

// poll the view and redraw
setInterval(async () => {
  const view = await fetch(`${API}/rooms/${roomId}/view?user=Jiwoo`).then((r) => r.json());
  render(view);
}, 1500);

// user actions
post(`/rooms/${roomId}/group`, { user: "Jiwoo", text: "How about a study app?" });
post(`/rooms/${roomId}/private`, { user: "Jiwoo", text: "Help me think about campus problems." });
post(`/rooms/${roomId}/share`, { user: "Jiwoo", cardId: "card_5" });
post(`/rooms/${roomId}/check/answer`, { user: "Jiwoo", checkId: "check_7", label: "Library and cafeteria only" });
```

## Try it without a UI

```bash
curl -X POST localhost:8787/rooms -H 'Content-Type: application/json' -d '{"goal":"Pick a topic","host":"Minsu"}'
curl "localhost:8787/rooms/ROOM_ID/view?user=Minsu"
```

To test a meeting alone, open the UI in several browser tabs with different names.

## Deploying

- The server must run as one long-lived Node process, because rooms are in memory. Use a host that runs `npm start` (Render, Railway, Fly.io). Serverless functions do not fit.
- Set `OPENROUTER_API_KEY` in the host's environment settings. Never put the key in front-end code.
- Put the API address in one config value in the web UI, so local and deployed builds differ in one place.
