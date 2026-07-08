// Walks the ADFS login flow step by step and dumps the page structure
// (field names/ids only — never values) so selectors can be debugged.
// Run in your own terminal so credentials never leave your machine:
//
//   EMAIL=you@studio.unibo.it PASSWORD=... node scripts/inspect-adfs.mjs
//
import { chromium } from "playwright";

const baseUrl = process.env.VIRTUALE_BASE_URL ?? "https://virtuale.unibo.it";
const email = process.env.EMAIL;
const password = process.env.PASSWORD;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

async function dump(label) {
  const inputs = await page.$$eval("input", (els) =>
    els.map((e) => ({ type: e.type, name: e.name, id: e.id, visible: e.offsetParent !== null }))
  );
  const submits = await page.$$eval("input[type=submit], button", (els) =>
    els.map((e) => ({ tag: e.tagName, id: e.id, name: e.name, text: (e.value || e.textContent || "").trim().slice(0, 30) }))
  );
  console.log(`\n=== ${label} ===`);
  console.log("URL:", page.url().replace(/SAMLRequest=[^&]+/, "SAMLRequest=..."));
  console.log("TITLE:", await page.title());
  console.log("INPUTS:", JSON.stringify(inputs));
  console.log("SUBMITS:", JSON.stringify(submits));
}

await page.goto(new URL("/login/index.php", baseUrl).toString(), { waitUntil: "networkidle" });
await dump("step 0 (landing)");

// Home Realm Discovery: click the UNIBO IdP tile if present.
let selectedRealm = false;
for (const sel of [".idp.btnUnibo", "div[role=button][aria-label*='UNIBO' i]"]) {
  const loc = page.locator(sel).first();
  if ((await loc.count()) > 0) {
    try { await loc.click({ timeout: 2000 }); console.log(`clicked realm via ${sel}`); selectedRealm = true; break; } catch {}
  }
}
if (!selectedRealm) {
  try {
    const ok = await page.evaluate(() => (window.HRD && typeof window.HRD.selection === "function") ? (window.HRD.selection("AD AUTHORITY"), true) : false);
    if (ok) console.log("invoked HRD.selection('AD AUTHORITY')");
  } catch {}
}
await page.waitForLoadState("networkidle").catch(() => {});
await dump("step 0b (after realm select)");

if (email) {
  for (const sel of ["#emailInput", "input[name=Email]", "input[type=email]"]) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) {
      try { await loc.fill(email, { timeout: 2000 }); console.log(`filled email via ${sel}`); break; } catch {}
    }
  }
  for (const sel of ["input[name=HomeRealmByEmail]", "#submitButton", "input[type=submit]"]) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) {
      try { await loc.click({ timeout: 2000 }); console.log(`clicked submit via ${sel}`); break; } catch {}
    }
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await dump("step 1 (after email)");

  if (password) {
    for (const sel of ["#userNameInput", "input[name=UserName]"]) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) { try { await loc.fill(email, { timeout: 2000 }); console.log(`filled username via ${sel}`); } catch {} }
    }
    for (const sel of ["#passwordInput", "input[name=Password]", "input[type=password]"]) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) { try { await loc.fill(password, { timeout: 2000 }); console.log(`filled password via ${sel}`); break; } catch {} }
    }
    for (const sel of ["#submitButton", "input[type=submit]", "button[type=submit]"]) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) { try { await loc.click({ timeout: 2000 }); console.log(`clicked login via ${sel}`); break; } catch {} }
    }
    await page.waitForLoadState("networkidle").catch(() => {});
    await dump("step 2 (after password)");
  }
}

await browser.close();
