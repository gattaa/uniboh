import { load } from "cheerio";

import { ALMAESAMI_EXPIRED_MESSAGE, SessionExpiredError, isAlmaesamiAuthExpired } from "./sessions.js";

/**
 * AlmaEsami (almaesami.unibo.it) student read-only scrapers.
 *
 * AlmaEsami is a stateful ICEfaces / Spring Web Flow servlet app behind Unibo's
 * ADFS SAML SSO. There is no JSON API, so we scrape the student pages, each of
 * which renders a `table.iceDataTblOutline` grid. Authentication is a
 * bootstrap-style `JSESSIONID` cookie captured from a logged-in browser (see
 * almaesami-rps-api-notes.md); scripted login is not viable.
 *
 * These readers never mutate state. Booking ("prenota"), deleting messages
 * ("Cancella") and similar actions are consequential JSF postbacks and are
 * intentionally not automated.
 */

const DEFAULT_BASE_URL = "https://almaesami.unibo.it";
const EXAM_PLAN_PATH = "/almaesami/studenti/attivitaFormativaPiano-list.htm";
const EXAM_HISTORY_PATH = "/almaesami/studenti/cronologia-list.htm";
const MESSAGES_PATH = "/almaesami/studenti/messaggioStudente.htm";

/**
 * Endpoint for the upcoming-appelli list (bookable exam sessions / "cerca
 * appelli").
 *
 * UNVERIFIED — unlike the three endpoints above, this path could NOT be
 * confirmed from a live session. Unauthenticated probing on 2026-07-08 showed
 * the AlmaEsami servlet gates the whole `/almaesami/studenti/` tree behind ADFS
 * SSO *before* routing: every `studenti/*.htm` name — real or invented — returns
 * `302 -> idp.unibo.it/adfs`, so the exact route name cannot be distinguished
 * without a valid `JSESSIONID` (which we don't have). This default follows the
 * documented `<entity>-list.htm` Spring Web Flow convention and the "prenota"
 * action the exam plan already exposes. A caller who knows the real route can
 * override it via the `path` argument (see the `almaesami_list_appelli` tool).
 *
 * The parser below is deliberately layout-independent (it identifies fields by
 * content, not fixed column offsets) precisely because the grid's column order
 * is likewise unverified.
 */
const APPELLI_PATH = "/almaesami/studenti/appelloStudente-list.htm";

export type ExamPlanEntry = {
  /** Course year the activity belongs to, e.g. "1". */
  year: string;
  /** Activity (insegnamento) code, e.g. "84276". */
  code: string;
  /** Activity name, e.g. "CELLULAR MOLECULAR BIOLOGY AND GENETICS (I.C.)". */
  name: string;
  /** Course-of-study (CdS) code, e.g. "6734". */
  cds: string;
  /** Credits (CFU) as shown, e.g. "10". */
  cfu: string;
  /** Raw status/description text, e.g. "verbalizzato: 30 e lode". */
  status: string;
  /** True when the row exposes a "prenota" (book) action. */
  bookable: boolean;
  /** True when the row has a message to read ("Leggi" / "nuova comunicazione"). */
  hasMessage: boolean;
};

export type ExamHistoryEntry = {
  /** Appello date/time as shown, e.g. "04/02/2026 11:00". */
  datetime: string;
  /** Activity code, e.g. "84252". */
  code: string;
  /** Activity name, e.g. "CHEMISTRY AND BIOCHEMISTRY (I.C.)". */
  name: string;
  /** Course-of-study (CdS) code, e.g. "6734". */
  cds: string;
  /** Examiner name, e.g. "CALICETI CRISTIANA". */
  teacher: string;
  /** Appello type, e.g. "prova", "listaAperta". */
  type: string;
  /** Exam mode, e.g. "Scritto", "Orale", "Altro". */
  mode: string;
  /** Status, e.g. "prenotato", "sostenuto", "verbalizzato". */
  status: string;
};

export type StudentMessage = {
  /** Related appello reference, e.g. "PELLERI MARIA CHIARA: 19/02/2026 09:30". */
  examRef: string;
  /** When the message was received, e.g. "09/02/2026 14:45". */
  receivedAt: string;
  /** Subject line. */
  subject: string;
  /** Sender name. */
  sender: string;
};

export type AppelloEntry = {
  /** Exam-session (appello) date/time as shown, e.g. "19/02/2026 09:30". */
  datetime: string;
  /** Activity (insegnamento) code, e.g. "84252". */
  code: string;
  /** Activity name, e.g. "CHEMISTRY AND BIOCHEMISTRY (I.C.)". */
  name: string;
  /** Course-of-study (CdS) code when present, e.g. "6734". */
  cds: string;
  /** Examiner / lead teacher, e.g. "CALICETI CRISTIANA". */
  teacher: string;
  /** Appello type, e.g. "prova", "listaAperta". */
  type: string;
  /** Exam mode, e.g. "Scritto", "Orale", "Altro". */
  mode: string;
  /** Enrollment window opening as shown, e.g. "01/02/2026" (empty if absent). */
  enrollmentOpens: string;
  /** Enrollment window closing as shown, e.g. "18/02/2026" (empty if absent). */
  enrollmentCloses: string;
  /** True when the row exposes a "prenota" (book) action. We never book. */
  bookable: boolean;
};

