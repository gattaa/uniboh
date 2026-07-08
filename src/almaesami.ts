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
