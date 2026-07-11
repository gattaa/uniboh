#!/usr/bin/env node
import { z } from "zod";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

import { VirtualeClient, type ServiceCallResult } from "./virtualeClient.js";
import { loginWithPassword } from "./login.js";
import { loginWithBrowser } from "./browserAuth.js";
import {
  eventsToIcs,
  listCurricula,
  listEvents,
  listTeachings,
  resolveTimetableUrl
} from "./calendar.js";
import { getExamPlan, getExamHistory, getMessages, getAppelli } from "./almaesami.js";
import { getAttendanceRecords, getRegister } from "./rps.js";
import { getCourseQuizzes, getQuizAttempts, getAttemptReview } from "./quiz.js";
import { syncQuizBank } from "./quizBank.js";
import { buildFileListing, getResource } from "./virtualeFiles.js";
import { getCareer as getSolCareer, getServices as getSolServices } from "./sol.js";
import {
  SessionExpiredError,
  SessionStore,
  VIRTUALE_EXPIRED_MESSAGE,
  isMoodleAuthError,
  type ServiceRefresh,
  type SessionRecord
} from "./sessions.js";

const baseUrl = process.env.VIRTUALE_BASE_URL ?? "https://virtuale.unibo.it";
const sesskey = process.env.VIRTUALE_SESSKEY;
const cookies = process.env.VIRTUALE_COOKIES;
// Shared across all Unibo services (Virtuale, AlmaEsami, RPS all federate to the
// same idp.unibo.it ADFS SSO), so this is a generic credential, not Virtuale-specific.
const ssoEmail = process.env.EMAIL;
const ssoPassword = process.env.PASSWORD;

const almaesamiBaseUrl = process.env.ALMAESAMI_BASE_URL ?? "https://almaesami.unibo.it";
const almaesamiCookies = process.env.ALMAESAMI_COOKIES;

const rpsBaseUrl = process.env.RPS_BASE_URL ?? "https://rps.unibo.it";
const rpsCookies = process.env.RPS_COOKIES;

const solBaseUrl = process.env.SOL_BASE_URL ?? "https://studenti.unibo.it";
const solCookies = process.env.SOL_COOKIES;

// Single unified in-memory session store: one record can carry credentials for
// Virtuale, AlmaEsami, RPS and Studenti Online at once (they share the
// idp.unibo.it SSO).
const store = new SessionStore({
  virtualeBaseUrl: baseUrl,
  virtualeSesskey: sesskey,
  virtualeCookies: cookies,
  almaesamiBaseUrl,
  almaesamiCookies,
  rpsBaseUrl,
  rpsCookies,
  solBaseUrl,
  solCookies
});

const publicClient = new VirtualeClient({ baseUrl });

// URLs the headless browser login visits to complete each service's SAML
// handshake off the shared idp.unibo.it session.
const browserAlmaesamiUrl = new URL("/almaesami/studenti/home.htm", almaesamiBaseUrl).toString();
const browserRpsUrl = new URL("/", rpsBaseUrl).toString();
const browserSolUrl = new URL("/sol/studenti/homeStudentiOnline.htm", solBaseUrl).toString();

function textResult(out: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
    structuredContent: out
  };
}

// --- Auto re-login ----------------------------------------------------------

const canRelogin = (): boolean => Boolean(ssoEmail && ssoPassword);

// A single in-flight re-login promise shared by concurrent callers, so an
// expiry storm triggers at most one headless browser login at a time.
let reloginPromise: Promise<void> | null = null;

async function performRelogin(): Promise<void> {
  const result = await loginWithBrowser({
    baseUrl,
    email: ssoEmail!,
    password: ssoPassword!,
    almaesamiUrl: browserAlmaesamiUrl,
    rpsUrl: browserRpsUrl,
    solUrl: browserSolUrl
  });
  const refresh: ServiceRefresh = {};
  if (result.virtuale.ok) refresh.virtuale = { sesskey: result.virtuale.sesskey, cookies: result.virtuale.cookies };
  if (result.almaesami.ok) refresh.almaesami = { cookies: result.almaesami.cookies };
  if (result.rps.ok) refresh.rps = { cookies: result.rps.cookies };
  if (result.sol.ok) refresh.sol = { cookies: result.sol.cookies };
  store.applyRefresh(refresh);
}

