import { load } from "cheerio";

import { fetchWithTimeout } from "./http.js";

export type LanguagePath = "orario-lezioni" | "timetable";

export type CurriculaEntry = {
  label: string;
  value: string;
};

export type TeachingEntry = {
  code: string;
  label: string;
};

export type TimetableEvent = {
  id?: string;
  title: string;
  start: string;
  end: string;
  extCode?: string;
  docente?: string;
  teams?: string;
  location?: string;
  raw: unknown;
};

const TYPE_TO_LANGUAGE: Record<string, LanguagePath> = {
  magistralecu: "orario-lezioni",
  magistrale: "orario-lezioni",
  laurea: "orario-lezioni",
  singlecycle: "timetable",
  "1cycle": "timetable",
  "2cycle": "timetable"
};

function toUrl(input: string): URL {
  try {
    return new URL(input);
  } catch {
    throw new Error("Invalid URL input.");
  }
}

function normalizeCode(code: string): string {
  return code.trim();
}

function inferTypeAndCourse(timetableUrl: string): { type: string; course: string } {
  const url = toUrl(timetableUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Timetable URL path is incomplete. Expected at least /<type>/<course>.");
  }

  const type = parts[0];
  const course = parts[1];
  return { type, course };
}

function getLanguagePath(type: string): LanguagePath {
  const lang = TYPE_TO_LANGUAGE[type];
  if (!lang) {
    throw new Error(`Unsupported course type '${type}'.`);
  }
  return lang;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching ${url}`);
  }
  return res.text();
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetchWithTimeout(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching ${url}`);
  }
  return res.json();
}

export async function resolveTimetableUrl(uniboCourseUrl: string): Promise<{ timetableUrl: string }> {
  const html = await fetchText(uniboCourseUrl);
  const $ = load(html);

  const selectorCandidate = ".social-contact ul li ul li p a";
  const selected = $(selectorCandidate).first();

  let href = selected.attr("href") ?? "";

  if (!href) {
    const fallback = $("a[href*='corsi.unibo.it']").filter((_, el) => {
      const value = $(el).attr("href") ?? "";
      return /\/orario-lezioni|\/timetable/i.test(value) || /corsi\.unibo\.it\//i.test(value);
    }).first();
    href = fallback.attr("href") ?? "";
  }

  if (!href) {
    throw new Error("Could not find timetable URL in the provided Unibo page.");
  }

  const normalized = new URL(href, uniboCourseUrl);
  return { timetableUrl: `${normalized.origin}${normalized.pathname}`.replace(/\/$/, "") };
}

export async function listCurricula(timetableUrl: string): Promise<{
  timetableUrl: string;
  type: string;
  course: string;
  languagePath: LanguagePath;
  endpoint: string;
  curricula: CurriculaEntry[];
}> {
  const { type, course } = inferTypeAndCourse(timetableUrl);
  const languagePath = getLanguagePath(type);
  const endpoint = new URL(`${languagePath}/@@available_curricula`, `${timetableUrl.replace(/\/$/, "")}/`).toString();
  const raw = await fetchJson(endpoint);

  if (!Array.isArray(raw)) {
    throw new Error("Unexpected curricula response shape.");
  }

  const curricula = raw
    .map((item) => {
      const obj = item as Record<string, unknown>;
      const label = typeof obj.label === "string" ? obj.label : "";
      const value = typeof obj.value === "string" ? obj.value : "";
      return { label, value };
    })
    .filter((c) => c.label && c.value);

  return {
    timetableUrl,
    type,
    course,
    languagePath,
    endpoint,
    curricula
  };
}

export async function listTeachings(timetableUrl: string, year: string, curriculum: string): Promise<{
  endpoint: string;
  teachings: TeachingEntry[];
}> {
  const { type } = inferTypeAndCourse(timetableUrl);
  const languagePath = getLanguagePath(type);

  const endpointUrl = new URL(`${languagePath}`, `${timetableUrl.replace(/\/$/, "")}/`);
  endpointUrl.searchParams.set("anno", year);
  endpointUrl.searchParams.set("curricula", curriculum);

  const html = await fetchText(endpointUrl.toString());
  const $ = load(html);

  const teachings: TeachingEntry[] = [];
  $("#insegnamenti-popup ul li").each((_, li) => {
    const input = $(li).find("input").first();
    const label = $(li).find("label").first();

    const code = normalizeCode(input.attr("value") ?? "");
    const labelText = (label.text() ?? "").trim();

    if (code) {
      teachings.push({ code, label: labelText || code });
    }
  });

  return {
    endpoint: endpointUrl.toString(),
    teachings
  };
}

