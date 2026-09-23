# Math Sprout

Math Sprout is a parent-managed math practice app for grades 2–4. This slice is identity and consent only: a guardian account, a child profile with a required timezone, and a practice button that stays blocked until that guardian grants consent.

There is no practice economy. No sessions, attempts, items, XP, streaks, or progress history.

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
4. Open the child home. The Start practice button is visible and disabled until consent is granted. Clicking it while blocked does not start a session. This version never starts a session. The child home uses the guardian session. Children do not have their own login.

## Deferred

Revoke sets consent to `revoked` and blocks practice. It does not delete the guardian, the child, or the consent row.

Account, child, and consent delete hooks are not in this slice. A later version should stop any in-flight practice, then cascade or anonymize records once practice ledgers exist. Do not describe this slice as consent-complete, or as a production revoke-and-delete flow.

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
| GET | `/api/parent/home` | Guardian plus children and consent. No practice progress. |

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

`npm test` covers consent gating and `child.timezone` persistence:

- timezone is `NOT NULL` on the child table
- an explicit IANA timezone is stored and returned
- an omitted timezone uses the guardian timezone, then `America/Los_Angeles`
- an invalid timezone is rejected
- practice is allowed only when consent is `granted`
- pause and revoke block practice again
- a blocked practice click does not count as a session
