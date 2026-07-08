import { chromium, type BrowserContext, type Page } from "playwright";

import { extractSesskey } from "./login.js";
import { isAlmaesamiAuthExpired, isRpsAuthExpired, isSolAuthExpired } from "./sessions.js";

/**
 * Headless Chromium login across the Unibo SSO estate. `/login/index.php` on
 * virtuale.unibo.it always redirects to the ADFS SSO stack at idp.unibo.it
 * (see almaesami-rps-api-notes.md), a *multi-step* flow: a Home Realm Discovery
 * page (pick UNIBO) followed by a username/password page. A plain HTTP form
 * POST can't drive that, so this walks a real browser through it.
 *
 * Because AlmaEsami and RPS federate to the *same* idp.unibo.it session, once
 * the Virtuale ADFS handshake completes the browser context already holds an
 * authenticated IdP session; navigating to each service then completes its own
 * SAML handshake without re-prompting. We capture each host's cookies
 * (JSESSIONID scoped to /almaesami; PHPSESSID for rps).
 *
 * Each service is best-effort: if one handshake fails or stalls we still return
 * the others, reporting per-service success. Only viable for accounts without
 * interactive MFA; if the ADFS flow stalls on a page it can't advance, the
 * Virtuale step throws (and the others will report failure, since the shared
 * IdP session was never established).
 */

export type BrowserLoginInput = {
  baseUrl: string;
  email: string;
  password: string;
  almaesamiUrl?: string;
  rpsUrl?: string;
  solUrl?: string;
  timeoutMs?: number;
};

export type VirtualeCaptured = { ok: true; sesskey: string; cookies: string; finalUrl: string };
export type CookieCaptured = { ok: true; cookies: string; finalUrl: string };
export type ServiceFailure = { ok: false; error: string };

export type BrowserLoginResult = {
  virtuale: VirtualeCaptured | ServiceFailure;
  almaesami: CookieCaptured | ServiceFailure;
  rps: CookieCaptured | ServiceFailure;
  sol: CookieCaptured | ServiceFailure;
};

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_STEPS = 8;
const DEFAULT_ALMAESAMI_URL = "https://almaesami.unibo.it/almaesami/studenti/home.htm";
const DEFAULT_RPS_URL = "https://rps.unibo.it/";
const DEFAULT_SOL_URL = "https://studenti.unibo.it/sol/studenti/homeStudentiOnline.htm";

// Home Realm Discovery: pick the UNIBO (local AD) identity provider. The page
// renders clickable `<div class="idp btnUnibo">` tiles that call
// HRD.selection('AD AUTHORITY'); the email field is only a hidden fallback.
const REALM_SELECTORS = [
  ".idp.btnUnibo",
  "div[role='button'][aria-label*='UNIBO' i]",
  "div[role='button'][aria-label*='Enter with UNIBO' i]"
];
const EMAIL_SELECTORS = [
  "#emailInput",
  "input[name='Email']",
  "input[type='email']:not([name='UserName'])"
];
const USERNAME_SELECTORS = [
  "#userNameInput",
  "input[name='UserName']",
  "input[name='username']",
  "input[name='loginfmt']"
];
const PASSWORD_SELECTORS = ["#passwordInput", "input[name='Password']", "input[type='password']"];
const SUBMIT_SELECTORS = [
  "#submitButton",
  "input[name='HomeRealmByEmail']",
  "input[type='submit']",
  "button[type='submit']",
  "#idSIButton9"
];

async function fillFirstVisible(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    try {
      await locator.fill(value, { timeout: 2_000 });
      return true;
    } catch {
      // hidden/not-editable on this page — try the next candidate
    }
  }
  return false;
}

async function clickPrimarySubmit(page: Page): Promise<boolean> {
  for (const selector of SUBMIT_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    try {
      await locator.click({ timeout: 2_000 });
      return true;
    } catch {
      // not clickable — try the next candidate
    }
  }
  return false;
}

async function selectUniboRealm(page: Page): Promise<boolean> {
  for (const selector of REALM_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    try {
      await locator.click({ timeout: 2_000 });
      return true;
    } catch {
      // fall through to the JS path
    }
  }
  // The tiles drive an inline `HRD.selection('AD AUTHORITY')`; invoke it directly
  // if the click didn't land (e.g. the tile is offscreen/covered).
  try {
    const invoked = await page.evaluate(() => {
      const hrd = (window as unknown as { HRD?: { selection?: (realm: string) => void } }).HRD;
      if (hrd && typeof hrd.selection === "function") {
        hrd.selection("AD AUTHORITY");
        return true;
      }
      return false;
    });
    return invoked;
  } catch {
    return false;
  }
}

async function dismissOverlays(page: Page): Promise<void> {
  // ADFS/consent pages sometimes float a cookie/consent modal over the form.
  const closers = page.locator("button:has-text('Close'), button:has-text('Accept'), button:has-text('Accetta')");
  const count = await closers.count();
  for (let i = 0; i < count; i++) {
    try {
      await closers.nth(i).click({ timeout: 1_000 });
    } catch {
      // ignore — best effort
    }
  }
}

const onIdp = (url: string): boolean => /idp\.unibo\.it|login\.microsoftonline\.com|login\.live\.com/i.test(url);

