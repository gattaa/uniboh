import { load } from "cheerio";

/**
 * virtuale.unibo.it (Moodle) quiz review scrapers.
 *
 * mod_quiz_* web service methods are not on the AJAX allowlist exposed at
 * /lib/ajax/service.php (only a handful of core/local methods are), so quiz
 * data is read by scraping the same HTML a browser would render:
 * course page -> quiz activity page -> attempt review page.
 *
 * Scoped to reviewing attempts a student has already finished/submitted
 * (closed-book review, like exam history). This intentionally does not
 * start, resume, or answer a live/in-progress attempt.
 */

const DEFAULT_BASE_URL = "https://virtuale.unibo.it";

export type QuizListing = {
  /** Course-module id, used as `id` in mod/quiz/view.php?id=. */
  cmid: string;
  name: string;
  url: string;
};

export type QuizAttemptSummary = {
  attemptNumber: number;
  /** Present once the attempt has a review link (finished attempts). */
  attemptId?: string;
  status: string;
  details: Record<string, string>;
  reviewUrl?: string;
};

export type QuizAnswerOption = {
  label: string;
  text: string;
  selected: boolean;
  correct: boolean;
};

export type QuizQuestionReview = {
  number: string;
  type: string;
  state: string;
  mark?: string;
  questionText: string;
  answers: QuizAnswerOption[];
  correctAnswerText?: string;
  specificFeedback?: string;
  generalFeedback?: string;
};

export type QuizAttemptReview = {
  quizName?: string;
  questions: QuizQuestionReview[];
};

function isUnauthenticated(html: string): boolean {
  return /SAMLRequest|idp\.unibo\.it\/adfs|login\/index\.php/i.test(html);
}

