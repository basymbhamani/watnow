// test/outline-parser.test.mjs: Tests for deterministic outline parsing and deduplication.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseOutline, normalizeTitle, isDuplicateItem, categoryFromTitle, toLocalDay } from "../extension/src/data/outline-parser.js";

const COURSE = { id: "c_cis2500", code: "CIS 2500", name: "Intermediate Programming" };

describe("Category Detection", () => {
  test("categorizes midterms, tests, and exams as quiz", () => {
    assert.equal(categoryFromTitle("Midterm Examination"), "quiz");
    assert.equal(categoryFromTitle("Term Test 2"), "quiz");
    assert.equal(categoryFromTitle("Final Exam"), "quiz");
  });

  test("categorizes lab exams and practicals as lab", () => {
    assert.equal(categoryFromTitle("In-Person Lab Test 1"), "lab");
    assert.equal(categoryFromTitle("Lab Exam"), "lab");
  });

  test("categorizes presentations and projects as assignment", () => {
    assert.equal(categoryFromTitle("Final Project Presentation"), "assignment");
    assert.equal(categoryFromTitle("Capstone Proposal"), "assignment");
  });
});

describe("Title Normalization", () => {
  test("strips grade weight percentages", () => {
    assert.equal(normalizeTitle("Midterm Examination (20%)"), "midterm");
    assert.equal(normalizeTitle("Midterm 1 25%"), "midterm 1");
  });

  test("normalizes exam/examination/test synonyms", () => {
    assert.equal(normalizeTitle("Midterm Exam #1"), "midterm 1");
    assert.equal(normalizeTitle("Midterm Examination"), "midterm");
  });

  test("cleans symbols and extra whitespace", () => {
    assert.equal(normalizeTitle("Quiz #3: Dynamic Programming"), "quiz 3 dynamic programming");
  });
});

describe("Day extraction", () => {
  test("reads a bare calendar date as written, with no timezone shift", () => {
    assert.equal(toLocalDay("2026-10-11"), "2026-10-11");
    assert.equal(toLocalDay("2026-01-01"), "2026-01-01");
  });

  test("returns null for empty or unparseable input", () => {
    assert.equal(toLocalDay(""), null);
    assert.equal(toLocalDay(null), null);
    assert.equal(toLocalDay("not a date"), null);
  });
});

describe("Parsing Real Outline Assessment Snippets", () => {
  test("Guelph MCS*3030: extracts midterm date from table, ignores D2L assignments and TBA final", () => {
    const text = `
Method and Timing of Evaluation:
Assignment / Examination Date Marks Allocated
Five (5) Online Quizzes Weekly 10% (2% each)
Survey Assignment October 4, 2026 15%
Midterm Examination October 11, 2026 20%
SPSS Assignment November 1, 2026 15%
Tableau Assignment November 15, 2026 15%
Final Examination Refer to WebAdvisor 25%
    `;

    const items = parseOutline(text, { course: COURSE, defaultYear: 2026 });
    // Final Exam is Refer to WebAdvisor -> ignored
    // Midterm Examination -> Oct 11, 2026
    const midterm = items.find((i) => i.title.includes("Midterm"));
    assert.ok(midterm, "Midterm should be found");
    assert.equal(toLocalDay(midterm.dueAt), "2026-10-11");
    assert.equal(midterm.weight, "20%");
    assert.equal(items.some((i) => i.title.includes("Final")), false, "TBA final exam should be skipped");
  });

  test("Guelph PSYC*2360: extracts exact start time, in-person note, and date", () => {
    const text = `
Course Requirements:
Midterm Exam Thurs Oct 16, 5:30-6:50 PM; In-person
Final Exam In-person, Tues Dec 2, 8:30-10:30 AM
    `;

    const items = parseOutline(text, { course: COURSE, defaultYear: 2026 });
    assert.equal(items.length, 2);

    const midterm = items.find((i) => i.title.includes("Midterm"));
    assert.ok(midterm);
    assert.equal(midterm.timeSpecified, true);
    const mtDate = new Date(midterm.dueAt);
    assert.equal(mtDate.getHours(), 17);
    assert.equal(mtDate.getMinutes(), 30);
    assert.equal(midterm.location, "person");

    const finalExam = items.find((i) => i.title.includes("Final"));
    assert.ok(finalExam);
    assert.equal(toLocalDay(finalExam.dueAt), "2026-12-02");
  });

  test("Guelph STAT*2050: splits dual midterms on one line", () => {
    const text = `
Midterm 1 & 2 : (Monday, February 12 and Monday, March 18; respectively) 45%
Final Exam: Saturday, April 20, 8:30 am - 10:30 am 35%
    `;

    const items = parseOutline(text, { course: COURSE, defaultYear: 2026 });
    const midterms = items.filter((i) => i.title.includes("Midterm"));
    assert.equal(midterms.length, 2, "Should split into Midterm 1 and Midterm 2");
    assert.equal(toLocalDay(midterms[0].dueAt), "2026-02-12");
    assert.equal(toLocalDay(midterms[1].dueAt), "2026-03-18");

    const finalExam = items.find((i) => i.title.includes("Final"));
    assert.ok(finalExam);
    assert.equal(toLocalDay(finalExam.dueAt), "2026-04-20");
  });

  test("Waterloo Outline 1: handles date-first format with classroom location", () => {
    const text = `
Oct 19 Midterm Exam, 8:30-9:50 a.m., in AL105 See Exam Overview
Nov 16 Midterm Exam, 8:30-9:50 a.m., in AL105 See Exam Overview
    `;

    const items = parseOutline(text, { course: COURSE, defaultYear: 2026 });
    assert.equal(items.length, 2);
    assert.equal(toLocalDay(items[0].dueAt), "2026-10-19");
    assert.equal(toLocalDay(items[1].dueAt), "2026-11-16");
    assert.equal(items[0].location, "AL105");
  });

  test("Waterloo Outline 2: ignores 'To be Announced' markers", () => {
    const text = `
Midterm Exam 1 15% Feb 2
Midterm Exam 2 15% March 16
Final Exam 30% To be Announced
    `;

    const items = parseOutline(text, { course: COURSE, defaultYear: 2026 });
    assert.equal(items.length, 2);
    assert.equal(items.some((i) => i.title.includes("Final")), false);
  });
});