async function reloginOnce(): Promise<void> {
  if (!reloginPromise) {
    reloginPromise = performRelogin().finally(() => {
      reloginPromise = null;
    });
  }
  return reloginPromise;
}

/**
 * Run `work` against freshly resolved credentials. If it fails with a
 * {@link SessionExpiredError} and the credentials are refreshable (env- or
 * browser-login-backed) and EMAIL+PASSWORD are configured, transparently
 * re-run the browser login once, update the stored session, and retry once.
 * User-pasted (bootstrap/password) sessions and inline cookie overrides are
 * never auto-refreshed — their cookies aren't ours to renew.
 */
async function withAutoRelogin<Ctx, T>(
  resolve: () => { context: Ctx; refreshable: boolean },
  work: (ctx: Ctx) => Promise<T>
): Promise<T> {
  const first = resolve();
  try {
    return await work(first.context);
  } catch (err) {
    if (!(err instanceof SessionExpiredError) || !first.refreshable || !canRelogin()) {
      throw err;
    }
    await reloginOnce();
    // Re-resolve so we pick up the refreshed credentials from the store.
    const second = resolve();
    return work(second.context);
  }
}

async function callVirtualeService(
  sessionId: string | undefined,
  label: string,
  methodname: string,
  args: Record<string, unknown>
): Promise<ServiceCallResult> {
  return withAutoRelogin(
    () => {
      const ctx = store.resolveVirtualeAjax(sessionId);
      return { context: ctx, refreshable: ctx.refreshable };
    },
    async (ctx) => {
      const client = new VirtualeClient({ baseUrl: ctx.baseUrl, sesskey: ctx.sesskey, cookies: ctx.cookies });
      const result = await client.callService(methodname, args);
      if (result.error) {
        if (isMoodleAuthError(result)) {
          throw new SessionExpiredError("virtuale", VIRTUALE_EXPIRED_MESSAGE);
        }
        throw new Error(`${label} failed: ${result.message ?? "unknown error"}`);
      }
      return result;
    }
  );
}

async function runVirtualeQuiz<T>(
  sessionId: string | undefined,
  cookieOverride: string | undefined,
  baseUrlOverride: string | undefined,
  work: (ctx: { cookies: string; baseUrl: string }) => Promise<T>
): Promise<T> {
  return withAutoRelogin(
    () => {
      const ctx = store.resolveVirtualeCookies(sessionId, cookieOverride);
      return { context: { cookies: ctx.cookies, baseUrl: baseUrlOverride ?? ctx.baseUrl }, refreshable: ctx.refreshable };
    },
    work
  );
}

async function runCookieService<T>(
  service: "almaesami" | "rps" | "sol",
  sessionId: string | undefined,
  cookieOverride: string | undefined,
  baseUrlOverride: string | undefined,
  work: (ctx: { cookies: string; baseUrl: string }) => Promise<T>
): Promise<T> {
  return withAutoRelogin(
    () => {
      const ctx = store.resolveCookieService(service, sessionId, cookieOverride);
      return { context: { cookies: ctx.cookies, baseUrl: baseUrlOverride ?? ctx.baseUrl }, refreshable: ctx.refreshable };
    },
    work
  );
}

const server = new McpServer({
  name: "uniboh",
  version: packageVersion
});

// Read-only tools that reach an external Unibo service. `readOnlyHint` lets a
// client skip a confirmation prompt; `openWorldHint` marks that they call out
// to a remote whose responses aren't fully predictable.
const READONLY = { readOnlyHint: true, openWorldHint: true } as const;

// --- Session management ------------------------------------------------------

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

    const record = store.mint({
      label: email,
      origin: "password",
      virtuale: { sesskey: login.sesskey, cookies: login.cookies }
    });

    const out: Record<string, unknown> = {
      session_id: record.id,
      base_url: baseUrl,
      login_url: login.loginUrl,
      final_url: login.finalUrl,
      created_at: record.createdAtIso
    };

    if (include_cookie_header) {
      out.sesskey = login.sesskey;
      out.cookies = login.cookies;
    }

    return textResult(out);
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
    const record = store.mint({
      label: email_label,
      origin: "bootstrap",
      virtuale: { sesskey: inputSesskey, cookies: inputCookies }
    });

    const out: Record<string, unknown> = {
      session_id: record.id,
      sesskey: inputSesskey,
      base_url: baseUrl,
      source: "bootstrap",
      created_at: record.createdAtIso,
      label: email_label
    };

    if (include_cookie_header) {
      out.cookies = inputCookies;
    }

    return textResult(out);
  }
);

