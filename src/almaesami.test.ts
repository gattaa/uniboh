import { test } from "node:test";
import assert from "node:assert/strict";

import { parseExamPlan } from "./almaesami.js";

// Synthetic fixture mirroring the AlmaEsami "Riepilogo Esami" grid structure.
// (Real student data is never committed.)
function planPage(rows: string): string {
  return `<html><body>
    <table class="iceDataTblOutline">
      <tr><th>Anno</th><th>Attività</th><th>Cds</th><th>Cfu</th><th>Stato</th><th></th></tr>
      ${rows}
    </table>
  </body></html>`;
}

function row(cells: string[]): string {
  return "<tr>" + cells.map((c) => `<td>${c}</td>`).join("") + "</tr>";
}

test("parseExamPlan extracts one entry per data row", () => {
  const html = planPage(
    row(["+", "1", "84276 - CELLULAR BIOLOGY", "6734", "10", "verbalizzato: 30 e lode", ""]) +
      row(["+", "2", "84252 - CHEMISTRY", "6734", "8", "", "prenota"])
  );
  const { entries } = parseExamPlan(html);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    year: "1",
    code: "84276",
    name: "CELLULAR BIOLOGY",
    cds: "6734",
    cfu: "10",
    status: "verbalizzato: 30 e lode",
    bookable: false,
    hasMessage: false
  });
});

test("parseExamPlan flags bookable rows via the prenota action", () => {
  const html = planPage(row(["+", "1", "84280 - MORPHOLOGY", "6734", "8", "", "prenota"]));
  const { entries } = parseExamPlan(html);
  assert.equal(entries[0].bookable, true);
});

test("parseExamPlan flags messages from a Leggi action or 'nuova comunicazione' status", () => {
  const viaAction = parseExamPlan(
    planPage(row(["+", "1", "84292 - CLERKSHIP", "6734", "1", "", "Leggi"]))
  ).entries[0];
  const viaStatus = parseExamPlan(
    planPage(row(["+", "1", "84292 - CLERKSHIP", "6734", "1", "nuova comunicazione", ""]))
  ).entries[0];
  assert.equal(viaAction.hasMessage, true);
  assert.equal(viaStatus.hasMessage, true);
});

test("parseExamPlan splits code/name on the first separator only", () => {
  // Name itself contains ' - '.
  const { entries } = parseExamPlan(
    planPage(row(["+", "1", "84292 - CLINICAL CLERKSHIP - BASIC LIFE SUPPORT", "6734", "1", "", ""]))
  );
  assert.equal(entries[0].code, "84292");
  assert.equal(entries[0].name, "CLINICAL CLERKSHIP - BASIC LIFE SUPPORT");
});

test("parseExamPlan throws a clear error on an SSO login bounce", () => {
  const bounce = '<html><body><form action="https://idp.unibo.it/adfs/ls/"><input name="SAMLRequest"></form></body></html>';
  assert.throws(() => parseExamPlan(bounce), /SSO login page|expired/i);
});

test("parseExamPlan throws when the grid is absent", () => {
  assert.throws(() => parseExamPlan("<html><body>no grid here</body></html>"), /iceDataTblOutline/);
});
