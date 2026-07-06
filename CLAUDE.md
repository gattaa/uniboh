# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`uniboh` is a **TypeScript MCP server** (stdio transport) that exposes University of
Bologna services to MCP clients. It currently wraps:

- **virtuale.unibo.it** — the Unibo Moodle instance, via its `service.php` AJAX API.
- **corsi.unibo.it** — public course timetables, normalized to events + ICS.
- **almaesami.unibo.it** — student exam plan ("Riepilogo Esami"), read-only HTML scrape.

## Vision

The goal is for this server to be a **single MCP gateway to _any_ Unibo service**, not just
Virtuale and timetables. Planned/wanted integrations:

- **AlmaEsami** (almaesami.unibo.it) — exam listings, booking/registration status, results.
- **RPS** — reservation/booking service (study seats, resources).
- Studenti Online, library (SBA/OPAC), and other unibo.it subsystems as they come up.

When adding a new service, keep the existing shape: one client module per service, one thin
tool-registration block per capability, session/auth handled the same way as Virtuale.

## Layout

```
src/
  server.ts          MCP server: registers every tool, owns the in-memory session store
  virtualeClient.ts  Moodle AJAX client (service.php + service-nologin.php)
  login.ts           Best-effort HTML form-login scraper (sesskey + cookies)
  calendar.ts        corsi.unibo.it timetable → normalized events → ICS (pure + fetch)
  almaesami.ts       AlmaEsami exam-plan scraper (pure parseExamPlan + fetch getExamPlan)
  *.test.ts          node:test unit tests, excluded from the build
```

`dist/` is build output (gitignored). Reference notes for the reverse-engineered APIs live in
`virtuale.unibo.it-api-notes.md` and `unibo-timetable-calendar-api.md`.

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
