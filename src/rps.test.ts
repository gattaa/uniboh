import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAttendanceRecords, parseRegister } from "./rps.js";

function table(headers: string[], rows: string[][]): string {
  const head = "<thead><tr>" + headers.map((h) => `<th>${h}</th>`).join("") + "</tr></thead>";
  const body =
    "<tbody>" +
    rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") +
    "</tbody>";
  return `<html><body><table class="table">${head}${body}</table></body></html>`;
}

test("parseAttendanceRecords maps rows and splits subject code/name", () => {
  const html = table(
    ["Data", "Materia", "Docente", "Durata lezione"],
    [
      ["08/06/2026 15:13", "84285 SIGNALING PATHWAYS (I.C.) / CELL SIGNALING", "Maria Luisa Genova", "02:00"]
    ]
  );
  const { records } = parseAttendanceRecords(html);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    datetime: "08/06/2026 15:13",
    code: "84285",
    name: "SIGNALING PATHWAYS (I.C.) / CELL SIGNALING",
    teacher: "Maria Luisa Genova",
    duration: "02:00"
  });
});

test("parseRegister maps subject, hours and percentage, tolerating an empty percentage", () => {
  const html = table(
    ["Materia", "Ore", "Perc. Percentuale"],
    [
      ["84166 HUMANITIES AND SCIENTIFIC METHODS (I.C.)", "55:00", "80,88%"],
      ["83145 HISTORY OF MEDICINE", "08:30", ""]
    ]
  );
  const { entries } = parseRegister(html);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    code: "84166",
    name: "HUMANITIES AND SCIENTIFIC METHODS (I.C.)",
    hours: "55:00",
    percentage: "80,88%"
  });
  assert.equal(entries[1].percentage, "");
});

test("RPS parsers detect an SSO sign-in bounce", () => {
  const signin = '<html><head><title>Sign In</title></head><body><form><input name="SAMLRequest"></form></body></html>';
  assert.throws(() => parseAttendanceRecords(signin), /session is missing or expired|SSO/i);
  assert.throws(() => parseRegister(signin), /session is missing or expired|SSO/i);
});

test("RPS parsers detect a bounce via the final URL landing on the IdP", () => {
  const page = table(["Materia", "Ore", "Perc. Percentuale"], [["1 X", "1:00", ""]]);
  assert.throws(
    () => parseRegister(page, "https://idp.unibo.it/adfs/ls/?SAMLRequest=xyz"),
    /session is missing or expired/i
  );
});

test("RPS auth check does not false-positive on the ADFS sign-out link", () => {
  // An authenticated page links to the ADFS wsignout1.0 URL in its nav.
  const html = table(["Materia", "Ore", "Perc. Percentuale"], [["84166 HUMANITIES", "55:00", "80%"]]).replace(
    "<body>",
    '<body><a href="https://idp.unibo.it/adfs/ls/?wa=wsignout1.0">Logout</a>'
  );
  const { entries } = parseRegister(html);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].code, "84166");
});
