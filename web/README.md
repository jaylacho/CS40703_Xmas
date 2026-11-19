# Web UI

Owners: Hamza, Jiyeon.

Put the web app here. Any stack works (React, Next.js, plain HTML). The UI does not call the model. It only calls the API server in `server/`.

## What to build

One page per participant, with two panels:

| Panel | Shows |
|---|---|
| Group chat | Messages from members and the moderator, the agreement count, the final decision |
| Private window | Chat with my personal agent, and the cards it shows: suggestion, agreement check, concern |

Plus a start screen (create a meeting or join one with a room code and a name).

## How to connect

1. In the repo root: `npm install`, then `npm run dev:api`. The API runs on http://localhost:8787 in mock mode. No key needed.
2. Poll `GET /rooms/:id/view?user=NAME` every 1 to 2 seconds and draw the screen from the result.
3. Send user actions with the `POST` endpoints.

Everything is listed in [docs/api.md](../docs/api.md), with a table that maps each screen element to a field and an endpoint.

To see what the agents do before the UI exists, run `npm run simulate` in the repo root.
