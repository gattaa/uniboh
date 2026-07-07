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

- **Exam history** — `GET /almaesami/studenti/cronologia-list.htm`. Same
  `table.iceDataTblOutline`; 6 columns per row: `[0]` date/time, `[1]`
  `"CODE NAME (Cds. NNNN)"` (space-separated code; CdS in a trailing `(Cds. …)`),
  `[2]` examiner, `[3]` type (`prova`/`listaAperta`), `[4]` mode (`Scritto`/`Orale`/…),
  `[5]` status. → `almaesami_get_exam_history`.

- **Messages** — `GET /almaesami/studenti/messaggioStudente.htm`. Same grid; 7 columns:
  `[1]` related appello ref (`"TEACHER: date time"`), `[2]` received date/time,
  `[3]` subject, `[4]` sender, `[5]` `Leggi`, `[6]` `Cancella`.
  → `almaesami_get_messages`.

- **Session expiry:** once the `JSESSIONID` goes stale, requests 302 to
  `/almaesami/sessionExpired.htm` (`<title>… sessione scaduta</title>`). The readers detect
  both this and the SSO bounce and raise a clear "re-capture the cookie" error.

### TODO (needs auth)

- Booking (`_eventId=prenota`) and message deletion (`Cancella`) are stateful JSF postbacks
  and consequential real-world actions — intentionally left unautomated.
- `personale/` (staff) area is unmapped.

## RPS (rps.unibo.it) — "Registro Presenze Studenti" (student attendance)

- **Stack:** CakePHP app; the SAML `RelayState` points at
  `https://rps.unibo.it/users/login?redirect=%2F`. Auth carried by **`PHPSESSID`** (the
  cookie must be captured *after* completing SSO, or it stays unauthenticated and `/`
  bounces to the IdP).
- **Auth trigger:** unauthenticated `/` → `302 → idp.unibo.it/adfs/ls/?SAMLRequest=...`.
  The signed-out state renders `<title>Sign In</title>` with a `name="SAMLRequest"` form.
- **Views (plain Bootstrap `<table>`, scraped):**
  - **Home** `/students` — form to enter a `codice rilevazione` and confirm attendance.
    This is a **write** (`GET /students/attendance/lesson?q_cod_ril=...`) — intentionally
    not automated.
  - **Rilevazioni** `GET /students/surveys?lang=it` — attendance records. `thead`:
    Data | Materia | Docente | Durata lezione. Subject cell is `"CODE NAME"` (space-split,
    name may contain `" / module"`). → `rps_get_attendance_records`.
  - **Registro** `GET /students/register?lang=it` — per-subject summary. `thead`:
    Materia | Ore | Perc. Percentuale (percentage in Italian format `"80,88%"`, may be
    empty). → `rps_get_register`.
- **Auth-detection gotcha:** an authenticated page still links to the ADFS *sign-out* URL
  (`.../adfs/ls/?wa=wsignout1.0`), so a bare `idp.unibo.it/adfs` substring in the HTML is
  **not** a sign of being logged out. Detect unauth via the final URL landing on the IdP,
  a `name="SAMLRequest"` form, or the `Sign In` title instead.
- **App model:** unlike AlmaEsami, RPS pages are static server-rendered tables (no ICEfaces
  flow tokens), so direct GETs work cleanly.

## How to map the authenticated endpoints

1. Log into the service in a browser (complete SSO + MFA).
2. Open DevTools → Application → Cookies, copy the authenticated host cookie
   (`JSESSIONID` for AlmaEsami; the CakePHP session cookie for RPS).
3. Replay requests to the student pages with that `Cookie` header and record the response
   shapes here, then build a client module + tools following the `calendar.ts` pattern
   (pure parsers, unit-tested; network calls thin).

Cookies are short-lived, account-bound secrets — keep them in memory only, never commit.
