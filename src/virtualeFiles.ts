import { createWriteStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { SessionExpiredError, VIRTUALE_EXPIRED_MESSAGE, isVirtualeAuthExpired } from "./sessions.js";

/**
 * virtuale.unibo.it (Moodle) course file / resource retrieval.
 *
 * The reverse-engineered flow (see virtuale.unibo.it-api-notes.md §
 * "Resource/PDF retrieval flow"):
 *   1. `core_courseformat_get_state` returns `cm` entries whose `url` looks like
 *      `/mod/resource/view.php?id=<cmid>`.
 *   2. GETting that URL with an authenticated `MoodleSession` cookie redirects
 *      to the final protected file under `/pluginfile.php/...`.
 *
 * This module holds:
 *   - pure transforms/classifiers (unit-tested): {@link buildFileListing},
 *     {@link filenameFromContentDisposition}, {@link classifyContentType},
 *     {@link resourceViewPath};
 *   - the network fetch {@link getResource} (cookie-scrape path, mirroring
 *     quiz.ts: an expired MoodleSession is bounced to the SSO login page instead
 *     of the file, which we detect and surface as a clear error).
 *
 * Read-only: it downloads/renders existing files, never uploads or mutates.
 */

const DEFAULT_BASE_URL = "https://virtuale.unibo.it";

/** Above this many characters, inline text/PDF extraction is truncated. */
const MAX_INLINE_CHARS = 50_000;

// --- Pure transforms / classifiers (network-free, unit-tested) --------------

export type CourseFile = {
  /** Course-module id (Moodle `cm.id`), used as `id` in mod/resource/view.php?id=. */
  cmid: number;
  name: string;
  /** Module type, e.g. "resource". */
  modname: string;
  /** The activity view URL from the state (relative or absolute). */
  url: string;
};

export type SectionFiles = {
  sectionId: number;
  title: string;
  files: CourseFile[];
};

export type FileListing = {
  courseId?: number;
  totalFiles: number;
  sections: SectionFiles[];
};

/** Build the `/mod/resource/view.php?id=<cmid>` path for a course-module id. */
export function resourceViewPath(cmid: number | string): string {
  return `/mod/resource/view.php?id=${cmid}`;
}

function moduleNameOf(cm: Record<string, unknown>): string {
  const raw = (cm.module ?? cm.modname ?? "") as unknown;
  return String(raw).trim();
}

function isFileCm(cm: Record<string, unknown>): boolean {
  const mod = moduleNameOf(cm).toLowerCase();
  const url = typeof cm.url === "string" ? cm.url : "";
  return mod === "resource" || /\/mod\/resource\/view\.php/i.test(url);
}

/**
 * Slim the `core_courseformat_get_state` blob down to just the downloadable
 * file/resource activities, grouped by section, preserving section order. This
 * is a token-friendly listing, not a re-dump of the whole state model.
 */
export function buildFileListing(state: unknown): FileListing {
  const s = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;

  const course = (s.course && typeof s.course === "object" ? s.course : {}) as Record<string, unknown>;
  const courseId = typeof course.id === "number" ? course.id : undefined;

  const cms = Array.isArray(s.cm) ? (s.cm as Record<string, unknown>[]) : [];
  const cmById = new Map<string, Record<string, unknown>>();
  for (const cm of cms) {
    if (cm && cm.id != null) cmById.set(String(cm.id), cm);
  }

  const toFile = (cm: Record<string, unknown>): CourseFile => ({
    cmid: Number(cm.id),
    name: String(cm.name ?? "").trim(),
    modname: moduleNameOf(cm),
    url: typeof cm.url === "string" ? cm.url : ""
  });

  const sectionArr = Array.isArray(s.section) ? (s.section as Record<string, unknown>[]) : [];
  const sections: SectionFiles[] = [];
  let totalFiles = 0;

  for (const sec of sectionArr) {
    const cmlist = Array.isArray(sec.cmlist) ? (sec.cmlist as (number | string)[]) : [];
    const files: CourseFile[] = [];
    for (const cmid of cmlist) {
      const cm = cmById.get(String(cmid));
      if (cm && isFileCm(cm)) files.push(toFile(cm));
    }
    if (files.length) {
      sections.push({
        sectionId: Number(sec.id),
        title: String(sec.title ?? sec.name ?? "").trim(),
        files
      });
      totalFiles += files.length;
    }
  }

  return { courseId, totalFiles, sections };
}

/**
 * Resolve a download filename from a `Content-Disposition` header (RFC 6266,
 * incl. RFC 5987 `filename*`), falling back to the final URL's path basename.
 */
export function filenameFromContentDisposition(
  disposition: string | null | undefined,
  fallbackUrl = ""
): string {
  if (disposition) {
    // RFC 5987 extended form: filename*=UTF-8''percent%20encoded.pdf
    const star = disposition.match(/filename\*\s*=\s*(?:[\w-]+'[^']*')?([^;]+)/i);
    if (star) {
      const value = star[1].trim().replace(/^["']|["']$/g, "");
      try {
        return decodeURIComponent(value);
      } catch {
        if (value) return value;
      }
    }
    const quoted = disposition.match(/filename\s*=\s*"([^"]+)"/i);
    if (quoted) return quoted[1];
    const bare = disposition.match(/filename\s*=\s*([^;]+)/i);
    if (bare) {
      const value = bare[1].trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }

  // Fall back to the URL path basename.
  let pathname = fallbackUrl;
  try {
    pathname = new URL(fallbackUrl).pathname;
  } catch {
    pathname = fallbackUrl.split(/[?#]/)[0];
  }
  const base = pathname.split("/").filter(Boolean).pop();
  if (base) {
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  }
  return "download";
}

/** Classify a Content-Type as text-like / PDF / HTML for inline handling. */
export function classifyContentType(contentType: string | null | undefined): {
  textLike: boolean;
  isPdf: boolean;
  isHtml: boolean;
} {
  const ct = (contentType ?? "").toLowerCase();
  const isPdf = ct.includes("application/pdf");
  const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
  const textLike =
    ct.startsWith("text/") ||
    isHtml ||
    ct.includes("application/json") ||
    ct.includes("application/xml") ||
    ct.includes("application/javascript") ||
    ct.includes("+json") ||
    ct.includes("+xml");
  return { textLike, isPdf, isHtml };
}

// --- Resource fetch (network; cookie-scrape path) ---------------------------

export type ResourceResult = {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  contentLength?: number;
  filename: string;
  /** How the body was handled. */
  kind: "saved" | "text" | "pdf-text" | "binary";
  savedTo?: string;
  savedBytes?: number;
  pageCount?: number;
  text?: string;
  truncated?: boolean;
  note?: string;
};

function truncateText(text: string): { text: string; truncated: boolean; note?: string } {
  if (text.length <= MAX_INLINE_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_INLINE_CHARS),
    truncated: true,
    note: `Text truncated to ${MAX_INLINE_CHARS} of ${text.length} characters. Pass save_to (absolute path) to download the full file.`
  };
}

async function extractPdfText(buf: Buffer): Promise<{ text: string; pageCount: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text: Array.isArray(text) ? text.join("\n\n") : text, pageCount: totalPages };
}

/**
 * Fetch a course resource/file and return metadata plus, depending on options
 * and content type, a saved file / inline text / extracted PDF text.
 */
export async function getResource(
  params: { cmid?: number | string; url?: string; saveTo?: string },
  ctx: { cookies: string; baseUrl?: string }
): Promise<ResourceResult> {
  const baseUrl = ctx.baseUrl ?? DEFAULT_BASE_URL;

  let target: string;
  if (params.url) {
    target = new URL(params.url, baseUrl).toString();
  } else if (params.cmid != null) {
    target = new URL(resourceViewPath(params.cmid), baseUrl).toString();
  } else {
    throw new Error("Provide either cmid or url.");
  }

  if (params.saveTo && !isAbsolute(params.saveTo)) {
    throw new Error("save_to must be an absolute file path.");
  }

  const res = await fetch(target, {
    redirect: "follow",
    headers: { Cookie: ctx.cookies }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching ${target}.`);
  }

  const finalUrl = res.url || target;
  const contentType = res.headers.get("content-type") ?? "";
  // The final URL alone catches the redirect-to-IdP / login-page case, without
  // reading a (possibly binary) body. The HTML body is checked below for the
  // in-page SAMLRequest form case.
  if (isVirtualeAuthExpired("", finalUrl)) {
    throw new SessionExpiredError("virtuale", VIRTUALE_EXPIRED_MESSAGE);
  }

  const cls = classifyContentType(contentType);
  const filename = filenameFromContentDisposition(res.headers.get("content-disposition"), finalUrl);
  const clHeader = res.headers.get("content-length");
  const headerLength = clHeader != null && clHeader !== "" ? Number(clHeader) : undefined;

  const base = { requestedUrl: target, finalUrl, contentType, filename };

  // Stream binary (non-HTML) bodies straight to disk without buffering.
  if (params.saveTo && !cls.isHtml) {
    if (!res.body) throw new Error("Response has no body to save.");
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(params.saveTo)
    );
    const { size } = await stat(params.saveTo);
    return {
      ...base,
      contentLength: headerLength ?? size,
      kind: "saved",
      savedTo: params.saveTo,
      savedBytes: size
    };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const byteLength = headerLength ?? buf.length;

  // HTML could be a login page even when the final URL didn't obviously match.
  if (cls.isHtml && isVirtualeAuthExpired(buf.toString("utf8"), finalUrl)) {
    throw new SessionExpiredError("virtuale", VIRTUALE_EXPIRED_MESSAGE);
  }

  if (params.saveTo) {
    await writeFile(params.saveTo, buf);
    return {
      ...base,
      contentLength: byteLength,
      kind: "saved",
      savedTo: params.saveTo,
      savedBytes: buf.length
    };
  }

  if (cls.textLike) {
    const t = truncateText(buf.toString("utf8"));
    return {
      ...base,
      contentLength: byteLength,
      kind: "text",
      text: t.text,
      truncated: t.truncated,
      ...(t.note ? { note: t.note } : {})
    };
  }

  if (cls.isPdf) {
    const { text, pageCount } = await extractPdfText(buf);
    const t = truncateText(text);
    return {
      ...base,
      contentLength: byteLength,
      kind: "pdf-text",
      pageCount,
      text: t.text,
      truncated: t.truncated,
      note: t.note ?? "Extracted PDF text inline. Pass save_to (absolute path) to download the original PDF."
    };
  }

  return {
    ...base,
    contentLength: byteLength,
    kind: "binary",
    note: "Binary content not returned inline. Pass save_to (absolute path) to download it."
  };
}
