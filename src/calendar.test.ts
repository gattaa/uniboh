import { test } from "node:test";
import assert from "node:assert/strict";

import { academicMonths, chunkRange, eventsToIcs, toTimetableUrl, type TimetableEvent } from "./calendar.js";

function makeEvent(overrides: Partial<TimetableEvent> = {}): TimetableEvent {
  return {
    title: "Analisi Matematica",
    start: "2026-03-02T09:00:00+01:00",
    end: "2026-03-02T11:00:00+01:00",
    raw: {},
    ...overrides
  };
}

test("eventsToIcs wraps events in a VCALENDAR envelope", () => {
  const ics = eventsToIcs([makeEvent()], "My Cal");
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(ics, /VERSION:2\.0/);
  assert.match(ics, /X-WR-CALNAME:My Cal/);
});

test("eventsToIcs emits one VEVENT per valid event", () => {
  const ics = eventsToIcs([makeEvent(), makeEvent({ title: "Fisica" })]);
  const count = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
  assert.equal(count, 2);
});

test("eventsToIcs converts local times to UTC Zulu stamps", () => {
  // 09:00+01:00 -> 08:00Z
  const ics = eventsToIcs([makeEvent()]);
  assert.match(ics, /DTSTART:20260302T080000Z/);
  assert.match(ics, /DTEND:20260302T100000Z/);
});

test("eventsToIcs skips events with unparseable dates", () => {
  const ics = eventsToIcs([makeEvent({ start: "not-a-date" })]);
  assert.doesNotMatch(ics, /BEGIN:VEVENT/);
});

test("eventsToIcs escapes special characters in text fields", () => {
  const ics = eventsToIcs([
    makeEvent({ title: "Reti; Sistemi, Lab\\1" })
  ]);
  assert.match(ics, /SUMMARY:Reti\\; Sistemi\\, Lab\\\\1/);
});

test("eventsToIcs includes optional location, docente, and teams fields", () => {
  const ics = eventsToIcs([
    makeEvent({
      location: "Aula 3, Via Zamboni",
      docente: "Mario Rossi",
      teams: "https://teams.example/x"
    })
  ]);
  assert.match(ics, /LOCATION:Aula 3\\, Via Zamboni/);
  assert.match(ics, /DESCRIPTION:Docente: Mario Rossi/);
  assert.match(ics, /URL:https:\/\/teams\.example\/x/);
});

test("eventsToIcs omits optional lines when fields are absent", () => {
  const ics = eventsToIcs([makeEvent()]);
  assert.doesNotMatch(ics, /LOCATION:/);
  assert.doesNotMatch(ics, /DESCRIPTION:/);
  assert.doesNotMatch(ics, /\r\nURL:/);
});

test("eventsToIcs derives a stable UID from extCode and start", () => {
  const a = eventsToIcs([makeEvent({ extCode: "12345|1" })]);
  const b = eventsToIcs([makeEvent({ extCode: "12345|1" })]);
  const uidA = a.match(/UID:(.+)\r\n/)?.[1];
  const uidB = b.match(/UID:(.+)\r\n/)?.[1];
  assert.ok(uidA);
  assert.equal(uidA, uidB);
  assert.match(uidA!, /@uniboh$/);
});

test("academicMonths covers Sep to Aug around now, one month per range", () => {
  const months = academicMonths(new Date("2026-10-13T12:00:00Z"));
  assert.equal(months.length, 12);
  assert.deepEqual(months[0], { start: "2026-09-01", end: "2026-09-30" });
  assert.deepEqual(months[5], { start: "2027-02-01", end: "2027-02-28" });
  assert.deepEqual(months[11], { start: "2027-08-01", end: "2027-08-31" });
  assert.equal(academicMonths(new Date("2027-07-01T12:00:00Z"))[0]?.start, "2026-09-01");
});

test("chunkRange splits an inclusive range into capped chunks", () => {
  assert.deepEqual(chunkRange("2026-10-12", "2026-10-18"), [{ start: "2026-10-12", end: "2026-10-18" }]);
  assert.deepEqual(chunkRange("2026-10-01", "2026-11-05", 31), [
    { start: "2026-10-01", end: "2026-10-31" },
    { start: "2026-11-01", end: "2026-11-05" }
  ]);
  assert.throws(() => chunkRange("2026-10-18", "2026-10-12"));
});

test("toTimetableUrl keeps the page's own type/course and rejects unknown types", () => {
  assert.equal(
    toTimetableUrl("https://corsi.unibo.it/singlecycle/MedicineAndSurgery/timetable"),
    "https://corsi.unibo.it/singlecycle/MedicineAndSurgery"
  );
  assert.equal(
    toTimetableUrl("https://corsi.unibo.it/magistralecu/MedicinaChirurgia/orario-lezioni"),
    "https://corsi.unibo.it/magistralecu/MedicinaChirurgia"
  );
  assert.equal(toTimetableUrl("https://corsi.unibo.it/en/foo"), undefined);
  assert.equal(toTimetableUrl("https://example.com/laurea/x"), undefined);
});
