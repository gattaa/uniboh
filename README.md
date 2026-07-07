# uniboh — Unibo MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server (stdio transport, TypeScript) that exposes University of Bologna services to MCP clients. Today it covers:

- **virtuale.unibo.it** — the Unibo Moodle instance, via its `service.php` AJAX API (enrolled courses, course state, Panopto content).
- **corsi.unibo.it** — public course timetables, normalized to events and exported as an ICS calendar.
- **almaesami.unibo.it** — student exam plan, history, and messages, read-only.
- **rps.unibo.it** — student attendance ("Presenze studenti"): records and register, read-only.

The longer-term goal is to wrap **any Unibo service** behind one MCP server — see
[CLAUDE.md](CLAUDE.md).

## Install

```bash
npm install
npm run build
```

## Run

Stdio transport, for use by an MCP client.

**No credentials** (health check + calendar tools only):

```bash
npm run dev
```

**With a preloaded session** (enables the authenticated Virtuale tools):

```bash
VIRTUALE_BASE_URL="https://virtuale.unibo.it" \
VIRTUALE_SESSKEY="your_sesskey" \
VIRTUALE_COOKIES="MoodleSession=...; other_cookie=..." \
npm run dev
```

`npm run start` runs the compiled `dist/server.js` instead of `tsx`.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `VIRTUALE_BASE_URL` | no (defaults to `https://virtuale.unibo.it`) | Moodle base URL. |
| `VIRTUALE_SESSKEY` | no | Moodle `sesskey`; with `VIRTUALE_COOKIES`, enables authenticated tools without a login call. |
| `VIRTUALE_COOKIES` | no | Cookie header (e.g. `MoodleSession=...`). |
| `ALMAESAMI_BASE_URL` | no (defaults to `https://almaesami.unibo.it`) | AlmaEsami base URL. |
| `ALMAESAMI_COOKIES` | no | Cookie header with an authenticated `JSESSIONID`; fallback for the `almaesami_*` tools. |
| `RPS_BASE_URL` | no (defaults to `https://rps.unibo.it`) | RPS base URL. |
| `RPS_COOKIES` | no | Cookie header with an authenticated `PHPSESSID`; fallback for the `rps_*` tools. |

## Authentication

Authenticated Virtuale tools need both a `sesskey` and a cookie header. Three ways to provide them:

1. **`VIRTUALE_SESSKEY` + `VIRTUALE_COOKIES` env vars** — set once at startup.
2. **`virtuale_bootstrap_session`** — paste a `sesskey` + cookies grabbed from a logged-in browser; returns a `session_id`. **This is the most reliable path** for accounts behind Unibo SSO/MFA.
3. **`virtuale_login_with_password`** — best-effort form login. It scrapes the Moodle login form and posts credentials. This **will fail for accounts on federated SSO/MFA** (most Unibo accounts); prefer bootstrap for those.

Session data is kept in server memory only and is never written to disk. Treat `sesskey` + cookies as account-bound secrets.

### Keeping secrets out of the model's context

If credentials are set via env vars (`VIRTUALE_SESSKEY`/`VIRTUALE_COOKIES`, `ALMAESAMI_COOKIES`, `RPS_COOKIES`), every tool already falls back to them silently when a call omits `cookies`/`session_id` — the model never has to see or pass the secret at all.

If you'd rather the model work with an explicit handle instead of an invisible fallback, call the corresponding env-session tool first — `virtuale_get_env_session`, `almaesami_get_env_session`, or `rps_get_env_session` — each takes no input, reads its env var(s) server-side, and returns only an opaque `session_id` (idempotent: repeat calls return the same id). Pass that `session_id` to the other tools for that service. The underlying `sesskey`/cookie is never included in any of these responses.