server.registerTool(
  "virtuale_get_env_session",
  {
    title: "Get Env-Backed Session",
    description:
      "Mints (or reuses) a session_id backed by the server's VIRTUALE_SESSKEY + VIRTUALE_COOKIES env vars. The sesskey/cookies are never returned — only an opaque session_id, so credentials configured in the MCP host's environment never pass through the model's context.",
    inputSchema: {}
  },
  async () => {
    const record = store.getOrCreateEnvVirtualeSession();
    return textResult({ session_id: record.id, base_url: baseUrl, created_at: record.createdAtIso });
  }
);

let browserSessionId: string | undefined;

function capturedServices(record: SessionRecord): {
  virtuale: boolean;
  almaesami: boolean;
  rps: boolean;
  sol: boolean;
} {
  return {
    virtuale: Boolean(record.virtuale),
    almaesami: Boolean(record.almaesami),
    rps: Boolean(record.rps),
    sol: Boolean(record.sol)
  };
}

async function handleBrowserLogin({ force_relogin }: { force_relogin: boolean }) {
  if (!ssoEmail || !ssoPassword) {
    throw new Error("EMAIL and PASSWORD are not both set in the server environment.");
  }

  const existing = !force_relogin && browserSessionId ? store.get(browserSessionId) : undefined;
  if (existing) {
    return textResult({
      session_id: existing.id,
      base_url: baseUrl,
      created_at: existing.createdAtIso,
      reused: true,
      services: capturedServices(existing)
    });
  }

  const result = await loginWithBrowser({
    baseUrl,
    email: ssoEmail,
    password: ssoPassword,
    almaesamiUrl: browserAlmaesamiUrl,
    rpsUrl: browserRpsUrl,
    solUrl: browserSolUrl
  });

  const virtuale = result.virtuale.ok
    ? { sesskey: result.virtuale.sesskey, cookies: result.virtuale.cookies }
    : undefined;
  const almaesami = result.almaesami.ok ? { cookies: result.almaesami.cookies } : undefined;
  const rps = result.rps.ok ? { cookies: result.rps.cookies } : undefined;
  const sol = result.sol.ok ? { cookies: result.sol.cookies } : undefined;

  const errors: Record<string, string> = {};
  if (!result.virtuale.ok) errors.virtuale = result.virtuale.error;
  if (!result.almaesami.ok) errors.almaesami = result.almaesami.error;
  if (!result.rps.ok) errors.rps = result.rps.error;
  if (!result.sol.ok) errors.sol = result.sol.error;

  if (!virtuale && !almaesami && !rps && !sol) {
    throw new Error(
      `Browser login captured no services. virtuale: ${errors.virtuale}; almaesami: ${errors.almaesami}; rps: ${errors.rps}; sol: ${errors.sol}`
    );
  }

  // Drop any previous browser session so orphaned records don't accumulate.
  if (browserSessionId) store.delete(browserSessionId);

  const record = store.mint({ label: ssoEmail, origin: "browser", virtuale, almaesami, rps, sol });
  browserSessionId = record.id;

  return textResult({
    session_id: record.id,
    base_url: baseUrl,
    created_at: record.createdAtIso,
    reused: false,
    services: capturedServices(record),
    ...(Object.keys(errors).length ? { errors } : {})
  });
}

server.registerTool(
  "unibo_browser_login",
  {
    title: "Log In Via Headless Browser (all services)",
    description:
      "Drives a real (headless) Chromium browser through the ADFS SSO login using EMAIL + PASSWORD from the server environment, then — reusing the same shared idp.unibo.it session — completes the AlmaEsami and RPS SAML handshakes too, storing one session and returning an opaque session_id that works with the virtuale_*, almaesami_*, and rps_* tools. The password/sesskey/cookies never pass through the model's context. Each service is best-effort: the result reports per-service success. Only works for accounts without interactive MFA (use the *_bootstrap_session tools for MFA accounts). Mints once and reuses the session on later calls unless force_relogin is set.",
    inputSchema: {
      force_relogin: z.boolean().default(false)
    }
  },
  handleBrowserLogin
);

