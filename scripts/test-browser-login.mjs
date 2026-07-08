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

try {
  const result = await loginWithBrowser({ baseUrl, email, password });
  console.log("Login succeeded.");
  console.log("sesskey:", result.sesskey);
  console.log("final URL:", result.finalUrl);
  console.log("cookie names:", result.cookies.split("; ").map((c) => c.split("=")[0]).join(", "));
} catch (err) {
  console.error("Login failed:", err.message);
  process.exit(1);
}
