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
- **TODO (needs auth):** map the student endpoints under `/almaesami/studenti/` — exam
  listings, booking/withdraw actions, results. Determine whether they return JSP HTML (to
  scrape with cheerio) or JSON.

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
