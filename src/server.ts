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

const baseUrl = process.env.VIRTUALE_BASE_URL ?? "https://virtuale.unibo.it";
const sesskey = process.env.VIRTUALE_SESSKEY;
const cookies = process.env.VIRTUALE_COOKIES;

const almaesamiBaseUrl = process.env.ALMAESAMI_BASE_URL ?? "https://almaesami.unibo.it";
const almaesamiCookies = process.env.ALMAESAMI_COOKIES;

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
      sesskey: login.sesskey,
      base_url: baseUrl,
      login_url: login.loginUrl,
      final_url: login.finalUrl,
      created_at: now
    };

    if (include_cookie_header) {
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
      sesskey: session.sesskey,
      created_at: session.createdAtIso,
      last_used_at: session.updatedAtIso
    };

    if (include_cookie_header) {
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

const almaesamiCookiesSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Cookie header with an authenticated JSESSIONID from a logged-in AlmaEsami browser session. Falls back to ALMAESAMI_COOKIES."
  );

function resolveAlmaesamiContext(inputCookies?: string, baseUrlOverride?: string): {
  cookies: string;
  baseUrl: string;
} {
  const cookies = inputCookies ?? almaesamiCookies;
  if (!cookies) {
    throw new Error(
      "No AlmaEsami session available. Pass `cookies` (JSESSIONID=...) or set ALMAESAMI_COOKIES."
    );
  }
  return { cookies, baseUrl: baseUrlOverride ?? almaesamiBaseUrl };
}

server.registerTool(
  "almaesami_get_exam_plan",
  {
    title: "Get AlmaEsami Exam Plan",
    description:
      "Reads the authenticated student's AlmaEsami exam plan (Riepilogo Esami): activities, CFU, status, and whether each is bookable. Read-only; does not book exams.",
    inputSchema: {
      cookies: almaesamiCookiesSchema,
      base_url: z.string().url().optional()
    }
  },
  async ({ cookies: inputCookies, base_url }) => {
    const data = await getExamPlan(resolveAlmaesamiContext(inputCookies, base_url));
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
      cookies: almaesamiCookiesSchema,
      base_url: z.string().url().optional()
    }
  },
  async ({ cookies: inputCookies, base_url }) => {
    const data = await getExamHistory(resolveAlmaesamiContext(inputCookies, base_url));
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
      cookies: almaesamiCookiesSchema,
      base_url: z.string().url().optional()
    }
  },
  async ({ cookies: inputCookies, base_url }) => {
    const data = await getMessages(resolveAlmaesamiContext(inputCookies, base_url));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
