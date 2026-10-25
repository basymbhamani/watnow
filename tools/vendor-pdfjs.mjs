/*
  Copies the pdf.js runtime into extension/vendor/pdfjs, so the unpacked
  extension can load it with no bundler. The extension only reads text from a
  PDF; it never renders one, so the viewer assets are not copied.

  Run after changing the pdfjs-dist version:  node tools/vendor-pdfjs.mjs
*/

import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "node_modules", "pdfjs-dist");
const OUT = join(ROOT, "extension", "vendor", "pdfjs");

await mkdir(OUT, { recursive: true });
await cp(join(SRC, "legacy", "build", "pdf.min.mjs"), join(OUT, "pdf.min.mjs"));
await cp(join(SRC, "legacy", "build", "pdf.worker.min.mjs"), join(OUT, "pdf.worker.min.mjs"));
await cp(join(SRC, "LICENSE"), join(OUT, "LICENSE"));

console.log("pdfjs: vendored pdf.min.mjs, pdf.worker.min.mjs and LICENSE into extension/vendor/pdfjs");
