# uniboh — Unibo MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server (stdio transport, TypeScript) that exposes University of Bologna services to MCP clients. Today it covers:

- **virtuale.unibo.it** — the Unibo Moodle instance, via its `service.php` AJAX API (enrolled courses, course state, Panopto content).
- **corsi.unibo.it** — public course timetables, normalized to events and exported as an ICS calendar.

The longer-term goal is to wrap **any Unibo service** (AlmaEsami, RPS, and others) behind one MCP server — see [CLAUDE.md](CLAUDE.md).

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

## Authentication

Authenticated Virtuale tools need both a `sesskey` and a cookie header. Three ways to provide them:

1. **`VIRTUALE_SESSKEY` + `VIRTUALE_COOKIES` env vars** — set once at startup.
2. **`virtuale_bootstrap_session`** — paste a `sesskey` + cookies grabbed from a logged-in browser; returns a `session_id`. **This is the most reliable path** for accounts behind Unibo SSO/MFA.
3. **`virtuale_login_with_password`** — best-effort form login. It scrapes the Moodle login form and posts credentials. This **will fail for accounts on federated SSO/MFA** (most Unibo accounts); prefer bootstrap for those.

Session data is kept in server memory only and is never written to disk. Treat `sesskey` + cookies as account-bound secrets.

## Tools

### Session management
- `virtuale_login_with_password` — form login → stores session, returns `session_id` + `sesskey`.
- `virtuale_bootstrap_session` — build a session from an existing `sesskey` + cookies.
- `virtuale_get_session_info` — stored session metadata (optionally the cookie header).
- `virtuale_logout_session` — drop one session from memory.
- `virtuale_health_check` — no-login `core_get_string` probe for connectivity.

### Virtuale (authenticated)
- `virtuale_get_enrolled_courses` — wraps `local_uniboapi_get_enrolled_courses_unibo`.
- `virtuale_get_course_state` — wraps `core_courseformat_get_state`, parses the state JSON.
- `virtuale_get_panopto_content` — wraps `block_panopto_get_content`.

Each accepts an optional `session_id`; if omitted, the env-var session is used.

### Timetable / calendar (public, no auth)
- `unibo_calendar_resolve_timetable_url` — find the corsi.unibo.it timetable URL from a course page.
- `unibo_calendar_list_curricula` — list curricula from `@@available_curricula`.
- `unibo_calendar_list_teachings` — extract teaching IDs from the timetable page.
- `unibo_calendar_get_events` — fetch `@@orario_reale_json` events, optional teaching-code filter.
- `unibo_calendar_get_ics` — same, returned as an ICS calendar string.

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