function mapLocation(aules: unknown): string | undefined {
  if (!Array.isArray(aules) || aules.length === 0) {
    return undefined;
  }
  const first = aules[0] as Record<string, unknown>;
  const room = typeof first.des_risorsa === "string" ? first.des_risorsa.trim() : "";
  const address = typeof first.des_indirizzo === "string" ? first.des_indirizzo.trim() : "";

  if (room && address) {
    return `${room}, ${address}`;
  }
  return room || address || undefined;
}

export async function listEvents(input: {
  timetableUrl: string;
  year: string;
  curriculum: string;
  selectedTeachingCodes?: string[];
}): Promise<{
  endpoint: string;
  totalEvents: number;
  filteredEvents: number;
  events: TimetableEvent[];
}> {
  const { type, course } = inferTypeAndCourse(input.timetableUrl);
  const languagePath = getLanguagePath(type);

  const endpoint = new URL(`/${type}/${course}/${languagePath}/@@orario_reale_json`, "https://corsi.unibo.it");
  endpoint.searchParams.set("anno", input.year);
  endpoint.searchParams.set("curricula", input.curriculum);
  endpoint.searchParams.set("calendar_view", "");

  const raw = await fetchJson(endpoint.toString());
  if (!Array.isArray(raw)) {
    throw new Error("Unexpected events response shape.");
  }

  const selected = new Set((input.selectedTeachingCodes ?? []).map((x) => normalizeCode(x)).filter(Boolean));

  const normalizedEvents: TimetableEvent[] = raw.map((item) => {
    const obj = item as Record<string, unknown>;
    return {
      id: typeof obj.id === "string" ? obj.id : undefined,
      title: typeof obj.title === "string" ? obj.title : "Untitled lesson",
      start: typeof obj.start === "string" ? obj.start : "",
      end: typeof obj.end === "string" ? obj.end : "",
      extCode: typeof obj.extCode === "string" ? obj.extCode : undefined,
      docente: typeof obj.docente === "string" ? obj.docente : undefined,
      teams: typeof obj.teams === "string" ? obj.teams : undefined,
      location: mapLocation(obj.aule),
      raw: item
    };
  });

  const filtered = selected.size === 0
    ? normalizedEvents
    : normalizedEvents.filter((event) => {
        const extCode = event.extCode ?? "";
        if (!extCode) {
          return false;
        }
        const left = extCode.split("|")[0] ?? "";
        return selected.has(extCode) || selected.has(left);
      });

  return {
    endpoint: endpoint.toString(),
    totalEvents: normalizedEvents.length,
    filteredEvents: filtered.length,
    events: filtered
  };
}

function toIcsDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

export function eventsToIcs(events: TimetableEvent[], calendarName = "Unibo Timetable"): string {
  const dtStamp = toIcsDate(new Date().toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//uniboh//calendar//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcs(calendarName)}`
  ];

  for (const event of events) {
    const dtStart = toIcsDate(event.start);
    const dtEnd = toIcsDate(event.end);
    if (!dtStart || !dtEnd) {
      continue;
    }

    const uidSeed = `${event.extCode ?? event.title}-${event.start}`;
    const uid = `${uidSeed.replace(/[^a-zA-Z0-9]/g, "") || "event"}@uniboh`;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtStamp}`);
    lines.push(`DTSTART:${dtStart}`);
    lines.push(`DTEND:${dtEnd}`);
    lines.push(`SUMMARY:${escapeIcs(event.title)}`);

    if (event.location) {
      lines.push(`LOCATION:${escapeIcs(event.location)}`);
    }
    if (event.docente) {
      lines.push(`DESCRIPTION:${escapeIcs(`Docente: ${event.docente}`)}`);
    }
    if (event.teams) {
      lines.push(`URL:${escapeIcs(event.teams)}`);
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
