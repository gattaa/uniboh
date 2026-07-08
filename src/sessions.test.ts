import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SessionExpiredError,
  SessionStore,
  isAlmaesamiAuthExpired,
  isMoodleAuthError,
  isRpsAuthExpired,
  isVirtualeAuthExpired,
  type StoreEnv
} from "./sessions.js";

// --- Auth-expiry detectors --------------------------------------------------

test("isVirtualeAuthExpired flags login-page redirects, IdP landings and SAML forms", () => {
  assert.equal(isVirtualeAuthExpired("<html>ok</html>", "https://virtuale.unibo.it/login/index.php"), true);
  assert.equal(isVirtualeAuthExpired("<html>ok</html>", "https://idp.unibo.it/adfs/ls/?SAMLRequest=x"), true);
  assert.equal(isVirtualeAuthExpired('<form><input name="SAMLRequest"></form>', "https://virtuale.unibo.it/my/"), true);
  assert.equal(isVirtualeAuthExpired("<html><h1>My courses</h1></html>", "https://virtuale.unibo.it/my/"), false);
});

test("isAlmaesamiAuthExpired flags the sessione scaduta page and SSO bounce", () => {
  assert.equal(isAlmaesamiAuthExpired("<title>AlmaEsami - sessione scaduta</title>sessionExpired"), true);
  assert.equal(isAlmaesamiAuthExpired("<html>ok</html>", "https://idp.unibo.it/adfs/ls/?SAMLRequest=x"), true);
  assert.equal(isAlmaesamiAuthExpired('<form><input name="SAMLRequest"></form>'), true);
  assert.equal(isAlmaesamiAuthExpired("<table class='iceDataTblOutline'></table>", "https://almaesami.unibo.it/almaesami/studenti/home.htm"), false);
});

test("isRpsAuthExpired flags Sign In / SAML / IdP but not the ADFS sign-out link", () => {
  assert.equal(isRpsAuthExpired("<head><title>Sign In</title></head>"), true);
  assert.equal(isRpsAuthExpired('<form><input name="SAMLRequest"></form>'), true);
  assert.equal(isRpsAuthExpired("<html>ok</html>", "https://idp.unibo.it/adfs/ls/?SAMLRequest=x"), true);
  // Authenticated page linking to the ADFS wsignout1.0 URL is NOT expired.
  const authed = '<html><a href="https://idp.unibo.it/adfs/ls/?wa=wsignout1.0">Logout</a><table></table></html>';
  assert.equal(isRpsAuthExpired(authed, "https://rps.unibo.it/students/register"), false);
});

test("isMoodleAuthError detects servicerequireslogin / invalidsesskey anywhere in the payload", () => {
  assert.equal(isMoodleAuthError({ error: true, exception: { errorcode: "servicerequireslogin" } }), true);
  assert.equal(isMoodleAuthError({ error: true, errorcode: "invalidsesskey" }), true);
  assert.equal(isMoodleAuthError({ error: true, message: "Course not found" }), false);
  assert.equal(isMoodleAuthError(null), false);
  assert.equal(isMoodleAuthError("string"), false);
});

// --- Store resolution -------------------------------------------------------

function envStore(overrides: Partial<StoreEnv> = {}): SessionStore {
  return new SessionStore({
    virtualeBaseUrl: "https://virtuale.unibo.it",
    virtualeSesskey: "ENV_SK",
    virtualeCookies: "MoodleSession=ENV",
    almaesamiBaseUrl: "https://almaesami.unibo.it",
    almaesamiCookies: "JSESSIONID=ENV_A",
    rpsBaseUrl: "https://rps.unibo.it",
    rpsCookies: "PHPSESSID=ENV_R",
    ...overrides
  });
}

test("resolveVirtualeAjax falls back to env and is refreshable", () => {
  const store = envStore();
  const ctx = store.resolveVirtualeAjax(undefined);
  assert.equal(ctx.sesskey, "ENV_SK");
  assert.equal(ctx.cookies, "MoodleSession=ENV");
  assert.equal(ctx.baseUrl, "https://virtuale.unibo.it");
  assert.equal(ctx.refreshable, true);
});

test("resolveVirtualeAjax throws when neither session nor env creds exist", () => {
  const store = envStore({ virtualeSesskey: undefined, virtualeCookies: undefined });
  assert.throws(() => store.resolveVirtualeAjax(undefined), /No authenticated Virtuale context/);
});

test("resolveVirtualeAjax marks bootstrap sessions non-refreshable and browser/env refreshable", () => {
  const store = envStore();
  const boot = store.mint({ label: "b", origin: "bootstrap", virtuale: { sesskey: "SK", cookies: "C" } });
  const brow = store.mint({ label: "w", origin: "browser", virtuale: { sesskey: "SK2", cookies: "C2" } });
  assert.equal(store.resolveVirtualeAjax(boot.id).refreshable, false);
  assert.equal(store.resolveVirtualeAjax(brow.id).refreshable, true);
  assert.equal(store.resolveVirtualeAjax(boot.id).sesskey, "SK");
});

