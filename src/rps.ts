import { load } from "cheerio";

/**
 * RPS — "Registro Presenze Studenti" (rps.unibo.it), the Unibo student
 * attendance system. A CakePHP app behind ADFS SAML SSO; authentication is a
 * bootstrap-style `PHPSESSID` cookie captured from a logged-in browser (see
 * almaesami-rps-api-notes.md). It renders plain Bootstrap tables, so we scrape.
 *
 * Read-only. Confirming attendance (submitting a "codice rilevazione") is a
 * consequential write and is intentionally not automated.
 */

export type AttendanceRecord = {
  /** When attendance was recorded, e.g. "08/06/2026 15:13". */
  datetime: string;
  /** Subject code, e.g. "84285". */
  code: string;
  /** Subject/module name, e.g. "SIGNALING PATHWAYS ... / CELL SIGNALING". */
  name: string;
  /** Lecturer name. */
  teacher: string;
  /** Lesson duration as shown, e.g. "02:00". */
  duration: string;
};

export type RegisterEntry = {
  /** Subject code, e.g. "84166". */
  code: string;
  /** Subject name, e.g. "HUMANITIES AND SCIENTIFIC METHODS (I.C.)". */
  name: string;
  /** Hours attended as shown, e.g. "55:00". */
  hours: string;
  /** Attendance percentage as shown (Italian format), e.g. "80,88%"; may be "". */
  percentage: string;
};

const DEFAULT_BASE_URL = "https://rps.unibo.it";
const SURVEYS_PATH = "/students/surveys?lang=it";
const REGISTER_PATH = "/students/register?lang=it";

function isUnauthenticated(html: string, url: string): boolean {
  // NB: an authenticated page still links to the ADFS *sign-out* URL
  // (wa=wsignout1.0), so a bare "idp.unibo.it/adfs" substring in the HTML is not
  // a reliable signal. Only treat it as unauthenticated when the request itself
  // ended at the IdP, or the page is the SAML sign-in form.
  return (
    /idp\.unibo\.it\/adfs/i.test(url) ||
    /name="SAMLRequest"/i.test(html) ||
    /<title>\s*Sign In\s*<\/title>/i.test(html)
  );
}

/** Split "84285 SIGNALING PATHWAYS ..." into leading code + remaining name. */
function splitSubject(cell: string): { code: string; name: string } {
  const s = cell.trim();
  const space = s.indexOf(" ");
  if (space === -1) {
    return { code: s, name: "" };
  }
  return { code: s.slice(0, space).trim(), name: s.slice(space + 1).trim() };
}

/**
 * Return the tbody rows of the first table as a matrix of trimmed cell texts,
 * after asserting the page is an authenticated RPS view.
 */
function readTableRows(html: string, url: string): string[][] {
  if (isUnauthenticated(html, url)) {
    throw new Error(
      "RPS session is missing or expired (redirected to Unibo SSO). Re-capture the PHPSESSID cookie after logging into rps.unibo.it."
    );
  }

  const $ = load(html);
  const table = $("table").first();
  if (!table.length) {
    throw new Error("Could not find the RPS data table in the page.");
  }

  const rows: string[][] = [];
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr)
      .children("td")
      .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();
    if (cells.length) {
      rows.push(cells);
    }
  });
  return rows;
}

/** Parse the "Rilevazioni" attendance-records table. Pure/testable. */
export function parseAttendanceRecords(html: string, url = ""): { records: AttendanceRecord[] } {
  const records: AttendanceRecord[] = [];

  for (const cells of readTableRows(html, url)) {
    if (cells.length < 4) {
      continue;
    }
    const { code, name } = splitSubject(cells[1]);
    records.push({
      datetime: cells[0],
      code,
      name,
      teacher: cells[2],
      duration: cells[3]
    });
  }

  return { records };
}

/** Parse the "Registro" attendance-summary table. Pure/testable. */
export function parseRegister(html: string, url = ""): { entries: RegisterEntry[] } {
  const entries: RegisterEntry[] = [];

  for (const cells of readTableRows(html, url)) {
    if (cells.length < 2) {
      continue;
    }
    const { code, name } = splitSubject(cells[0]);
    entries.push({
      code,
      name,
      hours: cells[1] ?? "",
      percentage: cells[2] ?? ""
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

/** Fetch and parse the authenticated student's attendance records (Rilevazioni). */
export async function getAttendanceRecords(input: {
  cookies: string;
  baseUrl?: string;
}): Promise<{ endpoint: string; total: number; records: AttendanceRecord[] }> {
  const { url, html } = await fetchStudentPage(SURVEYS_PATH, input);
  const { records } = parseAttendanceRecords(html, url);
  return { endpoint: url, total: records.length, records };
}

/** Fetch and parse the authenticated student's attendance register (Registro). */
export async function getRegister(input: {
  cookies: string;
  baseUrl?: string;
}): Promise<{ endpoint: string; total: number; entries: RegisterEntry[] }> {
  const { url, html } = await fetchStudentPage(REGISTER_PATH, input);
  const { entries } = parseRegister(html, url);
  return { endpoint: url, total: entries.length, entries };
}
