# Math Sprout

Math Sprout is a parent-managed math practice app for grades 2–4. A guardian account owns each child profile. Practice starts only when that guardian's consent is `granted`.

This slice records practice attempts. Each attempt is idempotent, can be queued offline, and returns a four-beat response with a soft client view. XP is a mint-only ledger: a sprout or a quiet sprout is written in the same transaction as the attempt, and nothing subtracts it later. There is no shop, streak, tutor chat, or score.

## Run locally

Requirements: Node.js 22 and npm.

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:43123](http://127.0.0.1:43123).

The app creates `data/math-sprout.sqlite` on first use. Override the path with `DATABASE_PATH` (see `.env.example`). Copy that file to `.env.local` if you want the variables loaded automatically.

```bash
npm test
npm run lint
npm run build
npm start
```

`npm start` serves the production build on port `43123`, or `PORT` if you set it.

## What you can do

1. Create a parent account or log in. Children do not sign up.
2. Add a child. Timezone is required on the profile. If you leave the default selected, the server stores your timezone, or `America/Los_Angeles` when yours is unset.
3. Grant, pause, or revoke consent from the parent home. Only `granted` allows practice.
4. Open the child home. The Start practice button stays disabled until consent is granted. Missing, paused, and revoked consent do not start a session.
5. With consent granted, start practice. Answer a problem from the operations or fractions pack. The response names what went well, one focus, what to try next, and a lock-in. It does not show a score or a confidence number.
6. If the connection drops, the answer stays in a device queue and syncs with the same idempotency key when the connection returns. A replay returns the original attempt and the original event ids.

## Deferred

Revoke sets consent to `revoked` and blocks practice. It does not delete the guardian, the child, or the consent row.

Account, child, and consent delete hooks are not in this slice. A later version should stop any in-flight practice, then cascade or anonymize the attempt ledger. Do not describe this slice as consent-complete, or as a production revoke-and-delete flow.

## API

The same Next.js server is the API. All child and consent routes require the parent session cookie set by signup or login.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/signup` | Create a guardian. Body: `email`, `password`, optional `timezone`. |
| POST | `/api/auth/login` | Log in. Body: `email`, `password`. |
| POST | `/api/auth/logout` | End the session. |
| GET | `/api/auth/me` | Current guardian. |
| POST | `/api/children` | Create a child. Body: `displayName`, optional `timezone`. |
| GET | `/api/children` | List the signed-in guardian's children. |
| POST | `/api/children/:id/consent` | Body: `{ "action": "grant" \| "pause" \| "revoke" }`. |
| GET | `/api/children/:id/consent` | Current consent status. |
| GET | `/api/children/:id/home` | `{ practiceAllowed, reason?, child }`. |
| GET | `/api/parent/home` | Guardian plus children and consent. |
| POST | `/api/children/:id/sessions` | Start a practice session when consent is `granted`. Returns `{ sessionId, item }`. |
| POST | `/api/children/:id/attempts` | Submit one try. Body: `idempotencyKey`, `sessionId`, `itemId`, `answer`, `shownAt`, `submittedAt`. The same key returns the original attempt, four-beat copy, `clientView`, and `eventIds`. |

Passwords are hashed with scrypt. The session cookie is `HttpOnly` and `SameSite=Lax`. Set `COOKIE_SECURE=true` when the site is served over HTTPS.

## Deploy

This is one Node process and one SQLite file. It is meant for a single host, not a multi-instance serverless platform.

```bash
npm ci
npm run build
DATABASE_PATH=/var/lib/math-sprout/app.sqlite COOKIE_SECURE=true PORT=43123 npm start
```

Keep the SQLite directory on persistent disk. Put HTTPS in front of the process (Caddy, nginx, or the platform proxy) and send `X-Forwarded-Proto: https` if the proxy terminates TLS.

Docker:

```bash
docker build -t math-sprout .
docker run --rm -p 43123:43123 -v math-sprout-data:/data -e COOKIE_SECURE=true math-sprout
```

The image listens on `43123` and stores the database at `/data/math-sprout.sqlite`.

## Tests

`npm test` covers consent gating, `child.timezone` persistence, and practice attempts:

- timezone is `NOT NULL` on the child table
- an explicit IANA timezone is stored and returned
- an omitted timezone uses the guardian timezone, then `America/Los_Angeles`
- an invalid timezone is rejected
- practice is allowed only when consent is `granted`
- pause and revoke block practice again
- a blocked practice click does not start a session
- the same idempotency key replays the original attempt and event ids
- an empty answer, a too-fast answer, and a spam window stay in the review lane (`quietXp` or `none`)
- the celebration tier and the XP mint commit together
- an offline queue reconciles through that same key
- the attempt response has `correct`, four beats, and a soft-state `clientView` with no score or confidence
- the item stub covers grades 2–4 operations and fractions
