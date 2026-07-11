import fs from "node:fs";

import { getQuizAttempts, getAttemptReview, type QuizAttemptReview } from "./quiz.js";

/**
 * Syncs a local quiz-bank JSON file against Moodle quiz attempts: diffs by
 * attempt_id, fetches only new attempt reviews, and appends them in the
 * bank's schema. Never returns question content — only counts — so the
 * calling LLM never has to see/transcribe the fetched questions.
 */

export type BankQuestion = {
  number: number;
  text: string;
  options: Record<string, string>;
  correct_option: string;
  correct_text: string;
  explanation: string;
};

export type BankAttempt = {
  cmid: number;
  quiz_name: string;
  attempt_id: number;
  completion_date: string;
  questions: BankQuestion[];
};

export type QuizBankFile = {
  course_id?: number;
  quizzes: { cmid: number; name: string }[];
  attempts: BankAttempt[];
  [key: string]: unknown;
};

export type SyncFailure = { cmid: number; attempt_id: number; error: string };

export type SyncSummary = {
  new_attempts: number;
  new_questions: number;
  per_quiz: { cmid: number; quiz_name: string; new_attempt_ids: number[] }[];
  already_present: number;
  backup_path: string | null;
  dry_run: boolean;
  failed?: SyncFailure[];
};

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
];

/**
 * Extracts a YYYY-MM-DD from a Moodle "Completed"/"Started" summary field
 * (e.g. "Saturday, 4 July 2026, 11:43 AM") by matching the day/month/year
 * directly, rather than going through `Date`/`toISOString` — that round-trip
 * shifts to UTC and can roll the date to the next/previous day.
 */
export function parseMoodleDateToISO(details: Record<string, string>): string {
  const key =
    Object.keys(details).find((k) => /^completed/i.test(k)) ??
    Object.keys(details).find((k) => /^started/i.test(k));
  if (!key) {
    throw new Error(`Attempt summary has no Completed/Started date field (keys: ${Object.keys(details).join(", ")}).`);
  }

  const raw = details[key];
  const match = raw.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!match) {
    throw new Error(`Could not parse a date out of "${raw}".`);
  }

  const day = match[1].padStart(2, "0");
  const monthIndex = MONTHS.indexOf(match[2].toLowerCase());
  if (monthIndex === -1) {
    throw new Error(`Unknown month name in "${raw}".`);
  }

  return `${match[3]}-${String(monthIndex + 1).padStart(2, "0")}-${day}`;
}

/** Maps a fetched attempt review into the bank's question/answer schema. Pure/testable. */
export function mapReviewToAttempt(
  review: QuizAttemptReview,
  opts: { cmid: number; attemptId: number; quizName: string; completionDate: string }
): BankAttempt {
  const questions: BankQuestion[] = review.questions
    .map((q) => {
      const options: Record<string, string> = {};
      let correctOption = "";
      let correctText = "";

      for (const answer of q.answers) {
        const letter = answer.label.trim().match(/[A-Za-z]/)?.[0]?.toUpperCase();
        if (!letter) continue;
        options[letter] = answer.text;
        if (answer.correct) {
          correctOption = letter;
          correctText = answer.text;
        }
      }

      return {
        number: Number(q.number) || 0,
        text: q.questionText,
        options,
        correct_option: correctOption,
        correct_text: correctText,
        explanation: q.generalFeedback ?? ""
      };
    })
    .sort((a, b) => a.number - b.number);

  return {
    cmid: opts.cmid,
    quiz_name: opts.quizName,
    attempt_id: opts.attemptId,
    completion_date: opts.completionDate,
    questions
  };
}

