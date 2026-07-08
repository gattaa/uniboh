# Studenti Online (SOL) — reconnaissance notes

Groundwork for the `sol_*` tools (studenti.unibo.it). Status: **first integration, partly
unverified.** The auth model and public-side behaviour were confirmed by unauthenticated
probing; the authenticated home-page parsers were derived from a *single* logged-in capture
and have not been cross-checked against a second account, so their selectors are best-effort.

## Shared fact: same ADFS SAML SSO as the rest of the estate

Like Virtuale / AlmaEsami / RPS, SOL federates to `idp.unibo.it/adfs/ls/`. So the same
`unibo_browser_login` headless flow captures its cookie in one pass off the shared IdP
session, and `sol_bootstrap_session` (paste a cookie) is the dependable MFA path. See
[almaesami-rps-api-notes.md](almaesami-rps-api-notes.md) for the shared SSO details.

## Stack & auth

- **Stack:** Java Spring Web Flow servlet app (Dojo front-end, `execution=eNsN` flow tokens
  in URLs), the same family as AlmaEsami. No JSON API — pages are server-rendered HTML,
  scraped with cheerio.
- **Session:** an authenticated `JSESSIONID` cookie scoped to `/sol`, captured after
  completing SSO. Env fallback `SOL_COOKIES`; per-call `cookies` / `session_id` overrides.
- **Base:** `https://studenti.unibo.it` (override `SOL_BASE_URL`).

### Auth-detection (verified against public probing)

- Unauthenticated GET of the authenticated home `/sol/studenti/homeStudentiOnline.htm`
  → `302 → idp.unibo.it/adfs/ls/?SAMLRequest=…`.
- The public root `/sol/` → `302 → /sol/welcome.htm` (public landing).
- **Sign-out gotcha (unlike RPS):** the authenticated SOL page's logout link is a *local*
  `/sol/logout.htm`, **not** the ADFS `wa=wsignout1.0` URL — so a `SAMLRequest` marker in the
  body is a safe "expired" signal (absent when authenticated). `isSolAuthExpired()` therefore
  treats any of {final URL on the IdP, final URL on `/sol/welcome.htm`, a `SAMLRequest`
  form/marker} as expired.

## Mapped (implemented) — from the authenticated home page

All read-only, all sourced from `/sol/studenti/homeStudentiOnline.htm`. **UNVERIFIED across
accounts** (single capture); individual fields degrade to `""`/`null` rather than throwing,
and a wholly unrecognisable page throws.

- **Career summary** → `sol_get_career` (`src/sol.ts` `parseCareer`):
  - greeting `.titoloPagina`;
  - identity `.identity .nome-cell p` (name), `p.cell` (short code — *assumed* matricola,
    unverified), `.email a` (institutional email);
  - enrolled programme: the `.quickInfo .box` whose `<h3>` is "Corso di studio", its `<a>`
    text `"Name (code)"`;
  - in-progress requests: `.elementiAttivi` — selected `.tab li.selected`, the panel summary
    text, a `hasRequests` flag inferred from the Italian "non hai richieste" notice
    (unverified beyond the empty case), and the "Vedi tutte" → `storicoRichieste` link.
- **Service catalogue** → `sol_get_services` (`parseServices`): the `.contenutiCol .box ul li`
  tiles, each `<h4><a>` (name/link) + `<p><a>` (description). Lets a caller discover what the
  portal exposes (fees, certificates, enrolment, …) without hard-coding routes.

## Deliberately NOT automated (write / consequential)

Everything behind the service tiles mutates real academic/financial state and is out of
scope: paying fees (`situazioneTasse`), new enrolment/career requests, degree applications,
certificate generation. `sol_get_services` only *lists* these links.

## TODO (needs auth to map)

- Confirm the identity short-code is the matricola, and the `hasRequests` non-empty layout.
- Fees detail (`situazioneTasse`): amounts, deadlines, paid/unpaid status — the single most
  valuable next read. Needs a logged-in capture of that page's grid.
- Career/exam-registration history (`storicoRichieste`) as a structured read.
- Cross-check every selector against a second account / degree programme.
