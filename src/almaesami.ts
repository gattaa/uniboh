import { load } from "cheerio";

/**
 * AlmaEsami (almaesami.unibo.it) student exam-plan reader.
 *
 * AlmaEsami is a stateful ICEfaces / Spring Web Flow servlet app behind Unibo's
 * ADFS SAML SSO. There is no JSON API, so we scrape the student "Riepilogo Esami"
 * grid. Authentication is a bootstrap-style `JSESSIONID` cookie captured from a
 * logged-in browser (see almaesami-rps-api-notes.md); scripted login is not viable.
 *
 * This module only READS the exam plan. Booking an exam ("prenota") is a
 * consequential, stateful JSF postback and is intentionally not automated.
 */

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
  /**
   * Raw status/description text, e.g. "verbalizzato: 30 e lode",
   * "prenotato - written test", "nuova comunicazione", or "".
   */
  status: string;
  /** True when the row exposes a "prenota" (book) action. */
  bookable: boolean;
  /** True when the row has a message to read ("Leggi" / "nuova comunicazione"). */
  hasMessage: boolean;
};

const DEFAULT_BASE_URL = "https://almaesami.unibo.it";
const EXAM_PLAN_PATH = "/almaesami/studenti/attivitaFormativaPiano-list.htm";

function isLoginBounce(html: string): boolean {
  return /SAMLRequest|idp\.unibo\.it\/adfs/i.test(html);
}

function splitCodeAndName(cell: string): { code: string; name: string } {
  const sep = cell.indexOf(" - ");
  if (sep === -1) {
    return { code: "", name: cell.trim() };
  }
  return {
    code: cell.slice(0, sep).trim(),
    name: cell.slice(sep + 3).trim()
  };
}

/**
 * Parse the AlmaEsami "Riepilogo Esami Studente" HTML into structured entries.
 * Pure and network-free so it can be unit-tested against fixtures.
 */
export function parseExamPlan(html: string): { entries: ExamPlanEntry[] } {
  if (isLoginBounce(html)) {
    throw new Error(
      "AlmaEsami returned the SSO login page. The JSESSIONID cookie is missing or expired; re-capture it from a logged-in browser."
    );
  }

  const $ = load(html);
  const grid = $("table.iceDataTblOutline").first();
  if (!grid.length) {
    throw new Error("Could not find the exam-plan grid (table.iceDataTblOutline) in the page.");
  }

  const entries: ExamPlanEntry[] = [];

  grid.find("tr").each((_, tr) => {
    const cells = $(tr).children("td");
    // Data rows carry the full column set; the header row has none/th.
    if (cells.length < 7) {
      return;
    }

    const text = (i: number) => $(cells[i]).text().replace(/\s+/g, " ").trim();

    const { code, name } = splitCodeAndName(text(2));
    if (!code && !name) {
      return;
    }

    const status = text(5);
    const action = text(6).toLowerCase();

    entries.push({
      year: text(1),
      code,
      name,
      cds: text(3),
      cfu: text(4),
      status,
      bookable: action.includes("prenota"),
      hasMessage: action.includes("leggi") || /nuova comunicazione/i.test(status)
    });
  });

  return { entries };
}

/**
 * Fetch and parse the authenticated student's exam plan.
 * `cookies` must be a cookie header containing an authenticated JSESSIONID.
 */
export async function getExamPlan(input: {
  cookies: string;
  baseUrl?: string;
}): Promise<{ endpoint: string; total: number; entries: ExamPlanEntry[] }> {
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const endpoint = new URL(EXAM_PLAN_PATH, baseUrl).toString();

  const res = await fetch(endpoint, {
    redirect: "follow",
    headers: { Cookie: input.cookies }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching AlmaEsami exam plan.`);
  }

  const html = await res.text();
  const { entries } = parseExamPlan(html);

  return {
    endpoint: res.url || endpoint,
    total: entries.length,
    entries
  };
}