// Deprecated alias kept for backward compatibility; same handler as
// unibo_browser_login (which now covers all three services).
server.registerTool(
  "virtuale_browser_login",
  {
    title: "Log In Via Headless Browser (deprecated alias)",
    description:
      "Deprecated alias for unibo_browser_login. Drives a headless Chromium through ADFS SSO with EMAIL/PASSWORD and returns an opaque session_id (now covering AlmaEsami and RPS too). Prefer unibo_browser_login.",
    inputSchema: {
      force_relogin: z.boolean().default(false)
    }
  },
  handleBrowserLogin
);

server.registerTool(
  "virtuale_get_session_info",
  {
    annotations: READONLY,
    title: "Get Session Info",
    description: "Shows stored login metadata and optionally returns cookie header string.",
    inputSchema: {
      session_id: z.string().min(1),
      include_cookie_header: z.boolean().default(false)
    }
  },
  async ({ session_id, include_cookie_header }) => {
    const record = store.get(session_id);
    if (!record) {
      throw new Error("Unknown session_id.");
    }

    const out: Record<string, unknown> = {
      session_id: record.id,
      email: record.label,
      origin: record.origin,
      services: capturedServices(record),
      created_at: record.createdAtIso,
      last_used_at: record.updatedAtIso
    };

    if (include_cookie_header) {
      out.sesskey = record.virtuale?.sesskey;
      out.cookies = {
        virtuale: record.virtuale?.cookies,
        almaesami: record.almaesami?.cookies,
        rps: record.rps?.cookies,
        sol: record.sol?.cookies
      };
    }

    return textResult(out);
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
    const removed = store.delete(session_id);
    if (browserSessionId === session_id) browserSessionId = undefined;
    return textResult({ session_id, removed });
  }
);

server.registerTool(
  "virtuale_health_check",
  {
    annotations: READONLY,
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
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      structuredContent: { data }
    };
  }
);

// --- Timetable / calendar (public) ------------------------------------------

server.registerTool(
  "unibo_calendar_resolve_timetable_url",
  {
    annotations: READONLY,
    title: "Resolve Timetable URL",
    description: "Resolves the corsi.unibo.it timetable URL from a unibo.it course page URL.",
    inputSchema: {
      unibo_course_url: z.string().url()
    }
  },
  async ({ unibo_course_url }) => {
    const data = await resolveTimetableUrl(unibo_course_url);
    return textResult(data as Record<string, unknown>);
  }
);

server.registerTool(
  "unibo_calendar_list_curricula",
  {
    annotations: READONLY,
    title: "List Available Curricula",
    description: "Lists available curricula for a timetable URL.",
    inputSchema: {
      timetable_url: z.string().url()
    }
  },
  async ({ timetable_url }) => {
    const data = await listCurricula(timetable_url);
    return textResult(data as Record<string, unknown>);
  }
);

server.registerTool(
  "unibo_calendar_list_teachings",
  {
    annotations: READONLY,
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
    return textResult(data as Record<string, unknown>);
  }
);

server.registerTool(
  "unibo_calendar_get_events",
  {
    annotations: READONLY,
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
    return textResult(data as unknown as Record<string, unknown>);
  }
);

server.registerTool(
  "unibo_calendar_get_ics",
  {
    annotations: READONLY,
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
      content: [{ type: "text" as const, text: ics }],
      structuredContent: out
    };
  }
);

// --- Virtuale (authenticated AJAX) ------------------------------------------

server.registerTool(
  "virtuale_get_enrolled_courses",
  {
    annotations: READONLY,
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
    const result = await callVirtualeService(
      session_id,
      "virtuale_get_enrolled_courses",
      "local_uniboapi_get_enrolled_courses_unibo",
      args
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
      structuredContent: { data: result.data }
    };
  }
);

server.registerTool(
  "virtuale_get_course_state",
  {
    annotations: READONLY,
    title: "Get Course State",
    description: "Calls core_courseformat_get_state and parses the returned JSON string state model.",
    inputSchema: {
      session_id: z.string().optional(),
      courseid: z.number().int().positive()
    }
  },
  async ({ session_id, courseid }) => {
    const result = await callVirtualeService(
      session_id,
      "virtuale_get_course_state",
      "core_courseformat_get_state",
      { courseid }
    );

    const rawData = result.data;
    const parsedState = typeof rawData === "string" ? JSON.parse(rawData) : rawData;

    return {
      content: [{ type: "text" as const, text: JSON.stringify(parsedState, null, 2) }],
      structuredContent: { state: parsedState }
    };
  }
);