async function cookieHeaderFor(context: BrowserContext, url: string): Promise<string> {
  const cookies = await context.cookies(url);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Drive the ADFS SSO flow on the Virtuale login page, then capture the
 * sesskey + cookies. Establishes the shared idp.unibo.it session the other
 * services piggyback on. */
async function completeVirtualeLogin(
  page: Page,
  context: BrowserContext,
  input: BrowserLoginInput,
  timeoutMs: number,
  deadline: number
): Promise<VirtualeCaptured> {
  await page.goto(new URL("/login/index.php", input.baseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs
  });

  let filledPassword = false;

  for (let step = 0; step < MAX_STEPS && Date.now() < deadline; step++) {
    if (!onIdp(page.url())) break;

    await dismissOverlays(page);

    // Home Realm Discovery: if the UNIBO IdP tile is present and we're not yet
    // on a password page, select it and advance.
    const hasPassword = (await page.locator(PASSWORD_SELECTORS.join(", ")).count()) > 0;
    if (!hasPassword) {
      const selectedRealm = await selectUniboRealm(page);
      if (selectedRealm) {
        try {
          await page.waitForLoadState("networkidle", { timeout: 10_000 });
        } catch {
          // in-place update — keep looping
        }
        continue;
      }
    }

    const filledEmail = await fillFirstVisible(page, EMAIL_SELECTORS, input.email);
    const filledUsername = await fillFirstVisible(page, USERNAME_SELECTORS, input.email);
    const filledPw = await fillFirstVisible(page, PASSWORD_SELECTORS, input.password);
    filledPassword = filledPassword || filledPw;

    if (!filledEmail && !filledUsername && !filledPw) {
      // Nothing on this IdP page we know how to fill — likely MFA / an
      // unexpected step. Give up rather than spin.
      throw new Error(
        `Stuck on an ADFS page this headless flow can't advance (${page.url()}). This usually means MFA/verification is required — use virtuale_bootstrap_session instead.`
      );
    }

    const submitted = await clickPrimarySubmit(page);
    if (!submitted) {
      // Fall back to pressing Enter in the last field we touched.
      await page.keyboard.press("Enter");
    }

    try {
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
    } catch {
      // some steps update in place without a full navigation — keep looping
    }
  }

  if (onIdp(page.url())) {
    throw new Error(
      `Login did not complete — still on ${page.url()}. ${
        filledPassword ? "Credentials may be wrong, or MFA is required." : "Could not reach the password step."
      } Use virtuale_bootstrap_session if MFA is enabled.`
    );
  }

  await page.goto(new URL("/my/", input.baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const html = await page.content();
  const sesskey = extractSesskey(html);
  if (!sesskey) {
    throw new Error(`Logged in but could not find a sesskey on ${page.url()}.`);
  }

  const cookies = await cookieHeaderFor(context, input.baseUrl);
  if (!cookies) {
    throw new Error("Logged in but no cookies were captured for the Virtuale host.");
  }

  return { ok: true, sesskey, cookies, finalUrl: page.url() };
}

/** Navigate to a service that shares the idp.unibo.it session and capture its
 * host cookie once the SAML handshake completes. */
async function captureCookieService(
  page: Page,
  context: BrowserContext,
  targetUrl: string,
  timeoutMs: number,
  isExpired: (html: string, url: string) => boolean
): Promise<CookieCaptured> {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  try {
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  } catch {
    // best effort — the page may keep a long-poll connection open
  }

  const finalUrl = page.url();
  const html = await page.content();
  if (onIdp(finalUrl) || isExpired(html, finalUrl)) {
    throw new Error(`SAML handshake did not complete — landed on ${finalUrl}.`);
  }

  // Query cookies against the *target* URL so path-scoped cookies (e.g.
  // JSESSIONID with Path=/almaesami) are included.
  const cookies = await cookieHeaderFor(context, finalUrl.startsWith("http") ? finalUrl : targetUrl);
  if (!cookies) {
    throw new Error(`Authenticated but no cookies were captured for ${targetUrl}.`);
  }
  return { ok: true, cookies, finalUrl };
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function loginWithBrowser(input: BrowserLoginInput): Promise<BrowserLoginResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    let virtuale: VirtualeCaptured | ServiceFailure;
    try {
      virtuale = await completeVirtualeLogin(page, context, input, timeoutMs, deadline);
    } catch (err) {
      virtuale = { ok: false, error: errorMessage(err) };
    }

    let almaesami: CookieCaptured | ServiceFailure;
    try {
      almaesami = await captureCookieService(
        page,
        context,
        input.almaesamiUrl ?? DEFAULT_ALMAESAMI_URL,
        timeoutMs,
        isAlmaesamiAuthExpired
      );
    } catch (err) {
      almaesami = { ok: false, error: errorMessage(err) };
    }

    let rps: CookieCaptured | ServiceFailure;
    try {
      rps = await captureCookieService(page, context, input.rpsUrl ?? DEFAULT_RPS_URL, timeoutMs, isRpsAuthExpired);
    } catch (err) {
      rps = { ok: false, error: errorMessage(err) };
    }

    let sol: CookieCaptured | ServiceFailure;
    try {
      sol = await captureCookieService(page, context, input.solUrl ?? DEFAULT_SOL_URL, timeoutMs, isSolAuthExpired);
    } catch (err) {
      sol = { ok: false, error: errorMessage(err) };
    }

    return { virtuale, almaesami, rps, sol };
  } finally {
    await browser.close();
  }
}
