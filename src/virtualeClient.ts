import { fetchWithTimeout } from "./http.js";

export type ServiceCallResult = {
  error: boolean;
  exception?: string;
  message?: string;
  debuginfo?: string;
  data?: unknown;
};

export type ClientConfig = {
  baseUrl: string;
  sesskey?: string;
  cookies?: string;
};

export class VirtualeClient {
  private readonly config: ClientConfig;

  constructor(config: ClientConfig) {
    this.config = config;
  }

  async callService(methodname: string, args: Record<string, unknown>): Promise<ServiceCallResult> {
    if (!this.config.sesskey) {
      throw new Error(`Missing sesskey for authenticated method ${methodname}`);
    }

    const endpoint = new URL("/lib/ajax/service.php", this.config.baseUrl);
    endpoint.searchParams.set("sesskey", this.config.sesskey);
    endpoint.searchParams.set("info", methodname);

    const body = [
      {
        index: 0,
        methodname,
        args
      }
    ];

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.config.cookies) {
      headers.Cookie = this.config.cookies;
    }

    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while calling ${methodname}`);
    }

    const json = (await response.json()) as unknown;
    if (!Array.isArray(json) || json.length === 0) {
      throw new Error(`Unexpected response shape from ${methodname}`);
    }

    return json[0] as ServiceCallResult;
  }

  async callNoLogin(methodname: string, args: Record<string, unknown>): Promise<unknown> {
    const endpoint = new URL("/lib/ajax/service-nologin.php", this.config.baseUrl);
    endpoint.searchParams.set("info", methodname);
    endpoint.searchParams.set("cachekey", "0");
    endpoint.searchParams.set(
      "args",
      JSON.stringify([
        {
          index: 0,
          methodname,
          args
        }
      ])
    );

    const headers: Record<string, string> = {};
    if (this.config.cookies) {
      headers.Cookie = this.config.cookies;
    }

    const response = await fetchWithTimeout(endpoint, {
      headers
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while calling nologin ${methodname}`);
    }

    return response.json();
  }
}

// Keys that bloat Moodle payloads (HTML summaries, base64 course images, icon
// markup) without helping an agent. Everything else is kept as-is.
const BULKY_KEYS = new Set([
  "summary",
  "summaryformat",
  "summaryfiles",
  "overviewfiles",
  "courseimage",
  "fullnamedisplay",
  "showshortname",
  "afterlink",
  "activityicon",
  "extraclasses",
  // Unibo extras on enrolled courses: UI widgets (unenrol form, visibility toggle) + a summary duplicating code/teacher.
  "mysummary",
  "enrolmethods",
  "changevisibility",
  "unenrollink"
]);

/** Recursively drop {@link BULKY_KEYS}, `data:` URIs, and truncate any string over `maxStr` chars. */
export function compactMoodle(value: unknown, maxStr = 1000): unknown {
  if (Array.isArray(value)) return value.map((v) => compactMoodle(v, maxStr));
  if (typeof value === "string") {
    return value.length > maxStr ? `${value.slice(0, maxStr)}…[truncated ${value.length - maxStr} chars]` : value;
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (BULKY_KEYS.has(k) || (typeof v === "string" && v.startsWith("data:"))) continue;
    out[k] = compactMoodle(v, maxStr);
  }
  return out;
}
