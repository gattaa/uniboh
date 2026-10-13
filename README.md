# uniboh — Unibo MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server (stdio transport, TypeScript) that exposes University of Bologna services to MCP clients. Today it covers:

- **virtuale.unibo.it** — the Unibo Moodle instance, via its `service.php` AJAX API (enrolled courses, course state, file/resource download, Panopto content).
- **corsi.unibo.it** — public course timetables, normalized to events and exported as an ICS calendar.
- **almaesami.unibo.it** — student exam plan, history, messages, and upcoming appelli, read-only.
- **rps.unibo.it** — student attendance ("Presenze studenti"): records and register, read-only.
- **studenti.unibo.it** — Studenti Online (SOL): career summary and service catalogue, read-only.

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
| `SOL_BASE_URL` | no (defaults to `https://studenti.unibo.it`) | Studenti Online base URL. |
| `SOL_COOKIES` | no | Cookie header with an authenticated `JSESSIONID`; fallback for the `sol_*` tools. |
| `EMAIL` | no | Unibo SSO email; with `PASSWORD`, enables automatic headless-Chromium ADFS login (Virtuale + AlmaEsami + RPS + Studenti Online) on first use, `unibo_login`, and transparent auto re-login on session expiry. Shared across services since they all federate to the same idp.unibo.it SSO. |
| `PASSWORD` | no | Unibo SSO password. Only works for accounts without interactive MFA. On macOS, leave it unset and store it in the Keychain instead (read at startup): `security add-generic-password -U -s uniboh -a "$EMAIL" -w` (prompts for the password). |

## Authentication

All three authenticated services (Virtuale, AlmaEsami, RPS) federate to the same
`idp.unibo.it` ADFS SSO, so a **single unified in-memory session store** holds per-service
credentials: one `session_id` can carry a Virtuale `sesskey`+cookies, an AlmaEsami
`JSESSIONID`, and an RPS `PHPSESSID` at once. Authenticated Virtuale tools need both a
`sesskey` and a cookie header; AlmaEsami/RPS need only their host cookie. Ways to provide them:

1. **Env vars** — `VIRTUALE_SESSKEY` + `VIRTUALE_COOKIES`, `ALMAESAMI_COOKIES`, `RPS_COOKIES`, set once at startup.
2. **`EMAIL` + `PASSWORD`, automatic** — when no `session_id`/env credentials are given, the server drives a real headless Chromium through Unibo's ADFS SSO flow (Home Realm Discovery → AD login), then reuses the same shared IdP session to complete the AlmaEsami, RPS and SOL SAML handshakes too, capturing every host's cookies automatically and remembering that session as the default. Best-effort per service. **Only works for accounts without interactive MFA.** `unibo_login` runs the same login explicitly. See [`scripts/test-browser-login.mjs`](scripts/test-browser-login.mjs) to verify your account works before wiring it into an MCP client.
3. **`unibo_bootstrap_session`** — paste credentials grabbed from a logged-in browser (`service` + `cookies`, plus `sesskey` for Virtuale); returns a `session_id`. **The reliable path for accounts with MFA.** The cookie is never echoed back.

Precedence per call: explicit `cookies` > explicit `session_id` > env vars > the default browser-login session > automatic login (if `EMAIL` + `PASSWORD` are set) > error.

**Auto re-login.** When `EMAIL` + `PASSWORD` are set and a call fails because the session
expired, the server transparently re-runs the headless browser login once, updates the stored
credentials, and retries the call — but only for **env-backed or browser-login
sessions** (credentials that are ours to refresh), never for pasted `unibo_bootstrap_session`
credentials. Concurrent expiries share a single in-flight re-login so an expiry storm triggers
at most one browser login.

Session data is kept in server memory only and is never written to disk. Treat `sesskey` + cookies as account-bound secrets.

### Keeping secrets out of the model's context

If credentials are set via env vars (`VIRTUALE_SESSKEY`/`VIRTUALE_COOKIES`, `ALMAESAMI_COOKIES`, `RPS_COOKIES`), every tool already falls back to them silently when a call omits `cookies`/`session_id` — the model never has to see or pass the secret at all.

If you'd rather the model work with an explicit handle, call `unibo_login` (takes only an optional `force_relogin`); it reads `EMAIL`/`PASSWORD` server-side and returns only an opaque `session_id` that works across every authenticated tool. The underlying secret is never included in the response.

