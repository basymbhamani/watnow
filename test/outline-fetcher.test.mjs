// test/outline-fetcher.test.mjs: tests for finding and reading D2L outline topics.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { findOutlineTopics, scanCourseOutline } from "../extension/src/data/outline-fetcher.js";
import { htmlToLines } from "../extension/src/data/html-text.js";

const COURSE = { id: "ou123", orgUnitId: 123, code: "CIS 2500", name: "Intermediate Programming" };
const VIEW = (ou, topicId) => `/d2l/le/content/${ou}/viewContent/${topicId}/View`;

/** A fake LiveSource: enough surface for scanCourseOutline to run. */
function mockSource({ toc, texts = {}, apiError = null, pageError = null } = {}) {
  return {
    async ensureVersions() {
      return { le: "1.67", lp: "1.43" };
    },
    async api() {
      if (apiError) {
        const e = new Error(apiError);
        e.code = apiError;
        throw e;
      }
      return toc;
    },
    async pageText(path) {
      if (pageError) {
        const e = new Error(pageError);
        e.code = pageError;
        throw e;
      }
      return texts[path] ?? null;
    },
    async pageRows(path) {
      if (pageError) {
        const e = new Error(pageError);
        e.code = pageError;
        throw e;
      }
      return texts[path] ?? null;
    },
  };
}

const OUTLINE_TEXT = [
  "Method and Timing of Evaluation:",
  "Survey Assignment October 4, 2026 15%",
  "Midterm Examination October 11, 2026 20%",
  "Final Examination Refer to WebAdvisor 25%",
].join("\n");

describe("findOutlineTopics", () => {
  test("finds a topic named like an outline", () => {
    const toc = { Modules: [{ Title: "Week 1", Topics: [{ TopicId: 1, Title: "Course Outline", Url: "/a.html", TypeIdentifier: "File" }] }] };
    const topics = findOutlineTopics(toc);
    assert.equal(topics.length, 1);
    assert.equal(topics[0].topicId, 1);
  });

  test("pulls topics out of a module named like an outline", () => {
    const toc = {
      Modules: [
        {
          Title: "Course Outline",
          Topics: [{ TopicId: 9, Title: "Weekly Schedule", Url: "/sched.html", TypeIdentifier: "File" }],
          Modules: [{ Title: "Assessments", Topics: [{ TopicId: 10, Title: "Evaluation", Url: "/eval.html" }] }],
        },
      ],
    };
    const topics = findOutlineTopics(toc);
    assert.deepEqual(topics.map((t) => t.topicId).sort((a, b) => a - b), [9, 10]);
  });

  test("returns nothing when no outline is present", () => {
    const toc = { Modules: [{ Title: "Week 1", Topics: [{ TopicId: 1, Title: "Lecture 1", Url: "/a.html" }] }] };
    assert.equal(findOutlineTopics(toc).length, 0);
  });

  test("orders text/HTML topics before PDF downloads", () => {
    const toc = {
      Modules: [
        {
          Title: "Course Outline",
          Topics: [
            { TopicId: 1, Title: "Course Outline (PDF)", Url: "/outline.pdf" },
            { TopicId: 2, Title: "Course Outline (web)", Url: "/outline.html" },
          ],
        },
      ],
    };
    const topics = findOutlineTopics(toc);
    assert.equal(topics[0].url, "/outline.html");
  });
});

describe("scanCourseOutline", () => {
  test("reads an outline topic and parses assessments", async () => {
    const toc = { Modules: [{ Title: "Content", Topics: [{ TopicId: 555, Title: "Course Outline" }] }] };
    const source = mockSource({ toc, texts: { [VIEW(123, 555)]: OUTLINE_TEXT } });
    const res = await scanCourseOutline(source, COURSE, []);
    assert.equal(res.found, true);
    assert.equal(res.items.length, 1);
    assert.ok(res.items[0].title.includes("Midterm"));
    assert.equal(res.reason, null);
  });

  test("reports unsupported-source instead of throwing on a stub source", async () => {
    const res = await scanCourseOutline({}, COURSE, []);
    assert.equal(res.found, false);
    assert.equal(res.reason, "unsupported-source");
  });

  test("reports invalid-course when the org unit id is missing", async () => {
    const res = await scanCourseOutline(mockSource({ toc: { Modules: [] } }), { id: "x" }, []);
    assert.equal(res.reason, "invalid-course");
  });

  test("reports toc-failed when the table of contents cannot be read", async () => {
    const res = await scanCourseOutline(mockSource({ apiError: "http" }), COURSE, []);
    assert.match(res.reason, /^toc-failed/);
  });

  test("reports no-outline-topic when nothing matches", async () => {
    const toc = { Modules: [{ Title: "Week 1", Topics: [{ TopicId: 1, Title: "Lecture 1" }] }] };
    const res = await scanCourseOutline(mockSource({ toc }), COURSE, []);
    assert.equal(res.reason, "no-outline-topic");
  });

  test("falls back to the topic's own URL when the viewer yields nothing", async () => {
    const toc = { Modules: [{ Title: "Course Outline", Topics: [{ TopicId: 7, Title: "Schedule", Url: "https://learn.example.ca/content/enforced/1/sched.html" }] }] };
    const source = mockSource({ toc, texts: { "/content/enforced/1/sched.html": OUTLINE_TEXT } });
    const res = await scanCourseOutline(source, COURSE, []);
    assert.equal(res.found, true);
    assert.equal(res.items.length, 1);
  });

  test("rethrows a signed-out page read so the caller can ask the user to sign in", async () => {
    const toc = { Modules: [{ Title: "Content", Topics: [{ TopicId: 555, Title: "Course Outline" }] }] };
    await assert.rejects(
      () => scanCourseOutline(mockSource({ toc, pageError: "signed-out" }), COURSE, []),
      (e) => e.code === "signed-out",
    );
  });

  test("parses a table-shaped outline page read one row per line", async () => {
    const html = [
      "<table>",
      "<tr><td>Survey Assignment</td><td>October 4, 2026</td><td>15%</td></tr>",
      "<tr><td>Midterm Examination</td><td>October 11, 2026</td><td>20%</td></tr>",
      "<tr><td>Final Examination</td><td>Refer to WebAdvisor</td><td>25%</td></tr>",
      "</table>",
    ].join("");
    const source = {
      async ensureVersions() { return { le: "1.67" }; },
      async api() { return { Modules: [{ Title: "Course Outline", Topics: [{ TopicId: 5, Title: "Schedule" }] }] }; },
      async pageRows() { return htmlToLines(html); },
      async pageText() { return null; },
    };
    const res = await scanCourseOutline(source, COURSE, []);
    assert.equal(res.found, true);
    assert.equal(res.items.length, 1, "only the dated midterm should survive");
    assert.ok(res.items[0].title.includes("Midterm"));
    assert.equal(res.items[0].weight, "20%");
  });
});