function readBankFile(bankPath: string): QuizBankFile {
  if (!fs.existsSync(bankPath)) {
    throw new Error(`Bank file not found: ${bankPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(bankPath, "utf8"));
  if (!Array.isArray(raw.attempts)) {
    throw new Error(`Bank file ${bankPath} is missing an "attempts" array.`);
  }
  if (!Array.isArray(raw.quizzes)) {
    throw new Error(`Bank file ${bankPath} is missing a "quizzes" array.`);
  }
  return raw as QuizBankFile;
}

/** Throws if any attempt about to be appended collides with an existing or duplicate attempt_id. Pure/testable. */
export function assertNoDuplicateAttemptIds(existingIds: Set<number>, toAppend: BankAttempt[]): void {
  const seen = new Set<number>();
  for (const attempt of toAppend) {
    if (existingIds.has(attempt.attempt_id) || seen.has(attempt.attempt_id)) {
      throw new Error(`Refusing to write: attempt_id ${attempt.attempt_id} is already present in the bank file.`);
    }
    seen.add(attempt.attempt_id);
  }
}

/**
 * Diffs `bankPath`'s `attempts` (by attempt_id) against each quiz's finished
 * Moodle attempts, fetches reviews only for the missing ones, and appends
 * them to the file (after a `.bak` backup). Returns counts only — never
 * question content.
 */
export async function syncQuizBank(
  bankPath: string,
  input: { cookies: string; baseUrl?: string; cmids?: number[]; dryRun?: boolean }
): Promise<SyncSummary> {
  const bank = readBankFile(bankPath);
  const dryRun = input.dryRun ?? false;
  const ctx = { cookies: input.cookies, baseUrl: input.baseUrl };

  const nameByCmid = new Map(bank.quizzes.map((q) => [Number(q.cmid), q.name]));
  const cmids = [...new Set(input.cmids ?? bank.quizzes.map((q) => Number(q.cmid)))].sort((a, b) => a - b);
  if (cmids.length === 0) {
    throw new Error("No cmids to sync: pass cmids or populate the bank file's quizzes list.");
  }

  const existingIds = new Set(bank.attempts.map((a) => a.attempt_id));
  const perQuiz: SyncSummary["per_quiz"] = [];
  const failed: SyncFailure[] = [];
  const toAppend: BankAttempt[] = [];
  let alreadyPresent = 0;

  for (const cmid of cmids) {
    const { attempts } = await getQuizAttempts(cmid, ctx);
    const quizName = nameByCmid.get(cmid) ?? `Quiz ${cmid}`;
    const finished = attempts.filter((a) => a.status.toLowerCase() === "finished" && a.attemptId);
    const newIds: number[] = [];

    for (const attempt of finished) {
      const attemptId = Number(attempt.attemptId);
      if (existingIds.has(attemptId)) {
        alreadyPresent += 1;
        continue;
      }
      if (dryRun) {
        newIds.push(attemptId);
        continue;
      }

      try {
        const completionDate = parseMoodleDateToISO(attempt.details);
        const review = await getAttemptReview(attemptId, cmid, ctx);
        toAppend.push(
          mapReviewToAttempt(review, {
            cmid,
            attemptId,
            quizName: nameByCmid.get(cmid) ?? review.quizName ?? quizName,
            completionDate
          })
        );
        newIds.push(attemptId);
      } catch (err) {
        failed.push({ cmid, attempt_id: attemptId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    newIds.sort((a, b) => a - b);
    perQuiz.push({ cmid, quiz_name: quizName, new_attempt_ids: newIds });
  }

  assertNoDuplicateAttemptIds(existingIds, toAppend);

  let backupPath: string | null = null;
  if (!dryRun && toAppend.length > 0) {
    backupPath = `${bankPath}.bak`;
    fs.copyFileSync(bankPath, backupPath);
    toAppend.sort((a, b) => a.cmid - b.cmid || a.attempt_id - b.attempt_id);
    bank.attempts.push(...toAppend);
    fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2));
  }

  return {
    new_attempts: dryRun ? perQuiz.reduce((n, q) => n + q.new_attempt_ids.length, 0) : toAppend.length,
    new_questions: toAppend.reduce((n, a) => n + a.questions.length, 0),
    per_quiz: perQuiz,
    already_present: alreadyPresent,
    backup_path: backupPath,
    dry_run: dryRun,
    ...(failed.length > 0 ? { failed } : {})
  };
}
