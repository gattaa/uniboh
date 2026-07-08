import { load } from "cheerio";

import { SOL_EXPIRED_MESSAGE, SessionExpiredError, isSolAuthExpired } from "./sessions.js";

/**
 * Studenti Online — "SOL" (studenti.unibo.it), the Unibo student-services
 * portal (enrolments/career, fees, exam registrations, certificates, career
 * requests). Like AlmaEsami it is a Java Spring Web Flow servlet app (Dojo
 * front-end, `execution=eNsN` flow tokens) behind Unibo's ADFS SAML SSO;
 * authentication is a bootstrap-style `JSESSIONID` cookie scoped to `/sol`,
 * captured from a logged-in browser (see sol-api-notes.md). There is no JSON
 * API, so we scrape the student pages.
 *
 * READ-ONLY. Everything derivable here comes from the authenticated home page
 * (`/sol/studenti/homeStudentiOnline.htm`): the student's greeting + identity,
 * their enrolled course of study, a summary of in-progress requests, and the
 * catalogue of service tiles. The consequential pages behind those tiles
 * (payments, new enrolment/career requests, degree applications) mutate real
 * academic/financial state and are intentionally NOT automated.
 *
 * NOTE: these parsers were reverse-engineered from a *single* logged-in home
 * capture. Selectors are best-effort and individual fields degrade to "" (or
 * null blocks) rather than throwing, so a partial layout change still yields
 * usable output. Assumptions that could not be cross-checked against a second
 * capture are flagged "unverified" below.
 */

const DEFAULT_BASE_URL = "https://studenti.unibo.it";
const HOME_PATH = "/sol/studenti/homeStudentiOnline.htm";

export type SolProgramme = {
  /** Course-of-study name as shown, e.g. "Medicine and surgery". */
  name: string;
  /** Course-of-study code, e.g. "6734" (from the trailing "(NNNN)"). */
  code: string;
  /** Link to the public course site, as found in the "Corso di studio" box. */
  url: string;
};

export type SolActiveRequests = {
  /** Label of the currently selected tab, e.g. "Richieste in corso". */
  tab: string;
  /** Summary text of the active-requests panel, e.g. "Non hai richieste in corso". */
  summary: string;
  /** False when the panel says there are no in-progress requests. */
  hasRequests: boolean;
  /** "Vedi tutte" link to the full request history (storicoRichieste). */
  detailUrl: string;
};

export type SolCareer = {
  /** Page heading greeting, e.g. "Benvenuto Mario Rossi". */
  greeting: string;
  student: {
    /** Student full name (identity block). */
    name: string;
    /** Short code in the identity block. Unverified: observed as a ~10-char
     * value assumed to be the matricola. */
    matricola: string;
    /** Institutional email address (identity block). */
    email: string;
  };
  /** Enrolled course of study, or null if the "Corso di studio" box is absent. */
  programme: SolProgramme | null;
  /** In-progress requests summary, or null if the panel is absent. */
  activeRequests: SolActiveRequests | null;
};

export type SolService = {
  /** Service name, e.g. "Situazione tasse - Iscrizione". */
  name: string;
  /** Absolute URL the tile links to (relative SOL hrefs are resolved). */
  url: string;
  /** The tile's descriptive sub-link text, e.g. "Visualizza / paga...". */
  description: string;
};

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Throw a uniform expired-session error before scraping, so every reader
 * surfaces the same "re-capture the cookie" guidance and drives auto-relogin. */
function assertAuthenticated(html: string, url: string): void {
  if (isSolAuthExpired(html, url)) {
    throw new SessionExpiredError("sol", SOL_EXPIRED_MESSAGE);
  }
}

/** Resolve a possibly-relative SOL href against the page URL (falling back to
 * the default home URL when parsing a fixture with no URL). Returns the raw
 * href if resolution fails. */
function resolveHref(href: string | undefined, pageUrl: string): string {
  const raw = (href ?? "").trim();
  if (!raw) return "";
  const base = pageUrl || new URL(HOME_PATH, DEFAULT_BASE_URL).toString();
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
}

/** Split a "Name (6734)" course label into its name and trailing numeric code. */
function splitProgrammeLabel(label: string): { name: string; code: string } {
  const text = collapse(label);
  const m = text.match(/^(.*?)\s*\(\s*([^)]+?)\s*\)\s*$/);
  if (!m) {
    return { name: text, code: "" };
  }
  return { name: m[1].trim(), code: m[2].trim() };
}

