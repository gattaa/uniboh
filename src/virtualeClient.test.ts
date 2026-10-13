import { test } from "node:test";
import assert from "node:assert/strict";
import { compactMoodle } from "./virtualeClient.js";

test("compactMoodle drops bulky keys and data: URIs at any depth, truncates long strings", () => {
  const out = compactMoodle(
    {
      courses: [
        { id: 7, fullname: "Anatomy", summary: "<p>long html</p>", courseimage: "data:image/png;base64,AAAA", viewurl: "https://x/7", note: "y".repeat(20) }
      ]
    },
    15
  );
  assert.deepEqual(out, {
    courses: [{ id: 7, fullname: "Anatomy", viewurl: "https://x/7", note: "yyyyyyyyyyyyyyy…[truncated 5 chars]" }]
  });
});
