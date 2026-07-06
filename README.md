# MCP Unibo Server

TypeScript MCP server for Unibo Virtuale Moodle AJAX APIs.

## Progress tracking

- virtuale.unibo.it
- timetable.
    - analyze the implementation in https://github.com/FrancescoBonzi/UniboCalendar/tree/master
    - notes: ./unibo-timetable-calendar-api.md

## Local setup

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run (stdio transport):

```bash
VIRTUALE_BASE_URL="https://virtuale.unibo.it" \
VIRTUALE_SESSKEY="your_sesskey" \
VIRTUALE_COOKIES="MoodleSession=...; other_cookie=..." \
npm run dev
```

Run with dynamic login (no preloaded session env vars):

```bash
VIRTUALE_BASE_URL="https://virtuale.unibo.it" \
npm run dev
```

## Implemented MCP tools

- `virtuale_login_with_password`
    - attempts form login using email/password
    - stores authenticated cookies + sesskey in MCP memory
    - returns `session_id` and `sesskey`
    - can return cookie header when `include_cookie_header=true`
- `virtuale_bootstrap_session`
    - creates a server-side session from existing browser `sesskey` + `cookies`
    - returns `session_id` and can return cookie header when requested
- `virtuale_get_session_info`
    - returns stored session metadata and sesskey
- `virtuale_logout_session`
    - removes one stored session from MCP memory
- `virtuale_health_check`
    - no-login `core_get_string` probe for basic connectivity
- `virtuale_get_enrolled_courses`
    - wraps `local_uniboapi_get_enrolled_courses_unibo`
    - accepts optional `session_id`
- `virtuale_get_course_state`
    - wraps `core_courseformat_get_state` and parses returned state JSON
    - accepts optional `session_id`
- `virtuale_get_panopto_content`
    - wraps `block_panopto_get_content`
    - accepts optional `session_id`
- `unibo_calendar_resolve_timetable_url`
    - resolves timetable URL from a unibo.it course page URL
- `unibo_calendar_list_curricula`
    - lists available curricula from @@available_curricula
- `unibo_calendar_list_teachings`
    - extracts teaching IDs from timetable HTML page
- `unibo_calendar_get_events`
    - fetches @@orario_reale_json events with optional teaching-code filtering
- `unibo_calendar_get_ics`
    - returns an ICS string generated from timetable events

## Notes

- Authenticated methods require both cookies and `sesskey`.
- Keep cookie/session data private; it is account-bound and sensitive.
- Some Unibo accounts use federated SSO/MFA flows; direct password POST may fail for those accounts.

## Calendar flow example

1. Call `unibo_calendar_resolve_timetable_url` with the unibo.it course URL.
2. Call `unibo_calendar_list_curricula` with the returned timetable URL.
3. Optionally call `unibo_calendar_list_teachings` to get teaching IDs.
4. Call `unibo_calendar_get_events` or `unibo_calendar_get_ics` with `year`, `curriculum`, and optional teaching IDs.