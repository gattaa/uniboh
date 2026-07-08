import { test } from "node:test";
import assert from "node:assert/strict";

import { parseExamPlan, parseExamHistory, parseMessages, parseAppelli } from "./almaesami.js";

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

// Bare iceDataTblOutline grid (no header row) for the history/messages parsers.
function grid(rows: string): string {
  return `<html><body><table class="iceDataTblOutline">${rows}</table></body></html>`;
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

test("parsers detect the session-expired page", () => {
  const expired = "<html><head><title>AlmaEsami - sessione scaduta</title></head><body>sessionExpired</body></html>";
  assert.throws(() => parseExamPlan(expired), /expired|scaduta/i);
  assert.throws(() => parseExamHistory(expired), /expired|scaduta/i);
  assert.throws(() => parseMessages(expired), /expired|scaduta/i);
});

test("parseExamHistory maps appello rows and extracts code/name/cds", () => {
  const html = grid(
    row([
      "04/02/2026 11:00",
      "84252 CHEMISTRY AND BIOCHEMISTRY (I.C.) (Cds. 6734)",
      "CALICETI CRISTIANA",
      "prova",
      "Scritto",
      "prenotato"
    ])
  );
  const { entries } = parseExamHistory(html);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    datetime: "04/02/2026 11:00",
    code: "84252",
    name: "CHEMISTRY AND BIOCHEMISTRY (I.C.)",
    cds: "6734",
    teacher: "CALICETI CRISTIANA",
    type: "prova",
    mode: "Scritto",
    status: "prenotato"
  });
});

test("parseExamHistory tolerates a missing (Cds. …) suffix", () => {
  const { entries } = parseExamHistory(
    grid(row(["01/01/2025 00:00", "C0233 PHILOSOPHY OF MEDICINE", "ROSSI M", "prova", "Orale", "sostenuto"]))
  );
  assert.equal(entries[0].code, "C0233");
  assert.equal(entries[0].name, "PHILOSOPHY OF MEDICINE");
  assert.equal(entries[0].cds, "");
});

test("parseMessages maps subject, sender, date and appello reference", () => {
  const html = grid(
    row([
      "",
      "PELLERI MARIA CHIARA: 19/02/2026 09:30",
      "09/02/2026 14:45",
      "Exam date change",
      "D'UVA GABRIELE MATTEO",
      "Leggi",
      "Cancella"
    ])
  );
  const { messages } = parseMessages(html);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    examRef: "PELLERI MARIA CHIARA: 19/02/2026 09:30",
    receivedAt: "09/02/2026 14:45",
    subject: "Exam date change",
    sender: "D'UVA GABRIELE MATTEO"
  });
});

test("parseMessages skips rows without a subject", () => {
  const { messages } = parseMessages(grid(row(["", "ref", "01/01/2026 00:00", "", "Sender", "Leggi", "Cancella"])));
  assert.equal(messages.length, 0);
});

// --- Appelli (upcoming exam sessions) ---------------------------------------
// NOTE: the appelli endpoint/grid is UNVERIFIED (behind SSO). These fixtures are
// synthesized from the documented iceDataTblOutline structure and the
// content-driven parser's contract — no real student data. The parser reads
// fields by content, so these also assert its layout-independence.

test("parseAppelli extracts date, activity, examiner, type/mode, enrollment, bookable", () => {
  const html = grid(
    row([
      "+",
      "19/02/2026 09:30",
      "84252 CHEMISTRY AND BIOCHEMISTRY (I.C.) (Cds. 6734)",
      "CALICETI CRISTIANA",
      "prova",
      "Scritto",
      "dal 01/02/2026 al 18/02/2026",
      "prenota"
    ])
  );
  const { entries } = parseAppelli(html);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    datetime: "19/02/2026 09:30",
    code: "84252",
    name: "CHEMISTRY AND BIOCHEMISTRY (I.C.)",
    cds: "6734",
    teacher: "CALICETI CRISTIANA",
    type: "prova",
    mode: "Scritto",
    enrollmentOpens: "01/02/2026",
    enrollmentCloses: "18/02/2026",
    bookable: true
  });
});

test("parseAppelli is layout-independent (columns reordered)", () => {
  // Same fields, shuffled column order — content-driven extraction still works.
  const html = grid(
    row([
      "ROSSI MARIO",
      "84280 MORPHOLOGY",
      "Orale",
      "27/06/2026 14:00",
      "listaAperta",
      "dal 01/06/2026 08:00 al 25/06/2026 23:59"
    ])
  );
  const { entries } = parseAppelli(html);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    datetime: "27/06/2026 14:00",
    code: "84280",
    name: "MORPHOLOGY",
    cds: "",
    teacher: "ROSSI MARIO",
    type: "listaAperta",
    mode: "Orale",
    enrollmentOpens: "01/06/2026 08:00",
    enrollmentCloses: "25/06/2026 23:59",
    bookable: false
  });
});

test("parseAppelli does not mistake the enrollment window for the appello date", () => {
  const { entries } = parseAppelli(
    grid(row(["04/07/2026 10:00", "12345 ANATOMY", "BIANCHI L", "prova", "Orale", "dal 01/07/2026 al 03/07/2026"]))
  );
  assert.equal(entries[0].datetime, "04/07/2026 10:00");
  assert.equal(entries[0].enrollmentOpens, "01/07/2026");
});

test("parseAppelli tolerates a missing enrollment window", () => {
  const { entries } = parseAppelli(
    grid(row(["10/09/2026 09:00", "C0233 PHILOSOPHY OF MEDICINE", "VERDI G", "prova", "Scritto"]))
  );
  assert.equal(entries[0].enrollmentOpens, "");
  assert.equal(entries[0].enrollmentCloses, "");
  assert.equal(entries[0].code, "C0233");
});

test("parseAppelli skips header/spacer rows without an activity", () => {
  const html = grid(
    "<tr><th>Data</th><th>Insegnamento</th><th>Docente</th><th>Tipo</th></tr>" +
      row(["05/05/2026 09:00", "84276 CELLULAR BIOLOGY", "NERI A", "prova", "Orale"])
  );
  const { entries } = parseAppelli(html);
  assert.equal(entries.length, 1);
});

test("parseAppelli throws on an expired/SSO session like the other readers", () => {
  const expired = "<html><head><title>AlmaEsami - sessione scaduta</title></head><body>sessionExpired</body></html>";
  assert.throws(() => parseAppelli(expired), /expired|scaduta|SSO/i);
});