`unibo_bootstrap_session` takes credentials as tool input (by design, since you're supplying them inline), so those do pass through the model's context; it never echoes the pasted cookie back.

## Tools

### Session management
- `unibo_login` — normally unnecessary (tools log in automatically when `EMAIL`/`PASSWORD` are set). Mint/reuse **one** `session_id` (usable across all authenticated tools) by driving a headless Chromium through ADFS SSO and completing every service's SAML handshake off the shared IdP session; never returns the password/sesskey/cookies, and reports per-service success. No interactive-MFA support. Optional `force_relogin`.
- `unibo_bootstrap_session` — build a session from pasted credentials: `service` (`virtuale`/`almaesami`/`rps`/`sol`) + `cookies` (+ `sesskey` for Virtuale); the cookie is never echoed back.
- `unibo_get_session_info` — stored session metadata (origin, which services it carries, optionally the cookie headers).
- `unibo_logout` — drop one session from memory.
- `virtuale_health_check` — reports `{ok, reachable, authenticated}` (no-login probe; if credentials already exist, also a 1-course authenticated call; never starts a login).

### Virtuale (authenticated)
- `virtuale_get_enrolled_courses` — wraps `local_uniboapi_get_enrolled_courses_unibo`; HTML summaries, base64 course images and other bulky fields are stripped.
- `virtuale_get_course_state` — wraps `core_courseformat_get_state`, parses the state JSON (bulky HTML/icon fields stripped, long strings truncated).
- `virtuale_list_course_files` — slims `core_courseformat_get_state` down to the downloadable
  files/resources, grouped by section (`cmid`, `name`, `modname`, `url`) — a token-friendly
  view; feed a `cmid` to `virtuale_get_resource`.
- `virtuale_get_panopto_content` — wraps `block_panopto_get_content`.

Each accepts an optional `session_id`; if omitted, the env-var session is used.

- `virtuale_get_resource` — fetches a course file/resource by `cmid` (builds
  `/mod/resource/view.php?id=<cmid>`) or an explicit `url`, following the redirect to the
  protected `pluginfile.php` content. Always returns metadata (final URL, content-type, size,
  filename); with `save_to` (an absolute path) it streams the file to disk, otherwise it
  returns text inline for text-like files and extracts + returns the text of PDFs (long text is
  truncated — pass `save_to` for the full file). Accepts `session_id`, `cookies` (a header with
  an authenticated `MoodleSession`), or falls back to `VIRTUALE_COOKIES`. Read-only.

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
- `virtuale_quiz_sync_bank` — diffs a local quiz-bank JSON file (`bank_path`) against Moodle
  attempts by `attempt_id`, fetches only the new attempt reviews, and appends them to the
  file in the bank's schema (backing up to `<bank_path>.bak` first). `cmids` defaults to the
  bank's own `quizzes` list; `dry_run` reports what would be fetched without writing. Writes
  to disk; returns only a count summary, never question content.

Scoped to reviewing attempts already finished and reviewable under the quiz's own review
settings — it does not start, resume, or answer a live/in-progress attempt.

### Timetable / calendar (public, no auth)
- `unibo_calendar_resolve_timetable_url` — find the corsi.unibo.it timetable URL from a course page.
- `unibo_calendar_list_curricula` — list curricula from `@@available_curricula`.
- `unibo_calendar_list_teachings` — extract teaching IDs from the timetable page.
- `unibo_calendar_get_events` — fetch `@@orario_reale_json` events, optional teaching-code filter and optional `start`/`end` (YYYY-MM-DD; default: whole academic year).
- `unibo_calendar_get_ics` — same, returned as an ICS calendar string.

### AlmaEsami (authenticated)
All read-only. Each accepts `session_id` (from `unibo_login` or
`unibo_bootstrap_session`) or `cookies` (a cookie header with an
authenticated `JSESSIONID`), or falls back to `ALMAESAMI_COOKIES`.

- `almaesami_get_exam_plan` — the exam plan (activities, CFU, status, bookable flag).
- `almaesami_get_exam_history` — the exam history / cronologia (appello date, examiner,
  type/mode, status).
- `almaesami_get_messages` — student messages (subject, sender, date, related appello).
- `almaesami_list_appelli` — upcoming exam sessions (appelli): date/time, activity, examiner,
  type/mode, enrollment window, and a `bookable` flag — to answer "when can I sit exam X".
  **The endpoint/grid is UNVERIFIED** (it lives behind SSO and could not be confirmed against a
  live session): the result carries `unverified: true`, the parser reads fields by content so it
  tolerates layout changes, and the endpoint `path` is overridable. If it returns nothing, fall
  back to the `bookable` flags on `almaesami_get_exam_plan`.

These never mutate state: booking an exam ("prenota") and deleting messages ("Cancella")
are intentionally not automated.

AlmaEsami is behind ADFS SSO with no JSON API. If `EMAIL`/`PASSWORD` are set (non-MFA
account), automatic login captures the `JSESSIONID` automatically. Otherwise
authenticate the bootstrap way: log in via a browser, copy the `JSESSIONID` cookie for
`almaesami.unibo.it` (it expires after a short idle period), and hand it to
`unibo_bootstrap_session`. See [`almaesami-rps-api-notes.md`](almaesami-rps-api-notes.md).

### RPS — attendance (authenticated)
All read-only. Each accepts `session_id` (from `unibo_login` or
`unibo_bootstrap_session`) or `cookies` (a cookie header with an
authenticated `PHPSESSID`), or falls back to `RPS_COOKIES`.

- `rps_get_attendance_records` — recorded presences (date, subject, lecturer, duration).
- `rps_get_register` — per-subject hours attended and attendance percentage.

Confirming attendance by entering a "codice rilevazione" is a write action and is
intentionally not automated. If `EMAIL`/`PASSWORD` are set (non-MFA account),
automatic login captures the `PHPSESSID` automatically. Otherwise authenticate the
bootstrap way: log fully into `rps.unibo.it`, confirm you see the app (not the SSO Sign In
page), copy the `PHPSESSID` cookie, and hand it to `unibo_bootstrap_session`.

### Studenti Online — SOL (authenticated)
All read-only. Each accepts `session_id` (from `unibo_login` or
`unibo_bootstrap_session`) or `cookies` (a cookie header with an authenticated `JSESSIONID`),
or falls back to `SOL_COOKIES`.

- `sol_get_career` — the student's home/career summary: greeting/identity, enrolled course of
  study, and in-progress requests.
- `sol_get_services` — the catalogue of Studenti Online service tiles (name, link,
  description) — fees, certificates, enrolments, etc. — so a caller can discover what the
  portal exposes.

**First integration, partly unverified:** the `sol_*` readers were derived from a single
logged-in home-page capture, so selectors are best-effort and individual fields degrade to
empty rather than failing. Consequential pages behind the service tiles (paying fees, new
enrolment/career requests, degree applications) mutate real state and are intentionally **not**
automated. See [`sol-api-notes.md`](sol-api-notes.md).

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
