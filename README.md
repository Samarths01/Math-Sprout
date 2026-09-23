# Math Sprout

Math Sprout is a parent-managed math practice app for grades 2–4. A guardian account owns each child profile. Practice starts only when that guardian's consent is `granted`.

Practice attempts are idempotent, can be queued offline, and return `correct`, four beats, and a `ClientView` (`bandLabel`, `showConceptChip`, `celebrationTier` of `none`, `quietXp`, or `full`). There is no score and no confidence value.

Slice 3 adds learner state and progression. A rules `MasteryEstimator` maps attempt evidence to the soft-state bands. Got it and a slightly-harder step need Recommended or Challenge evidence in the recent window, so a Review lane cannot pretend a skill is finished. Lane choice (Recommended, Challenge, or Review with skills still going) happens at the end of a session. Recommended is the default. Chips are stored per skill and come back on the next session.

Slice 4 replaces the quiet-mint stub. XP is an append-only credit on the QualifyingEvent bus, written in the same transaction as the attempt. `celebrationTier` is derived from those mints: `full` is not stored without a credit, and review stays `quietXp` or `none`. A review week is capped (`review_sessions_per_week`, stub 3). The boundary shows how many review sets are left, and the server drops the mint when the week is used up. Review never mints LevelUpSlight, a badge, or a build piece.

A qualifying practice day is an honest Recommended or Challenge try on the child's local calendar day. That event is the only heat. The first qualifying day sets the streak to Warm. A qualifying day on the next calendar day, while the flame is still Hot, Warm, or Ember, sets it to Hot. Any longer gap starts again at Warm. The same local day does not heat again. With no new qualifying day, the flame cools to Ember until `ember_expires_at`, then to Dormant. The server stores `streak_state`, `ember_expires_at`, and `last_qualifying_day` using `child.timezone`. Nothing subtracts XP.

Slice 5 projects that bus onto the child companion. One BuildGoal is active. Its pieces are the `BadgeMilestone`, `BuildPieceUnlock`, and `LevelUpSlight` rows already on the bus, in that order. A hot streak is the `BuildPieceUnlock` whose source is `streak_hot`. There is no piece balance, no shop, and no second XP ledger. The badge screen lists `BadgeMilestone` rows. The sprout on the child home follows the streak machine: Warm, Hot, Ember, or Dormant. Ember is the only state with a recovery affordance, and that affordance is a careful practice try, still behind consent. The parent home still does not tell a progress story.

Each attempt and practice session stores `policy_version` (`rules-v0`). The server attempt log carries that same string with the concept, item, difficulty, lanes, correctness, latency, integrity flags, session id, and idempotency key. Kids still receive only `ClientView`. Production scoring stays the rules `MasteryEstimator`. The eval harness that baselines later policies against `rules-v0` is Signal-owned and offline. This app does not run a second scorer.

Architecture §21 supersedes treating those integrity fixtures as a Slice 2 exit. Full XP, a badge, and a build piece are not minted for an empty answer, a too-fast answer, a duplicate key, or identical spam. `ClientView` stays free of a score percent, confidence, and judgment copy.

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
6. If the connection drops, the answer stays in a device queue and syncs with the same idempotency key when the connection returns. A replay returns the original attempt, the original `ClientView`, and the original event ids. That response is the saved try, not an empty 409. Pause holds the queue until consent is granted again. Revoke drops the queued try and does not keep the answer. Neither pause nor revoke syncs a new learning event.
7. End the session to pick the next lane. Recommended is the usual choice. Challenge is a step up. Review shows up when a skill is still short of Got it, with how many review sets are left this week. A little harder is offered only after Recommended or Challenge evidence supports it. After the weekly review cap, that choice does not mint a sprout.
8. On the child home, the sprout shows the flame and the one active build. Open spots fill when the bus mints a badge, a slightly harder step, or a hot-streak piece. Badges are listed on their own screen. If the flame is an ember, practice today is the way to bring it back.

## Deferred

Revoke sets consent to `revoked` and blocks practice. A pending device queue is dropped and the stored answer is removed. It does not delete the guardian, the child, the consent row, or the attempt ledger. Pause sets consent to `paused`, blocks new practice, and leaves the device queue in place until a parent grants consent again.