/**
 * Extract the rows of the first `table.iceDataTblOutline` as a matrix of
 * trimmed cell texts. Throws with a clear message on an expired/absent session
 * or a missing grid, so every reader gets consistent error handling.
 */
function readGridRows(html: string, url = ""): string[][] {
  if (isAlmaesamiAuthExpired(html, url)) {
    throw new SessionExpiredError("almaesami", ALMAESAMI_EXPIRED_MESSAGE);
  }

  const $ = load(html);
  const grid = $("table.iceDataTblOutline").first();
  if (!grid.length) {
    throw new Error("Could not find the data grid (table.iceDataTblOutline) in the page.");
  }

  // NB: cheerio's .map() flattens nested arrays, so build the matrix with .each().
  const rows: string[][] = [];
  grid.find("tr").each((_, tr) => {
    const cells = $(tr)
      .children("td")
      .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();
    rows.push(cells);
  });
  return rows;
}

/** Split "84276 - CELLULAR BIOLOGY" into code + name on the first " - ". */
function splitCodeAndNameDash(cell: string): { code: string; name: string } {
  const sep = cell.indexOf(" - ");
  if (sep === -1) {
    return { code: "", name: cell.trim() };
  }
  return { code: cell.slice(0, sep).trim(), name: cell.slice(sep + 3).trim() };
}

/**
 * Parse "84252 CHEMISTRY AND BIOCHEMISTRY (I.C.) (Cds. 6734)" into its parts.
 * Code is the leading token; the CdS is the trailing "(Cds. NNNN)".
 */
function splitActivityWithCds(cell: string): { code: string; name: string; cds: string } {
  let cds = "";
  let rest = cell.replace(/\s*\(Cds\.\s*([^)]+)\)\s*$/i, (_, c) => {
    cds = String(c).trim();
    return "";
  });
  rest = rest.trim();

  const space = rest.indexOf(" ");
  if (space === -1) {
    return { code: rest, name: "", cds };
  }
  return { code: rest.slice(0, space).trim(), name: rest.slice(space + 1).trim(), cds };
}

/** Parse the "Riepilogo Esami Studente" exam-plan grid. Pure/testable. */
export function parseExamPlan(html: string, url = ""): { entries: ExamPlanEntry[] } {
  const entries: ExamPlanEntry[] = [];

  for (const cells of readGridRows(html, url)) {
    if (cells.length < 7) {
      continue;
    }

    const { code, name } = splitCodeAndNameDash(cells[2]);
    if (!code && !name) {
      continue;
    }

    const status = cells[5];
    const action = cells[6].toLowerCase();

    entries.push({
      year: cells[1],
      code,
      name,
      cds: cells[3],
      cfu: cells[4],
      status,
      bookable: action.includes("prenota"),
      hasMessage: action.includes("leggi") || /nuova comunicazione/i.test(status)
    });
  }

  return { entries };
}

/** Parse the "Cronologia" exam-history grid. Pure/testable. */
export function parseExamHistory(html: string, url = ""): { entries: ExamHistoryEntry[] } {
  const entries: ExamHistoryEntry[] = [];

  for (const cells of readGridRows(html, url)) {
    if (cells.length < 6) {
      continue;
    }

    const { code, name, cds } = splitActivityWithCds(cells[1]);
    if (!code && !name) {
      continue;
    }

    entries.push({
      datetime: cells[0],
      code,
      name,
      cds,
      teacher: cells[2],
      type: cells[3],
      mode: cells[4],
      status: cells[5]
    });
  }

  return { entries };
}

/** Parse the student "Messaggi" grid. Pure/testable. */
export function parseMessages(html: string, url = ""): { messages: StudentMessage[] } {
  const messages: StudentMessage[] = [];

  for (const cells of readGridRows(html, url)) {
    if (cells.length < 5) {
      continue;
    }

    const subject = cells[3];
    if (!subject) {
      continue;
    }

    messages.push({
      examRef: cells[1],
      receivedAt: cells[2],
      subject,
      sender: cells[4]
    });
  }

  return { messages };
}

// --- Appelli (upcoming exam sessions) — content-driven, layout-independent ---
//
// The appelli grid's exact column order is UNVERIFIED (see APPELLI_PATH), so
// rather than trust fixed offsets we recognise each field by its content shape.
// This tolerates column reordering and optional columns across CdS/course
// configurations.

