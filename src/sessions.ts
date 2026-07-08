import { randomUUID } from "node:crypto";

/**
 * Unified in-memory session store shared by every Unibo service.
 *
 * All of Virtuale, AlmaEsami and RPS federate to the same idp.unibo.it ADFS
 * SSO, so a single browser login can produce credentials for all three at
 * once. A {@link SessionRecord} therefore holds per-service credentials keyed
 * by service name, each with its own base URL resolved at the store level.
 *
 * Nothing here touches the network or the filesystem: the store is pure
 * in-memory state plus resolution logic, so it (and the auth-expiry detectors
 * below) can be unit-tested without hitting live services.
 */

export type ServiceName = "virtuale" | "almaesami" | "rps";

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
};

/** Fresh credentials produced by a (re-)login, applied across the store. */
export type ServiceRefresh = {
  virtuale?: { sesskey: string; cookies: string };
  almaesami?: { cookies: string };
  rps?: { cookies: string };
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

export const VIRTUALE_EXPIRED_MESSAGE =
  "Virtuale session expired — re-bootstrap or run unibo_browser_login.";
export const ALMAESAMI_EXPIRED_MESSAGE =
  "AlmaEsami session is missing or expired (SSO login / sessione scaduta). Re-bootstrap with almaesami_bootstrap_session or run unibo_browser_login.";
export const RPS_EXPIRED_MESSAGE =
  "RPS session is missing or expired (redirected to Unibo SSO). Re-bootstrap with rps_bootstrap_session or run unibo_browser_login.";

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
  private readonly envSessionIds = new Map<ServiceName, string>();
  private readonly env: StoreEnv;

  constructor(env: StoreEnv) {
    this.env = env;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
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
      rps: fields.rps
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
    }
  }

  // --- Env-backed session singletons ---------------------------------------

  /** Mint (or reuse) the env-var-backed Virtuale session. */
  getOrCreateEnvVirtualeSession(): SessionRecord {
    if (!this.env.virtualeSesskey || !this.env.virtualeCookies) {
      throw new Error("VIRTUALE_SESSKEY and VIRTUALE_COOKIES are not both set in the server environment.");
    }
    const existingId = this.envSessionIds.get("virtuale");
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing) {
      this.touch(existing);
      return existing;
    }
    const record = this.mint({
      label: "env-session",
      origin: "env",
      virtuale: { sesskey: this.env.virtualeSesskey, cookies: this.env.virtualeCookies }
    });
    this.envSessionIds.set("virtuale", record.id);
    return record;
  }

  /** Mint (or reuse) the env-var-backed cookie session for AlmaEsami/RPS. */
  getOrCreateEnvCookieSession(service: "almaesami" | "rps"): SessionRecord {
    const cookies = service === "almaesami" ? this.env.almaesamiCookies : this.env.rpsCookies;
    const envVarName = service === "almaesami" ? "ALMAESAMI_COOKIES" : "RPS_COOKIES";
    if (!cookies) {
      throw new Error(`${envVarName} is not set in the server environment.`);
    }
    const existingId = this.envSessionIds.get(service);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing) {
      this.touch(existing);
      return existing;
    }
    const record = this.mint({
      label: `${service}-env-session`,
      origin: "env",
      [service]: { cookies }
    });
    this.envSessionIds.set(service, record.id);
    return record;
  }

  // --- Resolution ----------------------------------------------------------

  /** Resolve credentials for the Virtuale AJAX API (needs a sesskey). */
  resolveVirtualeAjax(sessionId?: string): VirtualeAjaxContext {
    if (sessionId) {
      const record = this.requireRecord(sessionId);
      const creds = record.virtuale;
      if (!creds?.sesskey || !creds.cookies) {
        throw new Error("This session has no Virtuale credentials (sesskey + cookies).");
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

    throw new Error(
      "No authenticated Virtuale context. Set VIRTUALE_SESSKEY + VIRTUALE_COOKIES, run unibo_browser_login, or pass a session_id from virtuale_bootstrap_session."
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
        throw new Error("This session has no Virtuale cookies.");
      }
      this.touch(record);
      return { cookies, baseUrl: this.env.virtualeBaseUrl, refreshable: isRefreshableOrigin(record.origin) };
    }
    if (this.env.virtualeCookies) {
      return { cookies: this.env.virtualeCookies, baseUrl: this.env.virtualeBaseUrl, refreshable: true };
    }
    throw new Error(
      "No Virtuale cookie session available. Pass `cookies` (MoodleSession=...), a `session_id`, or set VIRTUALE_COOKIES."
    );
  }

  /** Resolve a cookie header + base URL for AlmaEsami or RPS. */
  resolveCookieService(
    service: "almaesami" | "rps",
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
        throw new Error(`This session has no ${service} credentials.`);
      }
      this.touch(record);
      return { cookies, baseUrl, refreshable: isRefreshableOrigin(record.origin) };
    }
    const envCookies = service === "almaesami" ? this.env.almaesamiCookies : this.env.rpsCookies;
    const envVarName = service === "almaesami" ? "ALMAESAMI_COOKIES" : "RPS_COOKIES";
    if (envCookies) {
      return { cookies: envCookies, baseUrl, refreshable: true };
    }
    throw new Error(
      `No ${service} session available. Pass \`cookies\`, a \`session_id\` (see ${service}_get_env_session / ${service}_bootstrap_session), or set ${envVarName}.`
    );
  }

  private requireRecord(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error("Unknown session_id.");
    }
    return record;
  }

  /**
   * Apply fresh credentials from a re-login: update the env holders (so env
   * fallbacks pick them up) and every env-/browser-origin record that already
   * carried that service. User-pasted (bootstrap/password) records are left
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

    const now = new Date().toISOString();
    for (const record of this.sessions.values()) {
      if (!isRefreshableOrigin(record.origin)) continue;
      let changed = false;
      if (fresh.virtuale && record.virtuale) {
        record.virtuale = { sesskey: fresh.virtuale.sesskey, cookies: fresh.virtuale.cookies };
        changed = true;
      }
      if (fresh.almaesami && record.almaesami) {
        record.almaesami = { cookies: fresh.almaesami.cookies };
        changed = true;
      }
      if (fresh.rps && record.rps) {
        record.rps = { cookies: fresh.rps.cookies };
        changed = true;
      }
      if (changed) record.updatedAtIso = now;
    }
  }
}