Account, child, and consent delete/export cascades are not in this slice. COPPA verification method is not in this slice. Do not describe this slice as consent-complete, as a production revoke-and-delete flow, or as a cleared kid-reachable mint beyond the replay, queue-disposition, and `rules-v0` fixtures.

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
| GET | `/api/children/:id/companion` | The child companion: one active BuildGoal, badge rows, and the streak surface. Pieces and badges are projections of QualifyingEvent ids. Ember includes a recovery copy key. This payload has no XP total, score, or confidence. |
| GET | `/api/parent/home` | Guardian plus children and consent. |
| POST | `/api/children/:id/sessions` | Start or resume a practice session when consent is `granted`. Returns `{ sessionId, item, lane, atBoundary, clientView }`. `clientView` is the stored chip for that problem's skill, when one exists. |
| POST | `/api/children/:id/attempts` | Submit one try. Body: `idempotencyKey`, `sessionId`, `itemId`, `answer`, `shownAt`, `submittedAt`. The same key returns HTTP 200 with the original attempt, four-beat copy, `clientView`, and `eventIds`. It does not return an empty 409. A new try while consent is paused returns 403 with `queueDisposition: "hold"`. A new try while consent is revoked or missing returns 403 with `queueDisposition: "drop"`. `eventIds` are the QualifyingEvent ids for that try. XP credits point at those ids. |
| POST | `/api/children/:id/sessions/:sessionId/end` | Reach the session boundary after at least one try. Returns lane options, including `reviewSessionsRemaining`. A second call does not fire LevelUpSlight again. |
| GET | `/api/children/:id/sessions/:sessionId/boundary-options` | Lane menu. Only while the session is at that boundary. Recommended is the default. Review shows skills still going and review sets left this week. |
| POST | `/api/children/:id/sessions/:sessionId/lane` | Body: `{ "lane": "recommended" \| "challenge" \| "review" }`. Closes the session and stores the lane for the next one. |

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
- the same idempotency key replays the original attempt, `ClientView`, and event ids, including after the session has ended, and that HTTP response is 200 rather than an empty 409
- pause holds a pending device queue and does not mint; grant flushes it
- revoke drops that queue, removes the answer, and does not mint, including if the same key is enqueued again
- an empty answer, a too-fast answer, and a spam window stay in the review lane (`quietXp` or `none`)
- the celebration tier and the XP mint commit together
- an offline queue reconciles through that same key
- the attempt response has `correct`, four beats, and a soft-state `clientView` with no score or confidence
- the item stub covers grades 2–4 operations and fractions

Slice 3 adds:

- soft-state chips follow attempt history, and one clean try stays "Getting it"
- Got it and LevelUpSlight need Recommended or Challenge evidence; Review cannot supply it
- a slightly-harder boundary event fires when that policy says so, once per session
- lane options exist only at the session boundary, and Recommended is the default
- skill chips are still there on the next session

Slice 4 adds:

- XP credits reference a QualifyingEvent; a replay does not mint a second credit
- `celebrationTier` matches the mints in that transaction, and `full` without a credit fails closed
- review sessions per week are capped at the mint, and review cannot mint LevelUpSlight, a badge, or a build piece
- QualifyingPracticeDay heats Warm on the first qualifying day, and Hot on the next calendar day while the flame is still alive, using `child.timezone`
- attempts and sessions store `policy_version` `rules-v0`, and the server attempt log includes it
- empty, too-fast, duplicate-key, and identical-spam responses keep `ClientView` free of score, confidence, and judgment copy, and do not mint full XP, a badge, or a build piece

Slice 5 adds:

- one active BuildGoal, filled only by bus `BadgeMilestone`, `BuildPieceUnlock`, and `LevelUpSlight` rows
- a hot-streak piece is the existing `streak_hot` unlock, and a replay does not add another piece
- the badge screen lists bus `BadgeMilestone` rows
- Ember is the only streak state with a recovery affordance, and Warm, Hot, and Dormant are not
- the child home and parent home payloads stay free of a second progress ledger