/** A date, optionally with an HH:MM time, as AlmaEsami renders them. */
const DATE_RE = /\b\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?\b/;
/** Enrollment window "dal <date> al <date>" (times optional). */
const ENROLL_RE =
  /\bdal\s+(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)\s+al\s+(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/i;
/** Appello type keywords (rendered variants of prova / listaAperta / appello). */
const TYPE_RE = /\b(lista\s*aperta|listaAperta|prova\s+parziale|prova|appello)\b/i;
/** Exam-mode keywords. */
const MODE_RE = /\b(scritto\s+e\s+orale|scritto|orale|pratico|colloquio|altro)\b/i;
/** Leading course-code token: a 4–6 digit code or a letter-prefixed code (C0233). */
const CODE_TOKEN_RE = /^([0-9]{4,6}|[A-Z]{1,3}[0-9]{3,5})\b/;

/** A cell that starts with a course code and carries an alphabetic name. */
function looksLikeActivity(cell: string): boolean {
  if (!CODE_TOKEN_RE.test(cell)) return false;
  return /[A-Za-z]{3,}/.test(cell.replace(CODE_TOKEN_RE, ""));
}

/** A cell that looks like an examiner name: two+ all-caps tokens, no digits. */
function looksLikeTeacher(cell: string): boolean {
  return /^[A-ZÀ-Þ][A-ZÀ-Þ'.\-]*(?:\s+[A-ZÀ-Þ'.\-]+)+$/.test(cell);
}

/**
 * Parse the upcoming-appelli grid into one entry per exam session. Pure/testable.
 *
 * Fields are extracted by content, not column position (the layout is
 * UNVERIFIED). Rows without a recognisable activity cell (headers, spacers) are
 * skipped. Strictly read-only: a "prenota" action only sets {@link
 * AppelloEntry.bookable}; nothing here books.
 */
export function parseAppelli(html: string): { entries: AppelloEntry[] } {
  const entries: AppelloEntry[] = [];

  for (const cells of readGridRows(html)) {
    const activityCell = cells.find(looksLikeActivity);
    if (!activityCell) {
      continue;
    }
    const { code, name, cds } = splitActivityWithCds(activityCell);

    const rowText = cells.join(" ");
    const enroll = ENROLL_RE.exec(rowText);

    // Appello datetime: the first date-bearing cell that is neither the activity
    // cell nor part of the "dal … al …" enrollment window.
    let datetime = "";
    for (const cell of cells) {
      if (cell === activityCell || /\bdal\b/i.test(cell)) continue;
      const m = DATE_RE.exec(cell);
      if (m) {
        datetime = m[0];
        break;
      }
    }

    const teacher = cells.find((c) => c !== activityCell && looksLikeTeacher(c)) ?? "";

    entries.push({
      datetime,
      code,
      name,
      cds,
      teacher,
      type: (TYPE_RE.exec(rowText)?.[0] ?? "").trim(),
      mode: (MODE_RE.exec(rowText)?.[0] ?? "").trim(),
      enrollmentOpens: enroll?.[1] ?? "",
      enrollmentCloses: enroll?.[2] ?? "",
      bookable: /prenota/i.test(rowText)
    });
  }

  return { entries };
}

async function fetchStudentPage(
  path: string,
  input: { cookies: string; baseUrl?: string }
): Promise<{ url: string; html: string }> {
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const endpoint = new URL(path, baseUrl).toString();

  const res = await fetch(endpoint, {
    redirect: "follow",
    headers: { Cookie: input.cookies }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching ${endpoint}.`);
  }

  return { url: res.url || endpoint, html: await res.text() };
}

/** Fetch and parse the authenticated student's exam plan. */
export async function getExamPlan(input: {
  cookies: string;
  baseUrl?: string;
}): Promise<{ endpoint: string; total: number; entries: ExamPlanEntry[] }> {
  const { url, html } = await fetchStudentPage(EXAM_PLAN_PATH, input);
  const { entries } = parseExamPlan(html, url);
  return { endpoint: url, total: entries.length, entries };
}

/** Fetch and parse the authenticated student's exam history (cronologia). */
export async function getExamHistory(input: {
  cookies: string;
  baseUrl?: string;
}): Promise<{ endpoint: string; total: number; entries: ExamHistoryEntry[] }> {
  const { url, html } = await fetchStudentPage(EXAM_HISTORY_PATH, input);
  const { entries } = parseExamHistory(html, url);
  return { endpoint: url, total: entries.length, entries };
}

/** Fetch and parse the authenticated student's messages. */
export async function getMessages(input: {
  cookies: string;
  baseUrl?: string;
}): Promise<{ endpoint: string; total: number; messages: StudentMessage[] }> {
  const { url, html } = await fetchStudentPage(MESSAGES_PATH, input);
  const { messages } = parseMessages(html, url);
  return { endpoint: url, total: messages.length, messages };
}

/**
 * Fetch and parse the authenticated student's upcoming appelli (exam sessions).
 *
 * `path` defaults to {@link APPELLI_PATH} but is overridable because that route
 * is UNVERIFIED (see its doc comment). `unverified: true` is surfaced in the
 * result so callers/agents know this reader has not been confirmed against a
 * live session — an empty `entries` list may mean "no appelli" OR "wrong route
 * / unexpected grid". Read-only: never books.
 */
export async function getAppelli(input: {
  cookies: string;
  baseUrl?: string;
  path?: string;
}): Promise<{
  endpoint: string;
  total: number;
  entries: AppelloEntry[];
  unverified: true;
}> {
  const { url, html } = await fetchStudentPage(input.path ?? APPELLI_PATH, input);
  const { entries } = parseAppelli(html);
  return { endpoint: url, total: entries.length, entries, unverified: true };
}
