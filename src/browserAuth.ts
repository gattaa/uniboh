import { chromium, type Page } from "playwright";

import { extractSesskey } from "./login.js";

/**
 * Headless Chromium login for virtuale.unibo.it. `/login/index.php` always
 * redirects to the ADFS SSO stack at idp.unibo.it (see
 * almaesami-rps-api-notes.md), which is a *multi-step* flow: a Home Realm
 * Discovery page (enter email → Next) followed by a username/password page.
 * A plain HTTP form POST can't drive that, so this walks a real browser
 * through it with a generic step loop that fills whatever email / username /
 * password field is present on the current page and submits, repeating until
 * it lands back off the IdP.
 *
 * Only viable for accounts without interactive MFA; if the flow stalls on an
 * IdP page it can't advance (MFA / verification), this throws rather than
 * hanging.
 */

export type BrowserLoginInput = {
  baseUrl: string;
  email: string;
  password: string;
  timeoutMs?: number;
};

export type BrowserLoginResult = {
  sesskey: string;
  cookies: string;
  finalUrl: string;
};

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_STEPS = 8;

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

export async function loginWithBrowser(input: BrowserLoginInput): Promise<BrowserLoginResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

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

    const cookies = await context.cookies(input.baseUrl);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    if (!cookieHeader) {
      throw new Error("Logged in but no cookies were captured for the Virtuale host.");
    }

    return { sesskey, cookies: cookieHeader, finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}
