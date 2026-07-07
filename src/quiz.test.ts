import { test } from "node:test";
import assert from "node:assert/strict";

import { parseQuizList, parseQuizAttempts, parseAttemptReview } from "./quiz.js";

test("parseQuizList extracts cmid, name and url from course page quiz links", () => {
  const html = `
    <html><body>
      <a href="https://virtuale.unibo.it/mod/quiz/view.php?id=2373172">
        <img alt="">
        <span class="instancename">lecture 00 self-evaluation test<span class="accesshide"> Quiz</span></span>
      </a>
      <a href="https://virtuale.unibo.it/mod/quiz/view.php?id=2373304">
        <span class="instancename">lecture 01 self-evaluation test<span class="accesshide"> Quiz</span></span>
      </a>
    </body></html>`;

  const quizzes = parseQuizList(html);
  assert.equal(quizzes.length, 2);
  assert.equal(quizzes[0].cmid, "2373172");
  assert.match(quizzes[0].name, /lecture 00 self-evaluation test/);
});

test("parseQuizAttempts reads the summary table and links the review URL", () => {
  const html = `
    <html><body>
      <div class="card h-100">
        <table class="generalbox quizreviewsummary mb-0">
          <caption class="sr-only">Attempt 1 summary</caption>
          <tbody>
            <tr><th class="cell" scope="row">Status</th><td class="cell">Finished</td></tr>
            <tr><th class="cell" scope="row">Started</th><td class="cell">Saturday, 4 July 2026, 11:43 AM</td></tr>
            <tr><th class="cell" scope="row">Marks</th><td class="cell">26.00/10.00</td></tr>
            <tr><th class="cell" scope="row">Grade</th><td class="cell"><b>78.00</b> out of 30.00 (<b>260</b>%)</td></tr>
          </tbody>
        </table>
        <div class="card-body py-2">
          <div><a title="Review your responses to this attempt" href="https://virtuale.unibo.it/mod/quiz/review.php?attempt=4378540&cmid=2373172">Review</a></div>
        </div>
      </div>
    </body></html>`;

  const attempts = parseQuizAttempts(html);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].attemptNumber, 1);
  assert.equal(attempts[0].attemptId, "4378540");
  assert.equal(attempts[0].status, "Finished");
  assert.equal(attempts[0].details["Marks"], "26.00/10.00");
});

test("parseAttemptReview extracts question text, answers, correctness and feedback", () => {
  const html = `
    <html><body>
      <h1>lecture 00 self-evaluation test</h1>
      <div class="que multichoice deferredcbm correct">
        <div class="info">
          <h3 class="no">Question <span class="qno">1</span></h3>
          <div class="state">Correct</div>
          <div class="grade">Mark 1.00 out of 1.00</div>
        </div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext"><div class="clearfix">What is the main message?</div></div>
            <div class="answer">
              <div class="r0"><input type="radio" value="0"><span class="answernumber">A. </span><div class="flex-fill">Wrong option</div></div>
              <div class="r1 correct"><input type="radio" value="1" checked><span class="answernumber">B. </span><div class="flex-fill">Right option</div><div class="specificfeedback">Correct, well done.</div></div>
            </div>
          </div>
          <div class="outcome clearfix">
            <div class="rightanswer">The correct answer is: Right option</div>
            <div class="generalfeedback">General context about the topic.</div>
          </div>
        </div>
      </div>
    </body></html>`;

  const review = parseAttemptReview(html);
  assert.equal(review.quizName, "lecture 00 self-evaluation test");
  assert.equal(review.questions.length, 1);

  const q = review.questions[0];
  assert.equal(q.number, "1");
  assert.equal(q.type, "multichoice");
  assert.equal(q.state, "Correct");
  assert.equal(q.questionText, "What is the main message?");
  assert.equal(q.answers.length, 2);
  assert.equal(q.answers[0].correct, false);
  assert.equal(q.answers[1].correct, true);
  assert.equal(q.answers[1].selected, true);
  assert.equal(q.answers[1].text, "Right option");
  assert.match(q.correctAnswerText ?? "", /Right option/);
  assert.match(q.generalFeedback ?? "", /General context/);
});
