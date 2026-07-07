import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { VirtualeClient } from "./virtualeClient.js";
import { loginWithPassword } from "./login.js";
import {
  eventsToIcs,
  listCurricula,
  listEvents,
  listTeachings,
  resolveTimetableUrl
} from "./calendar.js";
import { getExamPlan, getExamHistory, getMessages } from "./almaesami.js";
import { getAttendanceRecords, getRegister } from "./rps.js";
import { getCourseQuizzes, getQuizAttempts, getAttemptReview } from "./quiz.js";

const baseUrl = process.env.VIRTUALE_BASE_URL ?? "https://virtuale.unibo.it";
const sesskey = process.env.VIRTUALE_SESSKEY;
const cookies = process.env.VIRTUALE_COOKIES;

const almaesamiBaseUrl = process.env.ALMAESAMI_BASE_URL ?? "https://almaesami.unibo.it";
const almaesamiCookies = process.env.ALMAESAMI_COOKIES;

const rpsBaseUrl = process.env.RPS_BASE_URL ?? "https://rps.unibo.it";
const rpsCookies = process.env.RPS_COOKIES;

type SessionRecord = {
  id: string;
  email: string;
  sesskey: string;
  cookies: string;
  createdAtIso: string;
  updatedAtIso: string;
  client: VirtualeClient;
};

const sessions = new Map<string, SessionRecord>();

const envClient = sesskey && cookies
  ? new VirtualeClient({
      baseUrl,
      sesskey,
      cookies
    })
  : null;

const publicClient = new VirtualeClient({ baseUrl });

function getClientForSession(sessionId?: string): VirtualeClient {
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error("Unknown session_id. Use virtuale_login_with_password first.");
    }

    session.updatedAtIso = new Date().toISOString();
    return session.client;
  }

  if (envClient) {
    return envClient;
  }

  throw new Error(
    "No authenticated context available. Either set VIRTUALE_SESSKEY + VIRTUALE_COOKIES env vars, or call virtuale_login_with_password and pass session_id."
  );
}

const server = new McpServer({
  name: "unibo-virtuale-mcp",
  version: "0.1.0"
});

server.registerTool(
  "virtuale_login_with_password",
  {
    title: "Login With Password",
    description: "Attempts Moodle form login, then stores cookies and sesskey server-side and returns a session_id.",
    inputSchema: {
      email: z.string().email(),
      password: z.string().min(1),
      login_path: z.string().default("/login/index.php"),
      include_cookie_header: z.boolean().default(false)
    }
  },
  async ({ email, password, login_path, include_cookie_header }) => {
    const login = await loginWithPassword({
      baseUrl,
      email,
      password,
      loginPath: login_path
    });

    const id = randomUUID();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      email,
      sesskey: login.sesskey,
      cookies: login.cookies,
      createdAtIso: now,
      updatedAtIso: now,
      client: new VirtualeClient({
        baseUrl,
        sesskey: login.sesskey,
        cookies: login.cookies
      })
    };

    sessions.set(id, record);

    const out: Record<string, unknown> = {
      session_id: id,
      base_url: baseUrl,
      login_url: login.loginUrl,
      final_url: login.finalUrl,
      created_at: now
    };

    if (include_cookie_header) {
      out.sesskey = login.sesskey;
      out.cookies = login.cookies;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: out
    };
  }
);

server.registerTool(
  "virtuale_bootstrap_session",
  {
    title: "Bootstrap Session",
    description: "Creates a server-side session from an existing sesskey and cookie header.",
    inputSchema: {
      sesskey: z.string().min(1),
      cookies: z.string().min(1),
      email_label: z.string().default("external-session"),
      include_cookie_header: z.boolean().default(false)
    }
  },
  async ({ sesskey: inputSesskey, cookies: inputCookies, email_label, include_cookie_header }) => {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      email: email_label,
      sesskey: inputSesskey,
      cookies: inputCookies,
      createdAtIso: now,
      updatedAtIso: now,
      client: new VirtualeClient({
        baseUrl,
        sesskey: inputSesskey,
        cookies: inputCookies
      })
    };

    sessions.set(id, record);

    const out: Record<string, unknown> = {
      session_id: id,
      sesskey: inputSesskey,
      base_url: baseUrl,
      source: "bootstrap",
      created_at: now,
      label: email_label
    };

    if (include_cookie_header) {
      out.cookies = inputCookies;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: out
    };
  }
);

let virtualeEnvSessionId: string | undefined;

