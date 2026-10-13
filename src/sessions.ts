import { randomUUID } from "node:crypto";

/**
 * Unified in-memory session store shared by every Unibo service.
 *
 * All of Virtuale, AlmaEsami, RPS and Studenti Online (SOL) federate to the
 * same idp.unibo.it ADFS SSO, so a single browser login can produce credentials
 * for all of them at once. A {@link SessionRecord} therefore holds per-service
 * credentials keyed by service name, each with its own base URL resolved at the
 * store level.
 *
 * Nothing here touches the network or the filesystem: the store is pure
 * in-memory state plus resolution logic, so it (and the auth-expiry detectors
 * below) can be unit-tested without hitting live services.
 */

export type ServiceName = "virtuale" | "almaesami" | "rps" | "sol";

/** Services whose auth is a single bootstrap-style host cookie (JSESSIONID /
 * PHPSESSID). Virtuale is excluded because its AJAX API also needs a sesskey. */
export type CookieServiceName = "almaesami" | "rps" | "sol";

/**
 * How the credentials in a record were obtained. Only `env` and `browser`
 * origins are ours to refresh (env vars / EMAIL+PASSWORD headless login);
 * `bootstrap` and `password` carry credentials the caller pasted, which we
 * must never silently replace.
 */
export type SessionOrigin = "env" | "browser" | "bootstrap" | "password";

/** Virtuale (Moodle) needs a sesskey for the AJAX API; the HTML-scrape (quiz)
 * path only needs the cookie header, so `sesskey` is optional. */
export type VirtualeCreds = { sesskey?: string; cookies: string };
export type CookieCreds = { cookies: string };

export type SessionRecord = {
  id: string;
  label: string;
  origin: SessionOrigin;
  createdAtIso: string;
  updatedAtIso: string;
  virtuale?: VirtualeCreds;
  almaesami?: CookieCreds;
  rps?: CookieCreds;
  sol?: CookieCreds;
};

/** Server environment defaults the store resolves against. Cookie/sesskey
 * fields are mutable so a successful re-login can refresh them in place. */
export type StoreEnv = {
  virtualeBaseUrl: string;
  virtualeSesskey?: string;
  virtualeCookies?: string;
  almaesamiBaseUrl: string;
  almaesamiCookies?: string;
  rpsBaseUrl: string;
  rpsCookies?: string;
  solBaseUrl: string;
  solCookies?: string;
};

/** Fresh credentials produced by a (re-)login, applied across the store. */
export type ServiceRefresh = {
  virtuale?: { sesskey: string; cookies: string };
  almaesami?: { cookies: string };
  rps?: { cookies: string };
  sol?: { cookies: string };
};

export type VirtualeAjaxContext = {
  sesskey: string;
  cookies: string;
  baseUrl: string;
  /** True when the underlying credentials are env- or browser-login-backed and
   * may be transparently refreshed on expiry. */
  refreshable: boolean;
};

export type CookieContext = {
  cookies: string;
  baseUrl: string;
  refreshable: boolean;
};

export const UNKNOWN_SESSION_MESSAGE =
  "Unknown session_id (sessions are in-memory and reset when the server restarts). Omit session_id to use automatic login, or call unibo_login.";
export const VIRTUALE_EXPIRED_MESSAGE =
  "Virtuale session expired — re-bootstrap with unibo_bootstrap_session or run unibo_login.";
export const ALMAESAMI_EXPIRED_MESSAGE =
  "AlmaEsami session is missing or expired (SSO login / sessione scaduta). Re-bootstrap with unibo_bootstrap_session or run unibo_login.";
export const RPS_EXPIRED_MESSAGE =
  "RPS session is missing or expired (redirected to Unibo SSO). Re-bootstrap with unibo_bootstrap_session or run unibo_login.";
export const SOL_EXPIRED_MESSAGE =
  "Studenti Online (SOL) session is missing or expired (redirected to Unibo SSO / SOL welcome page). Re-bootstrap with unibo_bootstrap_session or run unibo_login.";

/** Thrown when a service response indicates the session is no longer valid.
 * The auto-relogin wrapper keys off this type (and `service`) to decide
 * whether to refresh and retry. */
export class SessionExpiredError extends Error {
  readonly service: ServiceName;

