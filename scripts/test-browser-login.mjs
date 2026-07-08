// Standalone smoke test for browserAuth.ts. Run directly in your own terminal
// (not through an AI tool call) so EMAIL/PASSWORD never leave
// your machine:
//
//   EMAIL=you@studio.unibo.it PASSWORD=... node scripts/test-browser-login.mjs
//
import { loginWithBrowser } from "../dist/browserAuth.js";

const email = process.env.EMAIL;
const password = process.env.PASSWORD;
if (!email || !password) {
  console.error("Set EMAIL and PASSWORD env vars first.");
  process.exit(1);
}

const baseUrl = process.env.VIRTUALE_BASE_URL ?? "https://virtuale.unibo.it";

function summarize(name, res) {
  if (res.ok) {
    const cookieNames = res.cookies
      .split("; ")
      .map((c) => c.split("=")[0])
      .join(", ");
    console.log(`  ${name}: OK (final ${res.finalUrl}) cookies: ${cookieNames}${res.sesskey ? ` sesskey: ${res.sesskey}` : ""}`);
  } else {
    console.log(`  ${name}: FAILED — ${res.error}`);
  }
}

try {
  const result = await loginWithBrowser({ baseUrl, email, password });
  console.log("Browser login finished. Per-service result:");
  summarize("virtuale", result.virtuale);
  summarize("almaesami", result.almaesami);
  summarize("rps", result.rps);
  summarize("sol", result.sol);
} catch (err) {
  console.error("Login failed:", err.message);
  process.exit(1);
}