server.registerTool(
  "virtuale_get_env_session",
  {
    title: "Get Env-Backed Session",
    description:
      "Mints (or reuses) a session_id backed by the server's VIRTUALE_SESSKEY + VIRTUALE_COOKIES env vars. The sesskey/cookies are never returned — only an opaque session_id, so credentials configured in the MCP host's environment never pass through the model's context.",
    inputSchema: {}
  },
  async () => {
    if (!envClient || !sesskey || !cookies) {
      throw new Error("VIRTUALE_SESSKEY and VIRTUALE_COOKIES are not both set in the server environment.");
    }

    const existing = virtualeEnvSessionId ? sessions.get(virtualeEnvSessionId) : undefined;
    if (existing) {
      existing.updatedAtIso = new Date().toISOString();
      const out = { session_id: existing.id, base_url: baseUrl, created_at: existing.createdAtIso };
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        structuredContent: out
      };
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    sessions.set(id, {
      id,
      email: "env-session",
      sesskey,
      cookies,
      createdAtIso: now,
      updatedAtIso: now,
      client: envClient
    });
    virtualeEnvSessionId = id;

    const out = { session_id: id, base_url: baseUrl, created_at: now };
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: out
    };
  }
);

server.registerTool(
  "virtuale_get_session_info",
  {
    title: "Get Session Info",
    description: "Shows stored login metadata and optionally returns cookie header string.",
    inputSchema: {
      session_id: z.string().min(1),
      include_cookie_header: z.boolean().default(false)
    }
  },
  async ({ session_id, include_cookie_header }) => {
    const session = sessions.get(session_id);
    if (!session) {
      throw new Error("Unknown session_id.");
    }

    const out: Record<string, unknown> = {
      session_id: session.id,
      email: session.email,
      created_at: session.createdAtIso,
      last_used_at: session.updatedAtIso
    };

    if (include_cookie_header) {
      out.sesskey = session.sesskey;
      out.cookies = session.cookies;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: out
    };
  }
);

server.registerTool(
  "virtuale_logout_session",
  {
    title: "Logout Session",
    description: "Removes one stored authenticated session from server memory.",
    inputSchema: {
      session_id: z.string().min(1)
    }
  },
  async ({ session_id }) => {
    const removed = sessions.delete(session_id);
    const out = { session_id, removed };

    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: out
    };
  }
);

server.registerTool(
  "virtuale_health_check",
  {
    title: "Virtuale Health Check",
    description: "Runs a safe no-login Moodle AJAX call to validate base connectivity.",
    inputSchema: {}
  },
  async () => {
    const data = await publicClient.callNoLogin("core_get_string", {
      stringid: "loading",
      stringparams: [],
      component: "core",
      lang: "en"
    });

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { data }
    };
  }
);

