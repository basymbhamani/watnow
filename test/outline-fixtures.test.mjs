// test/outline-fixtures.test.mjs: golden-fixture checks for the outline parser.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseOutline, toLocalDay } from "../extension/src/data/outline-parser.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(join(HERE, "fixtures", "outlines", name), "utf8");

const COURSE = { id: "c_cis2500", code: "CIS 2500", name: "Intermediate Programming" };
const YEAR = 2026;

describe("Course outline fixtures", () => {
  test("MCS*3030 table: keeps the dated midterm, skips the TBA final", async () => {
    const items = parseOutline(await fixture("guelph-mcs3030.txt"), { course: COURSE, defaultYear: YEAR });
    const midterm = items.find((i) => i.title.includes("Midterm"));
    assert.ok(midterm, "Midterm should be found");
    assert.equal(toLocalDay(midterm.dueAt), "2026-10-11");
    assert.equal(midterm.weight, "20%");
    assert.equal(items.some((i) => i.title.includes("Final")), false);
  });

  test("PSYC*2360: reads the start time and in-person note", async () => {
    const items = parseOutline(await fixture("guelph-psyc2360.txt"), { course: COURSE, defaultYear: YEAR });
    assert.equal(items.length, 2);
    const midterm = items.find((i) => i.title.includes("Midterm"));
    assert.ok(midterm);
    const d = new Date(midterm.dueAt);
    assert.equal(d.getHours(), 17);
    assert.equal(d.getMinutes(), 30);
    assert.equal(midterm.location, "person");
  });

  test("STAT*2050: splits the dual midterm line into two", async () => {
    const items = parseOutline(await fixture("guelph-stat2050.txt"), { course: COURSE, defaultYear: YEAR });
    const midterms = items.filter((i) => i.title.includes("Midterm"));
    assert.equal(midterms.length, 2);
    assert.equal(toLocalDay(midterms[0].dueAt), "2026-02-12");
    assert.equal(toLocalDay(midterms[1].dueAt), "2026-03-18");
  });

  test("Waterloo date-first outline: two in-person midterms with a room", async () => {
    const items = parseOutline(await fixture("waterloo-outline-1.txt"), { course: COURSE, defaultYear: YEAR });
    assert.equal(items.length, 2);
    assert.equal(toLocalDay(items[0].dueAt), "2026-10-19");
    assert.equal(toLocalDay(items[1].dueAt), "2026-11-16");
    assert.equal(items[0].location, "AL105");
  });

  test("Waterloo percentage outline: skips 'To be Announced'", async () => {
    const items = parseOutline(await fixture("waterloo-outline-2.txt"), { course: COURSE, defaultYear: YEAR });
    assert.equal(items.length, 2);
    assert.equal(items.some((i) => i.title.includes("Final")), false);
  });
});
