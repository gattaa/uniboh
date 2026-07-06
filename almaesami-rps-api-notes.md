# AlmaEsami & RPS — reconnaissance notes

Groundwork for adding these services to the MCP server. Everything below was observed
from unauthenticated probing on 2026-07-07; the authenticated data endpoints still need to
be mapped from a logged-in session.

## Shared fact: everything is behind ADFS SAML SSO

Both services (and Virtuale) federate to the **same identity provider**:

```
https://idp.unibo.it/adfs/ls/?SAMLRequest=...&RelayState=...
```

This is Microsoft **ADFS** (`/adfs/ls/`), i.e. SAML 2.0 / WS-Federation, almost certainly
with MFA for student accounts. Consequences for this project:

- **Scripted username/password login is not viable** for these services — the ADFS form
  plus MFA can't be driven by a simple form POST (the same limitation the Virtuale
  `login_with_password` tool already documents).
- The dependable auth pattern is **bootstrap-with-cookies**: the user authenticates in a
  normal browser (doing SSO/MFA once), then exports the authenticated **session cookie for
  that specific host**, which the server replays. This mirrors `virtuale_bootstrap_session`,
  but the cookie is per-host, not a Moodle `sesskey`.

An eventual generic `<service>_bootstrap_session` tool + a per-host session store is the
natural shape.

## AlmaEsami (almaesami.unibo.it)

- **Stack:** Java servlet app (Apache front, `Set-Cookie: JSESSIONID=...; Path=/almaesami`).
  Front-end uses **Dojo 1.3.0**.
- **Entry:** `https://almaesami.unibo.it/` → `/almaesami/` → meta-refresh to
  `welcome.htm` (public landing, `<title>Benvenuto in AlmaEsami</title>`).
- **Areas:** `welcome.htm` links to `studenti/home.htm` (students) and
  `personale/home.htm` (staff).
- **Auth trigger:** requesting `/almaesami/studenti/home.htm` unauthenticated returns
  `302 → idp.unibo.it/adfs/ls/?SAMLRequest=...&RelayState=?spidL=1&spidACS=0`.
- **Session:** authenticated state is carried by `JSESSIONID` scoped to `/almaesami`.
- **App model:** ICEfaces + Spring Web Flow. URLs carry an `execution=eNsN` flow token; a
  fresh GET to a `-list.htm` endpoint starts a new flow (`302 → ?execution=...`) and renders,
  so the token does not need to be supplied. Responses are HTML (scrape with cheerio); there
  is no JSON API.

### Mapped (implemented)

- **Exam plan** — `GET /almaesami/studenti/attivitaFormativaPiano-list.htm`
  (`<title>Riepilogo Esami Studente</title>`). The activities grid is
  `table.iceDataTblOutline`; each data `<tr>` has 7 `<td>`:
  `[0]` expand toggle, `[1]` year, `[2]` `"CODE - NAME"`, `[3]` CdS, `[4]` CFU,
  `[5]` status/description, `[6]` action (`prenota` / `Leggi` / empty).
  Implemented by `src/almaesami.ts` → `almaesami_get_exam_plan` (read-only).
  Note: cell `[2]` name may itself contain `" - "` (e.g. "CLINICAL CLERKSHIP - BASIC LIFE
  SUPPORT"), so split code/name on the **first** separator only.

### TODO (needs auth)

- Other `/almaesami/studenti/` endpoints: `cronologia-list.htm` (exam history/booking
  cronology), `messaggioStudente.htm` (messages). Booking (`_eventId=prenota`) is a
  stateful JSF postback and a consequential real-world action — intentionally left
  unautomated.

## RPS (rps.unibo.it)

- **Stack:** looks like a **CakePHP** app — the SAML `RelayState` points at
  `https://rps.unibo.it/users/login?redirect=%2F` (`/users/login` is the CakePHP
  convention).
- **Auth trigger:** requesting `/` unauthenticated returns
  `302 → idp.unibo.it/adfs/ls/?SAMLRequest=...&RelayState=.../users/login...` (SAML request
  is signed: `SigAlg=...rsa-sha256`).
- **Session:** expect a CakePHP session cookie (e.g. `CAKEPHP=...`) after SSO.
- **TODO (needs auth):** identify what RPS actually manages for the student view and its
  routes/JSON endpoints.

## How to map the authenticated endpoints

1. Log into the service in a browser (complete SSO + MFA).
2. Open DevTools → Application → Cookies, copy the authenticated host cookie
   (`JSESSIONID` for AlmaEsami; the CakePHP session cookie for RPS).
3. Replay requests to the student pages with that `Cookie` header and record the response
   shapes here, then build a client module + tools following the `calendar.ts` pattern
   (pure parsers, unit-tested; network calls thin).

Cookies are short-lived, account-bound secrets — keep them in memory only, never commit.