describe("Long single-paragraph pages", () => {
  test("splits one long line on sentence ends so each row keeps its own date", () => {
    const filler = "The evaluation below is subject to change. ".repeat(8); // pushes the line past 300 chars
    const text = `${filler}Survey Assignment October 4, 2026 15%. Midterm Examination October 11, 2026 20%. Final Examination Refer to WebAdvisor 25%.`;
    assert.ok(text.length > 300, "the line must be over the cap to exercise the split");
    const items = parseOutline(text, { course: COURSE, defaultYear: 2026 });
    const midterm = items.find((i) => i.title.includes("Midterm"));
    assert.ok(midterm, "Midterm should be found after the split");
    assert.equal(toLocalDay(midterm.dueAt), "2026-10-11");
    assert.equal(items.some((i) => i.title.includes("Final")), false, "TBA final should be skipped");
  });
});

describe("Deduplication Against Existing D2L Items", () => {
  const existingD2LItems = [
    {
      id: "99001:dropbox:101",
      courseId: COURSE.id,
      title: "Survey Assignment",
      dueAt: "2026-10-04T23:59:00.000Z",
    },
    {
      id: "99001:quiz:202",
      title: "Online Quiz 1",
      dueAt: "2026-09-25T23:59:00.000Z",
    },
    {
      id: "99001:quiz:303",
      title: "Midterm 1",
      dueAt: "2026-10-11T19:00:00.000Z",
    },
  ];

  test("flags candidate as duplicate if title matches existing D2L item", () => {
    const candidate = {
      title: "Midterm 1 (20%)",
      dueAt: "2026-10-11T19:00:00.000Z",
    };
    const res = isDuplicateItem(candidate, existingD2LItems);
    assert.equal(res.isDuplicate, true);
    assert.equal(res.duplicateOf, "99001:quiz:303");
  });

  test("flags candidate as duplicate if on same day with same assessment type", () => {
    const candidate = {
      title: "Term Test #1",
      dueAt: "2026-10-11T23:59:00.000Z", // Same day as Midterm 1 in D2L
    };
    const res = isDuplicateItem(candidate, existingD2LItems);
    assert.equal(res.isDuplicate, true);
    assert.equal(res.reason, "same_day_assessment");
  });

  test("keeps candidate if not in D2L", () => {
    const candidate = {
      title: "Midterm 2",
      dueAt: "2026-11-14T19:00:00.000Z",
    };
    const res = isDuplicateItem(candidate, existingD2LItems);
    assert.equal(res.isDuplicate, false);
    assert.equal(res.duplicateOf, null);
  });

  test("parseOutline flags duplicates automatically via options.existingItems", () => {
    const text = `
Evaluation:
Midterm 1 October 11, 2026 25%
Midterm 2 November 14, 2026 25%
    `;

    const results = parseOutline(text, {
      course: COURSE,
      existingItems: existingD2LItems,
      defaultYear: 2026,
    });

    assert.equal(results.length, 2);
    const m1 = results.find((r) => r.title.includes("1"));
    const m2 = results.find((r) => r.title.includes("2"));

    assert.equal(m1.isDuplicate, true, "Midterm 1 is already in D2L so isDuplicate must be true");
    assert.equal(m2.isDuplicate, false, "Midterm 2 is new so isDuplicate must be false");
  });
});