/**
 * Parse the authenticated SOL home page into the student's career summary.
 * Pure/testable. Individual fields degrade to "" / null; only a wholly
 * unrecognisable (non-SOL) page throws.
 */
export function parseCareer(html: string, url = ""): SolCareer {
  assertAuthenticated(html, url);

  const $ = load(html);

  // Sanity check: a real authenticated SOL home always has at least one of
  // these structural anchors. Their total absence means the layout changed (or
  // this isn't the home page) — fail loudly rather than return empty junk.
  if ($(".corpo, .identity, .titoloPagina").length === 0) {
    throw new Error("Could not recognise the SOL home layout (no .corpo/.identity/.titoloPagina).");
  }

  const greeting = collapse($(".titoloPagina").first().text());

  const identity = $(".identity").first();
  const name = collapse(identity.find(".nome-cell p").first().text());
  const matricola = collapse(identity.find(".nome-cell p.cell").first().text());
  const email = collapse(identity.find(".email a").first().text() || identity.find(".email p").last().text());

  // "Corso di studio" quick-info box (left column). The box holds an <h3> label
  // and a single <a> whose text is "Name (code)".
  let programme: SolProgramme | null = null;
  const progBox = $(".quickInfo .box")
    .filter((_, el) => /corso di studio/i.test($(el).find("h3").text()))
    .first();
  const progLink = (progBox.length ? progBox : $(".quickInfo .box").first()).find("a").first();
  if (progLink.length) {
    const { name: progName, code } = splitProgrammeLabel(progLink.text());
    programme = { name: progName, code, url: resolveHref(progLink.attr("href"), url) };
  }

  // In-progress requests panel: a selected tab + an "elementiAttivi" block whose
  // text is either a "no requests" notice or a list, plus a "Vedi tutte" link.
  let activeRequests: SolActiveRequests | null = null;
  const activePanel = $(".elementiAttivi").first();
  if (activePanel.length) {
    const detailUrl = resolveHref(activePanel.find("a").last().attr("href"), url);
    // Strip the trailing "Vedi tutte »" call-to-action from the summary text.
    const summary = collapse(activePanel.clone().find("a").remove().end().text());
    activeRequests = {
      tab: collapse($(".tab li.selected").first().text()),
      summary,
      // Unverified beyond the "no requests" case: infer emptiness from the
      // Italian "non hai richieste" notice; anything else is treated as active.
      hasRequests: !/non hai richieste/i.test(summary),
      detailUrl
    };
  }

  return { greeting, student: { name, matricola, email }, programme, activeRequests };
}

/**
 * Parse the catalogue of service tiles from the SOL home page. Each tile
 * (`.contenutiCol .box ul li`) has an `<h4><a>` name/link and a `<p><a>`
 * description. Pure/testable.
 */
export function parseServices(html: string, url = ""): { services: SolService[] } {
  assertAuthenticated(html, url);

  const $ = load(html);
  const services: SolService[] = [];

  $(".contenutiCol .box ul li").each((_, li) => {
    const nameLink = $(li).find("h4 a").first();
    const name = collapse(nameLink.text());
    if (!name) return;
    const descLink = $(li).find("p a").first();
    services.push({
      name,
      url: resolveHref(nameLink.attr("href"), url),
      description: collapse(descLink.text())
    });
  });

  return { services };
}

async function fetchHomePage(input: {
  cookies: string;
  baseUrl?: string;
}): Promise<{ url: string; html: string }> {
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const endpoint = new URL(HOME_PATH, baseUrl).toString();

  const res = await fetch(endpoint, {
    redirect: "follow",
    headers: { Cookie: input.cookies }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching ${endpoint}.`);
  }

  return { url: res.url || endpoint, html: await res.text() };
}

/** Fetch and parse the authenticated student's SOL career summary. */
export async function getCareer(input: {
  cookies: string;
  baseUrl?: string;
}): Promise<{ endpoint: string; career: SolCareer }> {
  const { url, html } = await fetchHomePage(input);
  return { endpoint: url, career: parseCareer(html, url) };
}

/** Fetch and parse the catalogue of SOL service links available to the student. */
export async function getServices(input: {
  cookies: string;
  baseUrl?: string;
}): Promise<{ endpoint: string; total: number; services: SolService[] }> {
  const { url, html } = await fetchHomePage(input);
  const { services } = parseServices(html, url);
  return { endpoint: url, total: services.length, services };
}