server.registerTool(
  "virtuale_list_course_files",
  {
    annotations: READONLY,
    title: "List Course Files",
    description:
      "Lists the downloadable files/resources of a Virtuale course, grouped by section (cmid, name, modname, url), derived from core_courseformat_get_state. A slim, token-friendly view of the course contents (not the full state blob); pass a cmid to virtuale_get_resource to fetch a file's content. Read-only.",
    inputSchema: {
      session_id: z.string().optional(),
      courseid: z.number().int().positive()
    }
  },
  async ({ session_id, courseid }) => {
    const result = await callVirtualeService(
      session_id,
      "virtuale_list_course_files",
      "core_courseformat_get_state",
      { courseid }
    );

    const rawData = result.data;
    const parsedState = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
    const listing = buildFileListing(parsedState);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(listing, null, 2) }],
      structuredContent: listing as unknown as Record<string, unknown>
    };
  }
);

server.registerTool(
  "virtuale_get_panopto_content",
  {
    annotations: READONLY,
    title: "Get Panopto Block Content",
    description: "Calls block_panopto_get_content for a course.",
    inputSchema: {
      session_id: z.string().optional(),
      courseid: z.number().int().positive()
    }
  },
  async ({ session_id, courseid }) => {
    const result = await callVirtualeService(
      session_id,
      "virtuale_get_panopto_content",
      "block_panopto_get_content",
      { courseid }
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
      structuredContent: { data: result.data }
    };
  }
);

// --- Virtuale quizzes (authenticated, HTML scrape) --------------------------

server.registerTool(
  "virtuale_quiz_list_course_quizzes",
  {
    annotations: READONLY,
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
    const data = await runVirtualeQuiz(session_id, cookieOverride, base_url, (ctx) =>
      getCourseQuizzes(course_id, ctx)
    );
    return textResult(data as unknown as Record<string, unknown>);
  }
);

server.registerTool(
  "virtuale_quiz_list_attempts",
  {
    annotations: READONLY,
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
    const data = await runVirtualeQuiz(session_id, cookieOverride, base_url, (ctx) => getQuizAttempts(cmid, ctx));
    return textResult(data as unknown as Record<string, unknown>);
  }
);

server.registerTool(
  "virtuale_quiz_get_attempt_review",
  {
    annotations: READONLY,
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
    const data = await runVirtualeQuiz(session_id, cookieOverride, base_url, (ctx) =>
      getAttemptReview(attempt_id, cmid, ctx)
    );
    return textResult(data as unknown as Record<string, unknown>);
  }
);

server.registerTool(
  "virtuale_quiz_sync_bank",
  {
    annotations: READONLY,
    title: "Sync Quiz Bank File",
    description:
      "Diffs a local quiz-bank JSON against Moodle attempts, fetches only new attempt reviews, appends them to the file in the bank schema, and returns a count summary. Writes to disk; returns no question content.",
    inputSchema: {
      bank_path: z.string().min(1),
      session_id: z.string().optional(),
      cookies: z.string().min(1).optional(),
      base_url: z.string().url().optional(),
      cmids: z.array(z.number().int().positive()).optional(),
      dry_run: z.boolean().default(false)
    }
  },
  async ({ bank_path, session_id, cookies: cookieOverride, base_url, cmids, dry_run }) => {
    const data = await runVirtualeQuiz(session_id, cookieOverride, base_url, (ctx) =>
      syncQuizBank(bank_path, { cookies: ctx.cookies, baseUrl: ctx.baseUrl, cmids, dryRun: dry_run })
    );
    return textResult(data as unknown as Record<string, unknown>);
  }
);

server.registerTool(
  "virtuale_get_resource",
  {
    annotations: READONLY,
    title: "Get Course Resource / File",
    description:
      "Fetches a Virtuale file/resource by cmid (builds /mod/resource/view.php?id=<cmid>) or an explicit url, following the redirect to the protected pluginfile.php content with the authenticated MoodleSession cookie. Always returns metadata (final URL, content-type, size, filename). If save_to (an absolute file path) is given, streams the file to disk and returns the path + byte size. Otherwise returns text inline for text-like files (text/JSON/XML/HTML) and extracts + returns the text of PDFs; very long text is truncated (pass save_to for the full file). Read-only.",
    inputSchema: {
      cmid: z.number().int().positive().optional(),
      url: z.string().optional(),
      save_to: z.string().min(1).optional(),
      session_id: z.string().optional(),
      cookies: z.string().min(1).optional(),
      base_url: z.string().url().optional()
    }
  },
  async ({ cmid, url, save_to, session_id, cookies: cookieOverride, base_url }) => {
    if (cmid == null && !url) {
      throw new Error("Provide either cmid or url.");
    }
    const data = await runVirtualeQuiz(session_id, cookieOverride, base_url, (ctx) =>
      getResource({ cmid, url, saveTo: save_to }, ctx)
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      structuredContent: data as unknown as Record<string, unknown>
    };
  }
);