  constructor(service: ServiceName, message: string) {
    super(message);
    this.name = "SessionExpiredError";
    this.service = service;
  }
}

/** Thrown by the store resolvers when no credentials at all are available. The
 * auto-relogin wrapper treats it like an expiry on first resolve (browser login
 * when EMAIL+PASSWORD are set). */
export class NoCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoCredentialsError";
  }
}

// --- Pure auth-expiry detectors (network-free, unit-tested) ----------------

/**
 * Virtuale/Moodle bounces an expired MoodleSession to `/login/index.php`, which
 * (federated) redirects on to the ADFS SSO form. Detect via the final URL
 * landing on the login page / IdP, or a SAML request form in the body.
 */
export function isVirtualeAuthExpired(html: string, finalUrl = ""): boolean {
  return (
    /idp\.unibo\.it\/adfs/i.test(finalUrl) ||
    /\/login\/index\.php/i.test(finalUrl) ||
    /name=["']SAMLRequest["']/i.test(html)
  );
}

/**
 * AlmaEsami: a stale JSESSIONID 302s to the SSO form or to
 * `/almaesami/sessionExpired.htm` (`<title>… sessione scaduta</title>`).
 */
export function isAlmaesamiAuthExpired(html: string, finalUrl = ""): boolean {
  return (
    /idp\.unibo\.it\/adfs/i.test(finalUrl) ||
    /name=["']SAMLRequest["']/i.test(html) ||
    /SAMLRequest/i.test(html) ||
    /sessionExpired|sessione scaduta/i.test(html)
  );
}

/**
 * RPS: an authenticated page still links to the ADFS *sign-out* URL
 * (`wa=wsignout1.0`), so a bare `idp.unibo.it/adfs` substring in the HTML is
 * NOT a reliable signal. Only treat it as expired when the request landed on
 * the IdP, or the page is the SAML sign-in form / "Sign In" title.
 */
export function isRpsAuthExpired(html: string, finalUrl = ""): boolean {
  return (
    /idp\.unibo\.it\/adfs/i.test(finalUrl) ||
    /name=["']SAMLRequest["']/i.test(html) ||
    /<title>\s*Sign In\s*<\/title>/i.test(html)
  );
}

/**
 * Studenti Online (SOL): a Java Spring Web Flow app (like AlmaEsami) whose
 * session cookie is a `JSESSIONID` scoped to `/sol`. A missing/stale session
 * 302s the authenticated `homeStudentiOnline.htm` either to the SSO form
 * (`idp.unibo.it/adfs?SAMLRequest=…`) or back to the public `/sol/welcome.htm`
 * landing (verified: unauthenticated GETs of the home 302 to the IdP; the
 * public root 302s to welcome.htm). Unlike RPS, the authenticated SOL page's
 * logout link is a *local* `/sol/logout.htm` (NOT the ADFS `wa=wsignout1.0`
 * URL, verified against the capture), so a `SAMLRequest` marker in the body is
 * a safe signal — it is absent when authenticated.
 */
export function isSolAuthExpired(html: string, finalUrl = ""): boolean {
  return (
    /idp\.unibo\.it\/adfs/i.test(finalUrl) ||
    /\/sol\/welcome\.htm/i.test(finalUrl) ||
    /name=["']SAMLRequest["']/i.test(html) ||
    /SAMLRequest/i.test(html)
  );
}

/**
 * Maps a Moodle AJAX logical-error payload to an expired-session signal.
 * `servicerequireslogin` / `invalidsesskey` are the codes Moodle returns once
 * the MoodleSession or sesskey is stale. The whole payload is stringified so
 * detection is robust to Moodle nesting the code under `exception`.
 */
export function isMoodleAuthError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  let blob = "";
  try {
    blob = JSON.stringify(result).toLowerCase();
  } catch {
    blob = String((result as { message?: unknown }).message ?? "").toLowerCase();
  }
  return blob.includes("servicerequireslogin") || blob.includes("invalidsesskey");
}

// --- Store ------------------------------------------------------------------

const isRefreshableOrigin = (origin: SessionOrigin): boolean =>
  origin === "env" || origin === "browser";

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly env: StoreEnv;
  /** Current browser-login session; the resolvers' last-resort fallback. */
  browserSessionId?: string;

  constructor(env: StoreEnv) {
    this.env = env;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    if (this.browserSessionId === id) this.browserSessionId = undefined;
    return this.sessions.delete(id);
  }

  private touch(record: SessionRecord): void {
    record.updatedAtIso = new Date().toISOString();
  }

  /** Insert a new record with generated id + timestamps. */
  mint(fields: {
    label: string;
    origin: SessionOrigin;
    virtuale?: VirtualeCreds;
    almaesami?: CookieCreds;
    rps?: CookieCreds;
    sol?: CookieCreds;
  }): SessionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      label: fields.label,
      origin: fields.origin,
      createdAtIso: now,
      updatedAtIso: now,
      virtuale: fields.virtuale,
      almaesami: fields.almaesami,
      rps: fields.rps,
      sol: fields.sol
    };
    this.sessions.set(id, record);
    return record;
  }

  baseUrlFor(service: ServiceName): string {
    switch (service) {
      case "virtuale":
        return this.env.virtualeBaseUrl;
      case "almaesami":
        return this.env.almaesamiBaseUrl;
      case "rps":
        return this.env.rpsBaseUrl;
      case "sol":
        return this.env.solBaseUrl;
    }
  }

  /** Env cookie holder + var name for a cookie-auth service (used by the
   * env-session and resolution paths so the per-service mapping lives once). */
  private envCookiesFor(service: CookieServiceName): string | undefined {
    switch (service) {
      case "almaesami":
        return this.env.almaesamiCookies;
      case "rps":
        return this.env.rpsCookies;
      case "sol":
        return this.env.solCookies;
    }
  }

  private envVarNameFor(service: CookieServiceName): string {
    switch (service) {
      case "almaesami":
        return "ALMAESAMI_COOKIES";
      case "rps":
        return "RPS_COOKIES";
      case "sol":
        return "SOL_COOKIES";
    }
  }

  /** The default browser-login record, if it exists. */
  private browserRecord(): SessionRecord | undefined {
    return this.browserSessionId ? this.sessions.get(this.browserSessionId) : undefined;
  }

  // --- Resolution ----------------------------------------------------------

  /** Resolve credentials for the Virtuale AJAX API (needs a sesskey). */
  resolveVirtualeAjax(sessionId?: string): VirtualeAjaxContext {
    if (sessionId) {
      const record = this.requireRecord(sessionId);
      const creds = record.virtuale;
      if (!creds?.sesskey || !creds.cookies) {
        throw this.missingService(record, "Virtuale credentials (sesskey + cookies)");
      }
      this.touch(record);
      return {
        sesskey: creds.sesskey,
        cookies: creds.cookies,
        baseUrl: this.env.virtualeBaseUrl,
        refreshable: isRefreshableOrigin(record.origin)
      };
    }

    if (this.env.virtualeSesskey && this.env.virtualeCookies) {
      return {
        sesskey: this.env.virtualeSesskey,
        cookies: this.env.virtualeCookies,
        baseUrl: this.env.virtualeBaseUrl,
        refreshable: true
      };
    }

    const browser = this.browserRecord()?.virtuale;
    if (browser?.sesskey && browser.cookies) {
      return { sesskey: browser.sesskey, cookies: browser.cookies, baseUrl: this.env.virtualeBaseUrl, refreshable: true };
    }

    throw new NoCredentialsError(
      "No authenticated Virtuale context. Set EMAIL + PASSWORD (automatic login) or VIRTUALE_SESSKEY + VIRTUALE_COOKIES, run unibo_login, or pass a session_id from unibo_bootstrap_session."
    );
  }

  /** Resolve just a cookie header for the Virtuale HTML-scrape (quiz) path. */
  resolveVirtualeCookies(sessionId?: string, cookieOverride?: string): CookieContext {
    if (cookieOverride) {
      return { cookies: cookieOverride, baseUrl: this.env.virtualeBaseUrl, refreshable: false };
    }
    if (sessionId) {
      const record = this.requireRecord(sessionId);
      const cookies = record.virtuale?.cookies;
      if (!cookies) {
        throw this.missingService(record, "Virtuale cookies");
      }
      this.touch(record);
      return { cookies, baseUrl: this.env.virtualeBaseUrl, refreshable: isRefreshableOrigin(record.origin) };
    }
    if (this.env.virtualeCookies) {
      return { cookies: this.env.virtualeCookies, baseUrl: this.env.virtualeBaseUrl, refreshable: true };
    }
    const browser = this.browserRecord()?.virtuale?.cookies;
    if (browser) {
      return { cookies: browser, baseUrl: this.env.virtualeBaseUrl, refreshable: true };
    }
    throw new NoCredentialsError(
      "No Virtuale cookie session available. Pass `cookies` (MoodleSession=...), a `session_id`, or set EMAIL + PASSWORD or VIRTUALE_COOKIES."
    );
  }

  /** Resolve a cookie header + base URL for AlmaEsami, RPS or SOL. */
  resolveCookieService(
    service: CookieServiceName,
    sessionId?: string,
    cookieOverride?: string
  ): CookieContext {
    const baseUrl = this.baseUrlFor(service);
    if (cookieOverride) {
      return { cookies: cookieOverride, baseUrl, refreshable: false };
    }
    if (sessionId) {
      const record = this.requireRecord(sessionId);
      const cookies = record[service]?.cookies;
      if (!cookies) {
        throw this.missingService(record, `${service} credentials`);
      }
      this.touch(record);
      return { cookies, baseUrl, refreshable: isRefreshableOrigin(record.origin) };
    }
    const envCookies = this.envCookiesFor(service);
    if (envCookies) {
      return { cookies: envCookies, baseUrl, refreshable: true };
    }
    const browser = this.browserRecord()?.[service]?.cookies;
    if (browser) {
      return { cookies: browser, baseUrl, refreshable: true };
    }
    throw new NoCredentialsError(
      `No ${service} session available. Pass \`cookies\`, a \`session_id\` (see unibo_bootstrap_session), or set EMAIL + PASSWORD or ${this.envVarNameFor(service)}.`
    );
  }

  private requireRecord(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(UNKNOWN_SESSION_MESSAGE);
    }
    return record;
  }

  /** A session lacking a service: if it is ours to refresh (env/browser origin),
   * signal NoCredentialsError so the auto-relogin wrapper re-runs the login and
   * fills it in; user-pasted sessions keep a plain error. */
  private missingService(record: SessionRecord, what: string): Error {
    const message = `This session has no ${what}.`;
    return isRefreshableOrigin(record.origin) ? new NoCredentialsError(message) : new Error(message);
  }

  /**
   * Apply fresh credentials from a re-login: update the env holders (so env
   * fallbacks pick them up) and every env-/browser-origin record that already
   * carried that service (browser-origin records also gain services a partial login missed). User-pasted (bootstrap/password) records are left
   * untouched.
   */
  applyRefresh(fresh: ServiceRefresh): void {
    if (fresh.virtuale) {
      this.env.virtualeSesskey = fresh.virtuale.sesskey;
      this.env.virtualeCookies = fresh.virtuale.cookies;
    }
    if (fresh.almaesami) {
      this.env.almaesamiCookies = fresh.almaesami.cookies;
    }
    if (fresh.rps) {
      this.env.rpsCookies = fresh.rps.cookies;
    }
    if (fresh.sol) {
      this.env.solCookies = fresh.sol.cookies;
    }

    const now = new Date().toISOString();
    for (const record of this.sessions.values()) {
      if (!isRefreshableOrigin(record.origin)) continue;
      let changed = false;
      if (fresh.virtuale && (record.virtuale || record.origin === "browser")) {
        record.virtuale = { sesskey: fresh.virtuale.sesskey, cookies: fresh.virtuale.cookies };
        changed = true;
      }
      // A browser-origin record is ours: fill in services a partial login missed.
      const fill = record.origin === "browser";
      if (fresh.almaesami && (record.almaesami || fill)) {
        record.almaesami = { cookies: fresh.almaesami.cookies };
        changed = true;
      }
      if (fresh.rps && (record.rps || fill)) {
        record.rps = { cookies: fresh.rps.cookies };
        changed = true;
      }
      if (fresh.sol && (record.sol || fill)) {
        record.sol = { cookies: fresh.sol.cookies };
        changed = true;
      }
      if (changed) record.updatedAtIso = now;
    }
  }
}
