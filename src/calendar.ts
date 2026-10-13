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

async function fetchOk(url: string): Promise<Response> {
  // corsi.unibo.it 5xxes a fair share of requests at random (Oct 2026), so retry those.
  for (let attempt = 1; ; attempt++) {
    const res = await fetchWithTimeout(url, { redirect: "follow" });
    if (res.ok) {
      return res;
    }
    if (res.status < 500 || attempt >= 5) {
      throw new Error(`HTTP ${res.status} while fetching ${url}`);
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
}

const fetchText = async (url: string) => (await fetchOk(url)).text();
const fetchJson = async (url: string): Promise<unknown> => (await fetchOk(url)).json();

/**
 * The academic year around `now` (Sep 1 → Aug 31) as calendar months. Since Oct 2026
 * @@orario_reale_json 503s without start/end, and on any range past ~45 days.
 */
export function academicMonths(now: Date = new Date()): { start: string; end: string }[] {
  const [y, m] = now.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" }).split("-").map(Number) as [number, number];
  const firstYear = m >= 9 ? y : y - 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return Array.from({ length: 12 }, (_, i) => ({
    start: iso(new Date(Date.UTC(firstYear, 8 + i, 1))),
    end: iso(new Date(Date.UTC(firstYear, 9 + i, 0)))
  }));
}

/** `https://corsi.unibo.it/<type>/<course>` for a link into corsi.unibo.it with a known degree type, else undefined. */
export function toTimetableUrl(href: string, base?: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return undefined;
  }
  const [type, course] = url.pathname.split("/").filter(Boolean);
  if (url.hostname !== "corsi.unibo.it" || !type || !course || !(type in TYPE_TO_LANGUAGE)) {
    return undefined;
  }
  return `${url.origin}/${type}/${course}`;
}

/** Splits an inclusive YYYY-MM-DD range into chunks of at most `maxDays` days (upstream caps the range). */
export function chunkRange(start: string, end: string, maxDays = 31): { start: string; end: string }[] {
  const day = 86_400_000;
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) {
    throw new Error("Invalid date range: expected start <= end as YYYY-MM-DD.");
  }
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out: { start: string; end: string }[] = [];
  for (let t = from; t <= to; t += maxDays * day) {
    out.push({ start: iso(t), end: iso(Math.min(t + (maxDays - 1) * day, to)) });
  }
  return out;
}

export async function resolveTimetableUrl(uniboCourseUrl: string): Promise<{ timetableUrl: string }> {
  // Already a corsi.unibo.it link: its own type/course is authoritative (the page also links the
  // other-language sibling, e.g. /magistralecu/<EnglishSlug>, which 404s).
  const direct = toTimetableUrl(uniboCourseUrl);
  const html = direct ? "" : await fetchText(uniboCourseUrl);
  const $ = load(html);

  const hrefs = [
    $(".social-contact ul li ul li p a").first().attr("href") ?? "",
    ...$("a[href*='corsi.unibo.it']").map((_, el) => $(el).attr("href") ?? "").get()
  ];
  const candidates = [...new Set([direct, ...hrefs.map((h) => toTimetableUrl(h, uniboCourseUrl))].filter((u): u is string => !!u))];

  if (candidates.length === 0) {
    throw new Error("Could not find timetable URL in the provided Unibo page.");
  }

  // Return the first candidate whose curricula endpoint actually answers.
  let lastError: unknown;
  for (const timetableUrl of candidates) {
    try {
      await listCurricula(timetableUrl);
      return { timetableUrl };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working timetable URL among ${candidates.join(", ")}: ${(lastError as Error).message}`);
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
  /** Inclusive YYYY-MM-DD range; defaults to the current academic year (Sep–Aug). */
  start?: string;
  end?: string;
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

  // Sequential, chunked requests: upstream caps the range.
  const ranges = input.start || input.end
    ? chunkRange(input.start ?? input.end!, input.end ?? input.start!)
    : academicMonths();
  const raw: unknown[] = [];
  for (const range of ranges) {
    const url = new URL(endpoint);
    url.searchParams.set("start", range.start);
    url.searchParams.set("end", range.end);
    const month = await fetchJson(url.toString());
    if (!Array.isArray(month)) {
      throw new Error("Unexpected events response shape.");
    }
    raw.push(...month);
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