This only covers a single account per service. `virtuale_bootstrap_session` and `virtuale_login_with_password` still take credentials as tool input (by design, since you're supplying them inline), so those do pass through the model's context.

## Tools

### Session management
- `virtuale_login_with_password` — form login → stores session, returns `session_id`.
- `virtuale_bootstrap_session` — build a session from an existing `sesskey` + cookies.
- `virtuale_get_env_session` — mint/reuse a `session_id` from `VIRTUALE_SESSKEY`/`VIRTUALE_COOKIES` without ever returning the secret. See [Keeping secrets out of the model's context](#keeping-secrets-out-of-the-models-context).
- `virtuale_get_session_info` — stored session metadata (optionally the sesskey/cookie header).
- `virtuale_logout_session` — drop one session from memory.
- `virtuale_health_check` — no-login `core_get_string` probe for connectivity.

### Virtuale (authenticated)
- `virtuale_get_enrolled_courses` — wraps `local_uniboapi_get_enrolled_courses_unibo`.
- `virtuale_get_course_state` — wraps `core_courseformat_get_state`, parses the state JSON.
- `virtuale_get_panopto_content` — wraps `block_panopto_get_content`.

Each accepts an optional `session_id`; if omitted, the env-var session is used.

### Virtuale quizzes (authenticated, read-only)
`mod_quiz_*` isn't on the AJAX service allowlist, so these scrape the same HTML a browser
sees (course page → quiz page → attempt review page). Each accepts `session_id`,
`cookies` (a cookie header with an authenticated `MoodleSession`), or falls back to
`VIRTUALE_COOKIES`.

- `virtuale_quiz_list_course_quizzes` — quiz activities on a course page, with the `cmid`
  needed by the other quiz tools.
- `virtuale_quiz_list_attempts` — a quiz's attempt summaries (status, dates, marks, grade,
  review URL/attempt id) for finished attempts.
- `virtuale_quiz_get_attempt_review` — one finished attempt's questions, answer options,
  the student's selection, correctness, and feedback.

Scoped to reviewing attempts already finished and reviewable under the quiz's own review
settings — it does not start, resume, or answer a live/in-progress attempt.

### Timetable / calendar (public, no auth)
- `unibo_calendar_resolve_timetable_url` — find the corsi.unibo.it timetable URL from a course page.
- `unibo_calendar_list_curricula` — list curricula from `@@available_curricula`.
- `unibo_calendar_list_teachings` — extract teaching IDs from the timetable page.
- `unibo_calendar_get_events` — fetch `@@orario_reale_json` events, optional teaching-code filter.
- `unibo_calendar_get_ics` — same, returned as an ICS calendar string.

### AlmaEsami (authenticated)
All read-only. Each accepts `session_id` (from `almaesami_get_env_session`) or `cookies`
(a cookie header with an authenticated `JSESSIONID`), or falls back to `ALMAESAMI_COOKIES`.

- `almaesami_get_env_session` — mint/reuse a `session_id` from `ALMAESAMI_COOKIES` without ever returning the cookie.
- `almaesami_get_exam_plan` — the exam plan (activities, CFU, status, bookable flag).
- `almaesami_get_exam_history` — the exam history / cronologia (appello date, examiner,
  type/mode, status).
- `almaesami_get_messages` — student messages (subject, sender, date, related appello).

These never mutate state: booking an exam ("prenota") and deleting messages ("Cancella")
are intentionally not automated.

AlmaEsami is behind ADFS SSO with no JSON API, so authenticate the bootstrap way: log in
via a browser, then copy the `JSESSIONID` cookie for `almaesami.unibo.it` (it expires after
a short idle period). See [`almaesami-rps-api-notes.md`](almaesami-rps-api-notes.md).

### RPS — attendance (authenticated)
All read-only. Each accepts `session_id` (from `rps_get_env_session`) or `cookies`
(a cookie header with an authenticated `PHPSESSID`), or falls back to `RPS_COOKIES`.

- `rps_get_env_session` — mint/reuse a `session_id` from `RPS_COOKIES` without ever returning the cookie.
- `rps_get_attendance_records` — recorded presences (date, subject, lecturer, duration).
- `rps_get_register` — per-subject hours attended and attendance percentage.

Confirming attendance by entering a "codice rilevazione" is a write action and is
intentionally not automated. Authenticate the bootstrap way: log fully into
`rps.unibo.it`, confirm you see the app (not the SSO Sign In page), then copy the
`PHPSESSID` cookie.

### Calendar flow example
1. `unibo_calendar_resolve_timetable_url` with the unibo.it course URL.
2. `unibo_calendar_list_curricula` with the resolved timetable URL.
3. (optional) `unibo_calendar_list_teachings` to get teaching IDs to filter on.
4. `unibo_calendar_get_events` or `unibo_calendar_get_ics` with `year`, `curriculum`, and optional teaching codes.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node built-in test runner via tsx
npm run build       # emit dist/
```

Tests live next to sources as `src/*.test.ts` and are excluded from the build.

## Reference notes

- [`virtuale.unibo.it-api-notes.md`](virtuale.unibo.it-api-notes.md) — reverse-engineered Moodle AJAX endpoints.
- [`unibo-timetable-calendar-api.md`](unibo-timetable-calendar-api.md) — corsi.unibo.it timetable API.
- Timetable logic is informed by [FrancescoBonzi/UniboCalendar](https://github.com/FrancescoBonzi/UniboCalendar).

## License

ISC — see [LICENSE](LICENSE).
