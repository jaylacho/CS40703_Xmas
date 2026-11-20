# Meeting API

Run `npm ci` and `npm run dev:api` with Node 20+ and server environment variable `OPENROUTER_API_KEY`. Default origin is `http://localhost:8787`. Rooms and participant sessions are kept in one server process. A restart ends the meeting. The web client polls the owner’s view after actions and while the room is open.

## Join and resume

`POST /rooms` with `{"goal":"Understand lunch queues","host":"Chair"}` returns `{"roomId":"…","sessionToken":"…"}`. `POST /rooms/:id/join` with `{"user":"Min"}` returns `{"ok":true,"sessionToken":"…"}`. Keep this opaque token in the participant’s tab and send it on subsequent calls in the `X-CrossCheck-Session` header. Use HTTPS when deployed. Share only the room code in an invitation. Reloading a tab restores its session. Joining an occupied name requires that member’s original token.

## Actions

The following paths are relative to `/rooms/:id`. POST bodies are JSON. Each action uses the session header. A client may include its own display name as `user`. Group posts return promptly and agent-generated cards appear on later polls. A private message returns after the owner’s direct reply has been stored; the background work for a group post runs independently.

| Method and path | Example request | Result |
| --- | --- | --- |
| `GET /view` | Session header | Shared room fields, `group`, `agreement`, `decisions`, and this owner’s `private` items. |
| `POST /private` | `{"text":"How does my method differ from Jia’s?"}` | Private reply and an optional draft. Send an optional owner-visible `cardId` or public `groupMessageId` for a follow-up. A new topic can omit both. |
| `POST /group` | `{"text":"How could we measure queue length?"}` | Public post. The other members’ agents may each produce a private suggestion or stay silent. |
| `POST /angle` | `{"angle":"Sampling method","intent":"find_contribution"}` | Host/Moderator integration. Recall requires verified owner-authored evidence. Use `invite_brainstorm` for a new idea or question without prior evidence. The Moderator’s existing silence trigger uses recall. |
| `POST /private` from a public angle | `{"text":"Help me think of a method.","groupMessageId":"msg_9","intent":"invite_brainstorm"}` | Starts a private brainstorm for the requesting member. |
| `POST /share` | `{"cardId":"card_7","text":"Count both lines every ten minutes.","mode":"anonymous"}` | Publishes the owner-confirmed text for a share suggestion. Use `named` to show their name. |
| `POST /concern` | `{"cardId":"card_12","text":"Could we start with two sites?","mode":"named"}` | Same confirmation boundary for a concern. |
| `POST /dismiss` | `{"cardId":"card_7"}` | Dismisses the owner’s draft privately. |
| `POST /check/start`, `POST /check/compare` | `{}` | Host asks the existing Moderator to open a check or compare submitted interpretations. |
| `POST /check/answer` | `{"checkId":"check_11","label":"Two sites","approve":false}` | The interpretation and the separate, explicit approval apply only to this check. The member can update an answer on an open check. |
| `POST /check/revise` | `{"checkId":"check_11","decision":"Run a pilot at two cafeterias."}` | Host opens a new version with its own ID, fresh private checks and zero approvals. Requests using the old check ID are rejected. |

### Example delivery

A private item in Min’s view may look like this. The private explanation and the editable draft are separate fields. The evidence references a real owner-authored message in the same room. IDs below are illustrative.

```json
{"type":"card","id":"p_8","at":1795073067616,"card":{"kind":"share_suggestion","id":"card_7","source":"react","nudge":"Your plan to count both lines supplies a field measurement.","draft":"Count both lines every ten minutes.","evidenceIds":["p_2"],"status":"open"}}
```

After Min edits the text and confirms anonymous sharing, the public list gains an item such as the following. The owner’s private card, message IDs, explanations and session token stay outside the group channel.

```json
{"id":"msg_10","at":1795073069620,"kind":"user","author":"Anonymous","anonymous":true,"text":"Start at the two cafeteria doors."}
```

The proposal view includes `checkId`, `version`, `approvedCount` and `askedOf`. Personal explanations and evidence are carried on the owner’s `understanding_check` card. A model suggestion cannot cast a vote. The decision log records the exact proposal wording once every member explicitly approves the same version and the Moderator finds the interpretations aligned.

Authentication or participant-scope errors return HTTP 403. A stale card, closed check or invalid confirmation returns an error. A failed direct Personal Agent call returns 503 so the client can retry. The public API has no model-trace endpoint.

For executable requests against a temporary HTTP server, see [the room flow test](../tests/room-flow.test.ts). The normal test suite injects model responses. `npm run test:live` sends the test meeting to OpenRouter with the server key.
