// test/html-text.test.mjs: tests for turning Learn HTML into plain text.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { htmlToText, htmlToLines } from "../extension/src/data/html-text.js";

describe("htmlToText", () => {
  test("flattens a page to one line with no line breaks", () => {
    const out = htmlToText("<p>Midterm</p>\n<p>October 11, 2026</p>");
    assert.equal(out.includes("\n"), false);
    assert.equal(out.trim(), "Midterm October 11, 2026");
  });

  test("decodes non-breaking spaces and collapses runs of whitespace", () => {
    assert.equal(htmlToText("<td>a</td>&nbsp;&nbsp;<td>b</td>").trim(), "a b");
  });
});

describe("htmlToLines", () => {
  test("keeps one line per table row", () => {
    const html = "<table><tr><td>Midterm Examination</td><td>October 11, 2026</td><td>20%</td></tr><tr><td>Final Exam</td><td>TBA</td></tr></table>";
    assert.deepEqual(htmlToLines(html).split("\n"), [
      "Midterm Examination October 11, 2026 20%",
      "Final Exam TBA",
    ]);
  });

  test("a <br> starts a new line", () => {
    assert.deepEqual(htmlToLines("Midterm Exam<br>October 11, 2026").split("\n"), [
      "Midterm Exam",
      "October 11, 2026",
    ]);
  });

  test("keeps a table cell on its row instead of breaking it out", () => {
    const lines = htmlToLines("<table><tr><td>Lab Test</td><td>March 3, 2026</td></tr></table>").split("\n");
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "Lab Test March 3, 2026");
  });

  test("returns an empty string for empty input", () => {
    assert.equal(htmlToLines(""), "");
    assert.equal(htmlToLines(null), "");
  });
});
