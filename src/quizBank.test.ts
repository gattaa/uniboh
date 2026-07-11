import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAttemptReview } from "./quiz.js";
import { mapReviewToAttempt, parseMoodleDateToISO, assertNoDuplicateAttemptIds, type BankAttempt } from "./quizBank.js";

const reviewHtml = `
  <html><body>
    <h1>lecture 00 self-evaluation test</h1>
    <div class="que multichoice deferredcbm correct">
      <div class="info">
        <h3 class="no">Question <span class="qno">1</span></h3>
        <div class="state">Correct</div>
      </div>
      <div class="content">
        <div class="formulation clearfix">
          <div class="qtext"><div class="clearfix">What is the main message?</div></div>
          <div class="answer">
            <div class="r0"><span class="answernumber">A. </span><div class="flex-fill">Wrong option</div></div>
            <div class="r1 correct"><input checked><span class="answernumber">B. </span><div class="flex-fill">Right option</div></div>
          </div>
        </div>
        <div class="outcome clearfix">
          <div class="rightanswer">The correct answer is: Right option</div>
          <div class="generalfeedback">General context about the topic.</div>
        </div>
      </div>
    </div>
    <div class="que multichoice">
      <div class="info">
        <h3 class="no">Question <span class="qno">2</span></h3>
        <div class="state">Incorrect</div>
      </div>
      <div class="content">
        <div class="formulation clearfix">
          <div class="qtext"><div class="clearfix">Second question, no feedback.</div></div>
          <div class="answer">
            <div class="r0"><span class="answernumber">A. </span><div class="flex-fill">Only option</div></div>
          </div>
        </div>
      </div>
    </div>
  </body></html>`;

test("mapReviewToAttempt maps a 4-option question, correct answer, and feedback", () => {
  const review = parseAttemptReview(reviewHtml);
  const attempt = mapReviewToAttempt(review, {
    cmid: 2373172,
    attemptId: 4378540,
    quizName: "lecture 00 self-evaluation test",
    completionDate: "2026-07-04"
  });

  assert.equal(attempt.questions.length, 2);
  const q1 = attempt.questions[0];
  assert.equal(q1.number, 1);
  assert.deepEqual(q1.options, { A: "Wrong option", B: "Right option" });
  assert.equal(q1.correct_option, "B");
  assert.equal(q1.correct_text, "Right option");
  assert.equal(q1.explanation, "General context about the topic.");
});

test("mapReviewToAttempt omits missing option labels and defaults missing feedback to empty string", () => {
  const review = parseAttemptReview(reviewHtml);
  const attempt = mapReviewToAttempt(review, {
    cmid: 2373172,
    attemptId: 4378540,
    quizName: "lecture 00 self-evaluation test",
    completionDate: "2026-07-04"
  });

  const q2 = attempt.questions[1];
  assert.deepEqual(q2.options, { A: "Only option" });
  assert.equal(q2.correct_option, "");
  assert.equal(q2.explanation, "");
});

test("parseMoodleDateToISO extracts a UTC-independent date from a Completed/Started field", () => {
  assert.equal(parseMoodleDateToISO({ "Completed on": "Saturday, 4 July 2026, 11:59 PM" }), "2026-07-04");
  assert.equal(parseMoodleDateToISO({ Started: "Monday, 1 December 2025, 8:05 AM" }), "2025-12-01");
  assert.throws(() => parseMoodleDateToISO({ Status: "Finished" }));
});

test("assertNoDuplicateAttemptIds refuses when an attempt_id is already present", () => {
  const attempt: BankAttempt = {
    cmid: 1,
    quiz_name: "q",
    attempt_id: 42,
    completion_date: "2026-01-01",
    questions: []
  };
  assert.throws(() => assertNoDuplicateAttemptIds(new Set([42]), [attempt]));
  assert.doesNotThrow(() => assertNoDuplicateAttemptIds(new Set([7]), [attempt]));
});
