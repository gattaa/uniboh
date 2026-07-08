# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`uniboh` is a **TypeScript MCP server** (stdio transport) that exposes University of
Bologna services to MCP clients. It currently wraps:

- **virtuale.unibo.it** — the Unibo Moodle instance, via its `service.php` AJAX API, plus
  course file/resource download and HTML-scraped quiz review.
- **corsi.unibo.it** — public course timetables, normalized to events + ICS.
- **almaesami.unibo.it** — student exam plan, history, messages, and upcoming appelli, read-only HTML scrape.
- **rps.unibo.it** — student attendance ("Presenze studenti"): records + register, read-only.
- **studenti.unibo.it** — Studenti Online (SOL): career summary + service catalogue, read-only HTML scrape.

## Vision

The goal is for this server to be a **single MCP gateway to _any_ Unibo service**, not just
Virtuale and timetables. Done so far: Virtuale (incl. file download + quiz review),
timetables/ICS, AlmaEsami (exam plan, history, messages, appelli), RPS (attendance records +
register), Studenti Online (career + services). Candidate next integrations:

- **Studenti Online** — deepen it: fees detail (amounts/deadlines/status), career/request history.
- Library (SBA / OPAC), AlmaRM, and other unibo.it subsystems as they come up.

When adding a new service, keep the existing shape: one client/scraper module per service,
one thin tool-registration block per capability, and the bootstrap-cookie auth model —
almost everything Unibo is behind the same `idp.unibo.it` ADFS SSO, so a browser-captured
per-host session cookie (env fallback + per-call override) is the reliable path. New
authenticated services should plug into the unified `SessionStore` in `src/sessions.ts`
(add the service to `ServiceName`/`CookieServiceName`) rather than inventing their own store.

## Layout

```
src/
  server.ts          MCP server: registers every tool
  sessions.ts        Unified in-memory SessionStore + shared auth-expiry detectors
  virtualeClient.ts  Moodle AJAX client (service.php + service-nologin.php)
  login.ts           Best-effort HTML form-login scraper (sesskey + cookies)
  browserAuth.ts     Headless-Chromium ADFS SSO login capturing cookies for every service
  calendar.ts        corsi.unibo.it timetable → normalized events → ICS (pure + fetch)
  virtualeFiles.ts   Virtuale course file/resource download (+ PDF text extraction)
  quiz.ts            Virtuale quiz review (HTML scrape)
  almaesami.ts       AlmaEsami scrapers (exam plan / history / messages / appelli)
  rps.ts             RPS attendance scrapers (attendance records + register)
  sol.ts             Studenti Online scrapers (career summary / service catalogue)
  *.test.ts          node:test unit tests, excluded from the build
```

`dist/` is build output (gitignored). Reference notes for the reverse-engineered APIs live in
`virtuale.unibo.it-api-notes.md`, `unibo-timetable-calendar-api.md`, `almaesami-rps-api-notes.md`,
and `sol-api-notes.md`.

## Conventions

- **ESM + NodeNext.** Relative imports use `.js` extensions even from `.ts` sources.
- **Zod** for every tool `inputSchema`. Tools return both `content` (text) and
  `structuredContent`.
- **Auth model:** authenticated calls need a `sesskey` + cookie header, resolved via
  `getClientForSession(session_id)` in `server.ts` — either a stored session or the
  env-var (`VIRTUALE_SESSKEY` + `VIRTUALE_COOKIES`) fallback. New authenticated services
  should reuse this session store rather than inventing their own.
- **Bootstrap over password login.** Most Unibo accounts are behind SSO/MFA, so
  `virtuale_login_with_password` is unreliable; `virtuale_bootstrap_session` (paste a
  browser `sesskey` + cookies) is the dependable path. Assume the same for future services.
- **Secrets stay in memory.** Never persist `sesskey`/cookies to disk or log them. Never
  commit credentials or `.env`.

## Commands

```bash
npm run dev        # run with tsx (stdio)
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm test           # node --test via tsx over src/**/*.test.ts
```

## Adding a tool

1. Add/extend a client module (e.g. `src/almaesamiClient.ts`) with the raw HTTP calls.
2. Put pure transforms (parsing, formatting) in that module and unit-test them — the
   network-free functions are the ones worth testing (see `calendar.test.ts`).
3. Register the tool in `server.ts` with a Zod `inputSchema`; thread `session_id` through
   `getClientForSession` if it needs auth.
4. Run `npm run typecheck && npm test`, then document the tool in `README.md`.