server.registerTool(
  "unibo_calendar_resolve_timetable_url",
  {
    title: "Resolve Timetable URL",
    description: "Resolves the corsi.unibo.it timetable URL from a unibo.it course page URL.",
    inputSchema: {
      unibo_course_url: z.string().url()
    }
  },
  async ({ unibo_course_url }) => {
    const data = await resolveTimetableUrl(unibo_course_url);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

server.registerTool(
  "unibo_calendar_list_curricula",
  {
    title: "List Available Curricula",
    description: "Lists available curricula for a timetable URL.",
    inputSchema: {
      timetable_url: z.string().url()
    }
  },
  async ({ timetable_url }) => {
    const data = await listCurricula(timetable_url);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

server.registerTool(
  "unibo_calendar_list_teachings",
  {
    title: "List Teachings",
    description: "Parses timetable page HTML and returns lecture/teaching IDs for filtering.",
    inputSchema: {
      timetable_url: z.string().url(),
      year: z.string().min(1),
      curriculum: z.string().min(1)
    }
  },
  async ({ timetable_url, year, curriculum }) => {
    const data = await listTeachings(timetable_url, year, curriculum);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

server.registerTool(
  "unibo_calendar_get_events",
  {
    title: "Get Timetable Events",
    description: "Fetches raw timetable events from @@orario_reale_json with optional teaching-code filtering.",
    inputSchema: {
      timetable_url: z.string().url(),
      year: z.string().min(1),
      curriculum: z.string().min(1),
      selected_teaching_codes: z.array(z.string().min(1)).default([])
    }
  },
  async ({ timetable_url, year, curriculum, selected_teaching_codes }) => {
    const data = await listEvents({
      timetableUrl: timetable_url,
      year,
      curriculum,
      selectedTeachingCodes: selected_teaching_codes
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

server.registerTool(
  "unibo_calendar_get_ics",
  {
    title: "Get Timetable ICS",
    description: "Fetches timetable events and returns an ICS calendar string.",
    inputSchema: {
      timetable_url: z.string().url(),
      year: z.string().min(1),
      curriculum: z.string().min(1),
      selected_teaching_codes: z.array(z.string().min(1)).default([]),
      calendar_name: z.string().default("Unibo Timetable")
    }
  },
  async ({ timetable_url, year, curriculum, selected_teaching_codes, calendar_name }) => {
    const eventsData = await listEvents({
      timetableUrl: timetable_url,
      year,
      curriculum,
      selectedTeachingCodes: selected_teaching_codes
    });

    const ics = eventsToIcs(eventsData.events, calendar_name);
    const out = {
      endpoint: eventsData.endpoint,
      total_events: eventsData.totalEvents,
      filtered_events: eventsData.filteredEvents,
      ics
    };

    return {
      content: [{ type: "text", text: ics }],
      structuredContent: out
    };
  }
);

server.registerTool(
  "virtuale_get_enrolled_courses",
  {
    title: "Get Enrolled Courses",
    description: "Calls local_uniboapi_get_enrolled_courses_unibo for the authenticated user.",
    inputSchema: {
      session_id: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(0).default(10),
      classification: z.enum(["all", "inprogress", "future", "past"]).default("all"),
      sort: z.enum(["fullname", "shortname", "startdate"]).default("fullname"),
      customfieldname: z.string().default("aa"),
      customfieldvalue: z.string().default("")
    }
  },
  async ({ session_id, ...args }) => {
    const client = getClientForSession(session_id);
    const result = await client.callService("local_uniboapi_get_enrolled_courses_unibo", args);

    if (result.error) {
      throw new Error(`virtuale_get_enrolled_courses failed: ${result.message ?? "unknown error"}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      structuredContent: { data: result.data }
    };
  }
);

server.registerTool(
  "virtuale_get_course_state",
  {
    title: "Get Course State",
    description: "Calls core_courseformat_get_state and parses the returned JSON string state model.",
    inputSchema: {
      session_id: z.string().optional(),
      courseid: z.number().int().positive()
    }
  },
  async ({ session_id, courseid }) => {
    const client = getClientForSession(session_id);
    const result = await client.callService("core_courseformat_get_state", { courseid });

    if (result.error) {
      throw new Error(`virtuale_get_course_state failed: ${result.message ?? "unknown error"}`);
    }

    const rawData = result.data;
    const parsedState = typeof rawData === "string" ? JSON.parse(rawData) : rawData;

    return {
      content: [{ type: "text", text: JSON.stringify(parsedState, null, 2) }],
      structuredContent: { state: parsedState }
    };
  }
);

server.registerTool(
  "virtuale_get_panopto_content",
  {
    title: "Get Panopto Block Content",
    description: "Calls block_panopto_get_content for a course.",
    inputSchema: {
      session_id: z.string().optional(),
      courseid: z.number().int().positive()
    }
  },
  async ({ session_id, courseid }) => {
    const client = getClientForSession(session_id);
    const result = await client.callService("block_panopto_get_content", { courseid });

    if (result.error) {
      throw new Error(`virtuale_get_panopto_content failed: ${result.message ?? "unknown error"}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      structuredContent: { data: result.data }
    };
  }
);

function resolveVirtualeCookies(sessionId?: string, cookieOverride?: string): string {
  if (cookieOverride) {
    return cookieOverride;
  }
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error("Unknown session_id.");
    }
    return session.cookies;
  }
  if (cookies) {
    return cookies;
  }
  throw new Error(
    "No Virtuale cookie session available. Pass `cookies` (MoodleSession=...), a `session_id` from virtuale_bootstrap_session, or set VIRTUALE_COOKIES."
  );
}

server.registerTool(
  "virtuale_quiz_list_course_quizzes",
  {
    title: "List Course Quizzes",
    description: "Lists quiz activities on a course page, with the course-module id (cmid) needed by the other quiz tools.",
    inputSchema: {
      course_id: z.number().int().positive(),
      session_id: z.string().optional(),
      cookies: z.string().min(1).optional(),
      base_url: z.string().url().optional()
    }
  },
  async ({ course_id, session_id, cookies: cookieOverride, base_url }) => {
    const data = await getCourseQuizzes(course_id, {
      cookies: resolveVirtualeCookies(session_id, cookieOverride),
      baseUrl: base_url ?? baseUrl
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

server.registerTool(
  "virtuale_quiz_list_attempts",
  {
    title: "List Quiz Attempts",
    description:
      "Reads a quiz activity page and returns the student's attempt summaries (status, dates, marks, grade) plus a review URL/attempt id for each finished attempt. Read-only.",
    inputSchema: {
      cmid: z.number().int().positive(),
      session_id: z.string().optional(),
      cookies: z.string().min(1).optional(),
      base_url: z.string().url().optional()
    }
  },
  async ({ cmid, session_id, cookies: cookieOverride, base_url }) => {
    const data = await getQuizAttempts(cmid, {
      cookies: resolveVirtualeCookies(session_id, cookieOverride),
      baseUrl: base_url ?? baseUrl
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

server.registerTool(
  "virtuale_quiz_get_attempt_review",
  {
    title: "Get Quiz Attempt Review",
    description:
      "Reads the review page of one of the student's own finished quiz attempts: each question's text, answer options, the student's selection, correctness, and feedback. Only works for attempts Moodle already allows the student to review (finished, review permitted by the quiz settings) — it does not start, resume, or answer a live attempt.",
    inputSchema: {
      attempt_id: z.number().int().positive(),
      cmid: z.number().int().positive(),
      session_id: z.string().optional(),
      cookies: z.string().min(1).optional(),
      base_url: z.string().url().optional()
    }
  },
  async ({ attempt_id, cmid, session_id, cookies: cookieOverride, base_url }) => {
    const data = await getAttemptReview(attempt_id, cmid, {
      cookies: resolveVirtualeCookies(session_id, cookieOverride),
      baseUrl: base_url ?? baseUrl
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

/**
 * Generic env-backed cookie session store, shared by AlmaEsami and RPS (both
 * are plain cookie-header auth, unlike Virtuale's sesskey+cookie sessions
 * above). One tool per service mints/reuses a session_id from that service's
 * env var; the cookie itself is never echoed back to the caller.
 */
type CookieSessionRecord = {
  id: string;
  service: string;
  cookies: string;
  baseUrl: string;
  createdAtIso: string;
  updatedAtIso: string;
};

const cookieSessions = new Map<string, CookieSessionRecord>();
const envCookieSessionIds = new Map<string, string>();

function getOrCreateEnvCookieSession(service: string, envCookies: string | undefined, baseUrl: string, envVarName: string): CookieSessionRecord {
  if (!envCookies) {
    throw new Error(`${envVarName} is not set in the server environment.`);
  }

  const existing = cookieSessions.get(envCookieSessionIds.get(service) ?? "");
  if (existing) {
    existing.updatedAtIso = new Date().toISOString();
    return existing;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const record: CookieSessionRecord = { id, service, cookies: envCookies, baseUrl, createdAtIso: now, updatedAtIso: now };
  cookieSessions.set(id, record);
  envCookieSessionIds.set(service, id);
  return record;
}

function resolveCookieSession(
  service: string,
  sessionId: string | undefined,
  inputCookies: string | undefined,
  envCookies: string | undefined,
  baseUrlOverride: string | undefined,
  defaultBaseUrl: string,
  envVarName: string
): { cookies: string; baseUrl: string } {
  if (sessionId) {
    const session = cookieSessions.get(sessionId);
    if (!session || session.service !== service) {
      throw new Error(`Unknown ${service} session_id.`);
    }
    session.updatedAtIso = new Date().toISOString();
    return { cookies: session.cookies, baseUrl: session.baseUrl };
  }

  const cookies = inputCookies ?? envCookies;
  if (!cookies) {
    throw new Error(
      `No ${service} session available. Pass \`cookies\`, a \`session_id\` (see ${service}_get_env_session), or set ${envVarName}.`
    );
  }
  return { cookies, baseUrl: baseUrlOverride ?? defaultBaseUrl };
}

function registerEnvCookieSessionTool(opts: {
  toolName: string;
  title: string;
  service: string;
  envCookies: string | undefined;
  baseUrl: string;
  envVarName: string;
}) {
  server.registerTool(
    opts.toolName,
    {
      title: opts.title,
      description: `Mints (or reuses) a session_id backed by the server's ${opts.envVarName} env var. The cookie is never returned — only an opaque session_id.`,
      inputSchema: {}
    },
    async () => {
      const session = getOrCreateEnvCookieSession(opts.service, opts.envCookies, opts.baseUrl, opts.envVarName);
      const out = { session_id: session.id, base_url: session.baseUrl, created_at: session.createdAtIso };
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        structuredContent: out
      };
    }
  );
}

const almaesamiCookiesSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Cookie header with an authenticated JSESSIONID from a logged-in AlmaEsami browser session. Falls back to session_id, then ALMAESAMI_COOKIES."
  );
const almaesamiSessionIdSchema = z.string().min(1).optional().describe("session_id from almaesami_get_env_session.");

function resolveAlmaesamiContext(sessionId?: string, inputCookies?: string, baseUrlOverride?: string): {
  cookies: string;
  baseUrl: string;
} {
  return resolveCookieSession("almaesami", sessionId, inputCookies, almaesamiCookies, baseUrlOverride, almaesamiBaseUrl, "ALMAESAMI_COOKIES");
}

registerEnvCookieSessionTool({
  toolName: "almaesami_get_env_session",
  title: "Get AlmaEsami Env-Backed Session",
  service: "almaesami",
  envCookies: almaesamiCookies,
  baseUrl: almaesamiBaseUrl,
  envVarName: "ALMAESAMI_COOKIES"
});

server.registerTool(
  "almaesami_get_exam_plan",
  {
    title: "Get AlmaEsami Exam Plan",
    description:
      "Reads the authenticated student's AlmaEsami exam plan (Riepilogo Esami): activities, CFU, status, and whether each is bookable. Read-only; does not book exams.",
    inputSchema: {
      session_id: almaesamiSessionIdSchema,
      cookies: almaesamiCookiesSchema,
      base_url: z.string().url().optional()
    }
  },
  async ({ session_id, cookies: inputCookies, base_url }) => {
    const data = await getExamPlan(resolveAlmaesamiContext(session_id, inputCookies, base_url));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

server.registerTool(
  "almaesami_get_exam_history",
  {
    title: "Get AlmaEsami Exam History",
    description:
      "Reads the authenticated student's AlmaEsami exam history (Cronologia): appello date, activity, examiner, type/mode, and status. Read-only.",
    inputSchema: {
      session_id: almaesamiSessionIdSchema,
      cookies: almaesamiCookiesSchema,
      base_url: z.string().url().optional()
    }
  },
  async ({ session_id, cookies: inputCookies, base_url }) => {
    const data = await getExamHistory(resolveAlmaesamiContext(session_id, inputCookies, base_url));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

server.registerTool(
  "almaesami_get_messages",
  {
    title: "Get AlmaEsami Messages",
    description:
      "Reads the authenticated student's AlmaEsami messages (subject, sender, received date, related appello). Read-only; does not delete messages.",
    inputSchema: {
      session_id: almaesamiSessionIdSchema,
      cookies: almaesamiCookiesSchema,
      base_url: z.string().url().optional()
    }
  },
  async ({ session_id, cookies: inputCookies, base_url }) => {
    const data = await getMessages(resolveAlmaesamiContext(session_id, inputCookies, base_url));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

const rpsCookiesSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Cookie header with an authenticated PHPSESSID from a logged-in RPS browser session. Falls back to session_id, then RPS_COOKIES."
  );
const rpsSessionIdSchema = z.string().min(1).optional().describe("session_id from rps_get_env_session.");

function resolveRpsContext(sessionId?: string, inputCookies?: string, baseUrlOverride?: string): {
  cookies: string;
  baseUrl: string;
} {
  return resolveCookieSession("rps", sessionId, inputCookies, rpsCookies, baseUrlOverride, rpsBaseUrl, "RPS_COOKIES");
}

registerEnvCookieSessionTool({
  toolName: "rps_get_env_session",
  title: "Get RPS Env-Backed Session",
  service: "rps",
  envCookies: rpsCookies,
  baseUrl: rpsBaseUrl,
  envVarName: "RPS_COOKIES"
});

server.registerTool(
  "rps_get_attendance_records",
  {
    title: "Get RPS Attendance Records",
    description:
      "Reads the authenticated student's RPS attendance records (Rilevazioni): date, subject, lecturer, and lesson duration for each recorded presence. Read-only.",
    inputSchema: {
      session_id: rpsSessionIdSchema,
      cookies: rpsCookiesSchema,
      base_url: z.string().url().optional()
    }
  },
  async ({ session_id, cookies: inputCookies, base_url }) => {
    const data = await getAttendanceRecords(resolveRpsContext(session_id, inputCookies, base_url));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

server.registerTool(
  "rps_get_register",
  {
    title: "Get RPS Attendance Register",
    description:
      "Reads the authenticated student's RPS attendance register (Registro): per-subject hours attended and attendance percentage. Read-only.",
    inputSchema: {
      session_id: rpsSessionIdSchema,
      cookies: rpsCookiesSchema,
      base_url: z.string().url().optional()
    }
  },
  async ({ session_id, cookies: inputCookies, base_url }) => {
    const data = await getRegister(resolveRpsContext(session_id, inputCookies, base_url));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
