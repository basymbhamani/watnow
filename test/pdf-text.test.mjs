// test/pdf-text.test.mjs: tests for reading text out of a PDF outline.
//
// These run the real vendored pdf.js over a small PDF built in memory, so the
// extraction path is exercised without a browser and without a stored file.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { pdfBytesToText } from "../extension/src/data/pdf-text.js";
import { parseOutline, toLocalDay } from "../extension/src/data/outline-parser.js";

function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Builds a one-page, uncompressed PDF with one text row per input line. */
function buildPdf(lines) {
  const stream = ["BT", "/F1 12 Tf", "20 180 Td", "14 TL", ...lines.flatMap((line, i) => [i ? "T*" : null, `(${esc(line)}) Tj`].filter(Boolean)), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

const toBytes = (pdf) => new Uint8Array(Buffer.from(pdf, "latin1"));

describe("pdfBytesToText", () => {
  test("reads one line per text row", async () => {
    const text = await pdfBytesToText(toBytes(buildPdf(["First Row", "Second Row"])));
    assert.deepEqual(text.split("\n"), ["First Row", "Second Row"]);
  });

  test("keeps a row that holds an assessment and its date on one line", async () => {
    const text = await pdfBytesToText(toBytes(buildPdf(["Midterm Examination October 11, 2026 20%"])));
    assert.deepEqual(text.split("\n"), ["Midterm Examination October 11, 2026 20%"]);
  });

  test("extracted outline text parses into dated assessments", async () => {
    const pdf = buildPdf([
      "Method and Timing of Evaluation",
      "Midterm Examination October 11, 2026 20%",
      "Final Examination Refer to WebAdvisor 25%",
    ]);
    const text = await pdfBytesToText(toBytes(pdf));
    const items = parseOutline(text, { defaultYear: 2026 });
    assert.equal(items.length, 1, "only the dated midterm should survive");
    assert.ok(items[0].title.includes("Midterm"));
    assert.equal(toLocalDay(items[0].dueAt), "2026-10-11");
    assert.equal(items[0].weight, "20%");
  });
});