async function fetchPage(path: string, input: { cookies: string; baseUrl?: string }): Promise<{ url: string; html: string }> {
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const endpoint = new URL(path, baseUrl).toString();

  const res = await fetch(endpoint, {
    redirect: "follow",
    headers: { Cookie: input.cookies }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching ${endpoint}.`);
  }

  const html = await res.text();
  if (isUnauthenticated(html)) {
    throw new Error("Virtuale session is missing or expired. Re-capture the MoodleSession cookie from a logged-in browser.");
  }

  return { url: res.url || endpoint, html };
}

/** Parse the quiz activities linked from a course page. Pure/testable. */
export function parseQuizList(html: string): QuizListing[] {
  const $ = load(html);
  const quizzes: QuizListing[] = [];
  const seen = new Set<string>();

  $("a[href*='mod/quiz/view.php']").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const match = href.match(/[?&]id=(\d+)/);
    if (!match) return;
    const cmid = match[1];
    if (seen.has(cmid)) return;
    seen.add(cmid);

    const name = $(el).find(".instancename").text().trim() || $(el).text().trim();
    if (!name) return;

    quizzes.push({ cmid, name, url: href });
  });

  return quizzes;
}

/** Parse the per-attempt summary tables + review links from a quiz activity page. Pure/testable. */
export function parseQuizAttempts(html: string): QuizAttemptSummary[] {
  const $ = load(html);
  const attempts: QuizAttemptSummary[] = [];

  $("table.quizreviewsummary, table.quizattemptsummary").each((_, table) => {
    const $table = $(table);
    const caption = $table.find("caption").text().trim();
    const numberMatch = caption.match(/Attempt\s+(\d+)/i);
    const attemptNumber = numberMatch ? Number(numberMatch[1]) : attempts.length + 1;

    const details: Record<string, string> = {};
    $table.find("tr").each((_, tr) => {
      const key = $(tr).find("th").text().replace(/\s+/g, " ").trim();
      const value = $(tr).find("td").text().replace(/\s+/g, " ").trim();
      if (key) {
        details[key] = value;
      }
    });

    const reviewHref = $table
      .closest(".card, .box")
      .find("a[href*='mod/quiz/review.php']")
      .first()
      .attr("href");

    const attemptId = reviewHref?.match(/[?&]attempt=(\d+)/)?.[1];

    attempts.push({
      attemptNumber,
      attemptId,
      status: details["Status"] ?? "",
      details,
      reviewUrl: reviewHref
    });
  });

  return attempts;
}

function questionType(classAttr: string | undefined): string {
  if (!classAttr) return "unknown";
  const classes = classAttr.split(/\s+/);
  const known = [
    "multichoice",
    "truefalse",
    "shortanswer",
    "numerical",
    "essay",
    "match",
    "ddwtos",
    "ddmarker",
    "ddimageortext",
    "multianswer",
    "calculated",
    "description"
  ];
  return classes.find((c) => known.includes(c)) ?? classes[1] ?? "unknown";
}

/** Parse the `div.que` question blocks of an attempt review page. Pure/testable. */
export function parseAttemptReview(html: string): QuizAttemptReview {
  const $ = load(html);
  const quizName = $("h1").first().text().trim() || undefined;

  const questions: QuizQuestionReview[] = [];

  $("div.que").each((_, el) => {
    const $q = $(el);
    const type = questionType($q.attr("class"));

    const number = $q.find(".info .qno").first().text().trim();
    const state = $q.find(".info .state").first().text().trim();
    const mark = $q.find(".info .grade").first().text().replace(/\s+/g, " ").trim() || undefined;
    const questionText = $q.find(".qtext").first().text().replace(/\s+/g, " ").trim();

    const answers: QuizAnswerOption[] = [];
    $q.find(".answer > div").each((_, answerEl) => {
      const $a = $(answerEl);
      const classes = ($a.attr("class") ?? "").split(/\s+/);
      const label = $a.find(".answernumber").first().text().trim();
      const text = $a
        .clone()
        .find(".answernumber, .specificfeedback")
        .remove()
        .end()
        .text()
        .replace(/\s+/g, " ")
        .trim();

      answers.push({
        label,
        text,
        selected: $a.find("input[checked]").length > 0,
        correct: classes.includes("correct")
      });
    });

    const correctAnswerText = $q.find(".rightanswer").first().text().replace(/\s+/g, " ").trim() || undefined;
    const specificFeedback = $q.find(".specificfeedback").first().text().replace(/\s+/g, " ").trim() || undefined;
    const generalFeedback = $q.find(".generalfeedback").first().text().replace(/\s+/g, " ").trim() || undefined;

    questions.push({
      number,
      type,
      state,
      mark,
      questionText,
      answers,
      correctAnswerText,
      specificFeedback,
      generalFeedback
    });
  });

  return { quizName, questions };
}

/** Fetch and parse the quiz activities on a course page. */
export async function getCourseQuizzes(courseId: string | number, input: { cookies: string; baseUrl?: string }) {
  const { url, html } = await fetchPage(`/course/view.php?id=${courseId}`, input);
  const quizzes = parseQuizList(html);
  return { endpoint: url, total: quizzes.length, quizzes };
}

/** Fetch and parse a quiz activity's attempt summaries. */
export async function getQuizAttempts(cmid: string | number, input: { cookies: string; baseUrl?: string }) {
  const { url, html } = await fetchPage(`/mod/quiz/view.php?id=${cmid}`, input);
  const attempts = parseQuizAttempts(html);
  return { endpoint: url, total: attempts.length, attempts };
}

/**
 * Fetch and parse a single attempt's review page: questions, the student's
 * answers, correctness, and feedback. Only works once Moodle allows review
 * of that attempt (e.g. the attempt is finished and the quiz's review
 * options permit it) — otherwise Moodle itself will reject the request.
 */
export async function getAttemptReview(
  attemptId: string | number,
  cmid: string | number,
  input: { cookies: string; baseUrl?: string }
) {
  const { url, html } = await fetchPage(`/mod/quiz/review.php?attempt=${attemptId}&cmid=${cmid}`, input);
  const review = parseAttemptReview(html);
  return { endpoint: url, ...review };
}
