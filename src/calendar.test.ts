import { test } from "node:test";
import assert from "node:assert/strict";

import { eventsToIcs, type TimetableEvent } from "./calendar.js";

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