test("resolveVirtualeAjax throws on unknown session and on a session lacking Virtuale creds", () => {
  const store = envStore();
  assert.throws(() => store.resolveVirtualeAjax("nope"), /Unknown session_id/);
  const cookieOnly = store.mint({ label: "a", origin: "bootstrap", almaesami: { cookies: "X" } });
  assert.throws(() => store.resolveVirtualeAjax(cookieOnly.id), /no Virtuale credentials/);
});

test("resolveVirtualeCookies: override is never refreshable; env fallback is", () => {
  const store = envStore();
  const override = store.resolveVirtualeCookies(undefined, "MoodleSession=OVERRIDE");
  assert.equal(override.cookies, "MoodleSession=OVERRIDE");
  assert.equal(override.refreshable, false);

  const env = store.resolveVirtualeCookies(undefined, undefined);
  assert.equal(env.cookies, "MoodleSession=ENV");
  assert.equal(env.refreshable, true);
});

test("resolveCookieService resolves per source with correct refreshability", () => {
  const store = envStore();
  const override = store.resolveCookieService("almaesami", undefined, "JSESSIONID=OV");
  assert.deepEqual(
    { cookies: override.cookies, refreshable: override.refreshable, baseUrl: override.baseUrl },
    { cookies: "JSESSIONID=OV", refreshable: false, baseUrl: "https://almaesami.unibo.it" }
  );

  const env = store.resolveCookieService("rps", undefined, undefined);
  assert.equal(env.cookies, "PHPSESSID=ENV_R");
  assert.equal(env.refreshable, true);

  const boot = store.mint({ label: "b", origin: "bootstrap", rps: { cookies: "PHPSESSID=BOOT" } });
  const bootCtx = store.resolveCookieService("rps", boot.id, undefined);
  assert.equal(bootCtx.cookies, "PHPSESSID=BOOT");
  assert.equal(bootCtx.refreshable, false);
});

test("resolveCookieService throws for a session lacking that service's creds", () => {
  const store = envStore({ almaesamiCookies: undefined });
  const virtualeOnly = store.mint({ label: "v", origin: "browser", virtuale: { sesskey: "S", cookies: "C" } });
  assert.throws(() => store.resolveCookieService("almaesami", virtualeOnly.id, undefined), /no almaesami credentials/);
});

test("getOrCreateEnvVirtualeSession and env cookie sessions are idempotent", () => {
  const store = envStore();
  const a = store.getOrCreateEnvVirtualeSession();
  const b = store.getOrCreateEnvVirtualeSession();
  assert.equal(a.id, b.id);

  const r1 = store.getOrCreateEnvCookieSession("rps");
  const r2 = store.getOrCreateEnvCookieSession("rps");
  assert.equal(r1.id, r2.id);
  assert.equal(store.resolveCookieService("rps", r1.id, undefined).cookies, "PHPSESSID=ENV_R");
});

test("applyRefresh updates env + env/browser records but leaves bootstrap sessions untouched", () => {
  const store = envStore();
  const browser = store.mint({
    label: "w",
    origin: "browser",
    virtuale: { sesskey: "OLD_SK", cookies: "OLD_V" },
    almaesami: { cookies: "OLD_A" },
    rps: { cookies: "OLD_R" }
  });
  const boot = store.mint({ label: "b", origin: "bootstrap", virtuale: { sesskey: "BOOT_SK", cookies: "BOOT_V" } });

  store.applyRefresh({
    virtuale: { sesskey: "NEW_SK", cookies: "NEW_V" },
    almaesami: { cookies: "NEW_A" },
    rps: { cookies: "NEW_R" }
  });

  // Browser record refreshed across all services.
  const bctx = store.resolveVirtualeAjax(browser.id);
  assert.equal(bctx.sesskey, "NEW_SK");
  assert.equal(bctx.cookies, "NEW_V");
  assert.equal(store.resolveCookieService("almaesami", browser.id, undefined).cookies, "NEW_A");
  assert.equal(store.resolveCookieService("rps", browser.id, undefined).cookies, "NEW_R");

  // Env fallback refreshed too.
  assert.equal(store.resolveVirtualeAjax(undefined).sesskey, "NEW_SK");

  // Bootstrap record untouched.
  assert.equal(store.resolveVirtualeAjax(boot.id).cookies, "BOOT_V");
});

test("SessionExpiredError carries the service name", () => {
  const err = new SessionExpiredError("virtuale", "expired");
  assert.equal(err.service, "virtuale");
  assert.ok(err instanceof Error);
});