// --- AlmaEsami / RPS shared session tools -----------------------------------

/** Registers a `<service>_get_env_session` tool backed by the store. */
function registerEnvCookieSessionTool(opts: {
  toolName: string;
  title: string;
  service: "almaesami" | "rps" | "sol";
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
      const record = store.getOrCreateEnvCookieSession(opts.service);
      return textResult({
        session_id: record.id,
        base_url: store.baseUrlFor(opts.service),
        created_at: record.createdAtIso
      });
    }
  );
}

/** Registers a `<service>_bootstrap_session` tool: paste a cookie header, get
 * an opaque session_id; the cookie is never echoed back. */
function registerCookieBootstrapTool(opts: {
  toolName: string;
  title: string;
  service: "almaesami" | "rps" | "sol";
  cookieDescription: string;
  defaultLabel: string;
}) {
  server.registerTool(
    opts.toolName,
    {
      title: opts.title,
      description: `Creates a server-side session from an existing ${opts.service} cookie header (${opts.cookieDescription}). Returns an opaque session_id; the cookie is never echoed back.`,
      inputSchema: {
        cookies: z.string().min(1).describe(opts.cookieDescription),
        label: z.string().default(opts.defaultLabel)
      }
    },
    async ({ cookies: inputCookies, label }) => {
      const record = store.mint({
        label,
        origin: "bootstrap",
        [opts.service]: { cookies: inputCookies }
      });
      return textResult({
        session_id: record.id,
        service: opts.service,
        base_url: store.baseUrlFor(opts.service),
        source: "bootstrap",
        created_at: record.createdAtIso,
        label
      });
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
const almaesamiSessionIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe("session_id from almaesami_get_env_session, almaesami_bootstrap_session, or unibo_browser_login.");

registerCookieBootstrapTool({
  toolName: "almaesami_bootstrap_session",
  title: "Bootstrap AlmaEsami Session",
  service: "almaesami",
  cookieDescription: "JSESSIONID cookie header for almaesami.unibo.it",
  defaultLabel: "almaesami-bootstrap"
});

registerEnvCookieSessionTool({
  toolName: "almaesami_get_env_session",
  title: "Get AlmaEsami Env-Backed Session",
  service: "almaesami",
  envVarName: "ALMAESAMI_COOKIES"
});

server.registerTool(
  "almaesami_get_exam_plan",
  {
    annotations: READONLY,
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
    const data = await runCookieService("almaesami", session_id, inputCookies, base_url, (ctx) => getExamPlan(ctx));
    return textResult(data as unknown as Record<string, unknown>);
  }
);

server.registerTool(
  "almaesami_get_exam_history",
  {
    annotations: READONLY,
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
    const data = await runCookieService("almaesami", session_id, inputCookies, base_url, (ctx) => getExamHistory(ctx));
    return textResult(data as unknown as Record<string, unknown>);
  }
);

server.registerTool(
  "almaesami_get_messages",
  {
    annotations: READONLY,
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
    const data = await runCookieService("almaesami", session_id, inputCookies, base_url, (ctx) => getMessages(ctx));
    return textResult(data as unknown as Record<string, unknown>);
  }
);

server.registerTool(
  "almaesami_list_appelli",
  {
    annotations: READONLY,
    title: "List AlmaEsami Appelli (Exam Sessions)",
    description:
      "Lists the student's upcoming AlmaEsami appelli (bookable exam sessions): date/time, activity, examiner, type/mode, and enrollment window — to answer \"when can I sit exam X\". Read-only: it never books. NOTE: the underlying endpoint/grid is UNVERIFIED (it lives behind SSO and could not be confirmed live); the result carries `unverified: true`, and the parser reads fields by content so it tolerates layout changes. If it returns nothing, the exam-plan tool's `bookable` flags are the confirmed signal, or pass an explicit `path`.",
    inputSchema: {
      session_id: almaesamiSessionIdSchema,
      cookies: almaesamiCookiesSchema,
      base_url: z.string().url().optional(),
      path: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Override for the appelli-list endpoint path (default /almaesami/studenti/appelloStudente-list.htm, which is UNVERIFIED). Provide the real route if known."
        )
    }
  },
  async ({ session_id, cookies: inputCookies, base_url, path }) => {
    const data = await runCookieService("almaesami", session_id, inputCookies, base_url, (ctx) =>
      getAppelli({ ...ctx, path })
    );
    return textResult(data as unknown as Record<string, unknown>);
  }
);

const rpsCookiesSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Cookie header with an authenticated PHPSESSID from a logged-in RPS browser session. Falls back to session_id, then RPS_COOKIES."
  );
const rpsSessionIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe("session_id from rps_get_env_session, rps_bootstrap_session, or unibo_browser_login.");

registerCookieBootstrapTool({
  toolName: "rps_bootstrap_session",
  title: "Bootstrap RPS Session",
  service: "rps",
  cookieDescription: "PHPSESSID cookie header for rps.unibo.it",
  defaultLabel: "rps-bootstrap"
});

registerEnvCookieSessionTool({
  toolName: "rps_get_env_session",
  title: "Get RPS Env-Backed Session",
  service: "rps",
  envVarName: "RPS_COOKIES"
});

server.registerTool(
  "rps_get_attendance_records",
  {
    annotations: READONLY,
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
    const data = await runCookieService("rps", session_id, inputCookies, base_url, (ctx) => getAttendanceRecords(ctx));
    return textResult(data as unknown as Record<string, unknown>);
  }
);

server.registerTool(
  "rps_get_register",
  {
    annotations: READONLY,
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
    const data = await runCookieService("rps", session_id, inputCookies, base_url, (ctx) => getRegister(ctx));
    return textResult(data as unknown as Record<string, unknown>);
  }
);

// --- Studenti Online (SOL) --------------------------------------------------

const solCookiesSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Cookie header with an authenticated JSESSIONID from a logged-in Studenti Online browser session. Falls back to session_id, then SOL_COOKIES."
  );
const solSessionIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe("session_id from sol_get_env_session, sol_bootstrap_session, or unibo_browser_login.");

registerCookieBootstrapTool({
  toolName: "sol_bootstrap_session",
  title: "Bootstrap Studenti Online Session",
  service: "sol",
  cookieDescription: "JSESSIONID cookie header for studenti.unibo.it",
  defaultLabel: "sol-bootstrap"
});

registerEnvCookieSessionTool({
  toolName: "sol_get_env_session",
  title: "Get Studenti Online Env-Backed Session",
  service: "sol",
  envVarName: "SOL_COOKIES"
});

server.registerTool(
  "sol_get_career",
  {
    annotations: READONLY,
    title: "Get Studenti Online Career Summary",
    description:
      "Reads the authenticated student's Studenti Online (studenti.unibo.it) home page into a career summary: greeting/identity, enrolled course of study, and in-progress requests. Read-only; never submits requests or payments. NOTE: parsed from a single logged-in capture — selectors are best-effort and individual fields degrade to empty rather than failing.",
    inputSchema: {
      session_id: solSessionIdSchema,
      cookies: solCookiesSchema,
      base_url: z.string().url().optional()
    }
  },
  async ({ session_id, cookies: inputCookies, base_url }) => {
    const data = await runCookieService("sol", session_id, inputCookies, base_url, (ctx) => getSolCareer(ctx));
    return textResult(data as unknown as Record<string, unknown>);
  }
);

server.registerTool(
  "sol_get_services",
  {
    annotations: READONLY,
    title: "List Studenti Online Services",
    description:
      "Lists the Studenti Online service tiles available to the student (name, link, description) — e.g. fees/payments, enrolments, certificates — so a caller can discover what the portal exposes. Read-only; it lists links, it does not act on them.",
    inputSchema: {
      session_id: solSessionIdSchema,
      cookies: solCookiesSchema,
      base_url: z.string().url().optional()
    }
  },
  async ({ session_id, cookies: inputCookies, base_url }) => {
    const data = await runCookieService("sol", session_id, inputCookies, base_url, (ctx) => getSolServices(ctx));
    return textResult(data as unknown as Record<string, unknown>);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
