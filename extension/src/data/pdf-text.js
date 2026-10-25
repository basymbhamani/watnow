// Reads text from a PDF with pdf.js.
//
// The bytes stay in memory. Nothing is written to disk, nothing goes to
// extension storage, and the bytes are released after the text is extracted.
// Only the text is returned, and the caller keeps only the parsed rows.
//
// pdf.js is vendored in extension/vendor/pdfjs (see tools/vendor-pdfjs.mjs).
// The worker is pointed at an extension URL so the browser can spawn it. A
// plain Node caller can pass the module in instead, or pass a workerSrc.

const PDF_MODULE = "../../vendor/pdfjs/pdf.min.mjs";
const PDF_WORKER_MODULE = "../../vendor/pdfjs/pdf.worker.min.mjs";
// Same directory as pdf.min.mjs. Resolving it here works in the extension (an
// extension:// URL) and in a plain Node test (a file:// URL), so no
// chrome.runtime call is needed.
const PDF_WORKER = new URL(PDF_WORKER_MODULE, import.meta.url).href;

let cached = null;

/** Loads the vendored pdf.js once and points it at its worker. */
export async function loadPdfjs(workerSrc = PDF_WORKER) {
  if (!cached) {
    const mod = await import(PDF_MODULE);
    // Node has no Worker, so pdf.js runs an in-process "fake worker". Its
    // default fallback imports a pdf.worker.mjs that the extension does not
    // ship, so hand it the worker module directly instead.
    if (typeof window === "undefined" && !globalThis.pdfjsWorker) {
      globalThis.pdfjsWorker = await import(PDF_WORKER_MODULE);
    }
    if (mod.GlobalWorkerOptions && !mod.GlobalWorkerOptions.workerSrc) {
      mod.GlobalWorkerOptions.workerSrc = workerSrc;
    }
    cached = mod;
  }
  return cached;
}

// Rebuilds lines from text items. pdf.js gives each run with its position, so
// a change in the y coordinate (down the page) or an end-of-line marker starts
// a new line. This matters because the parser reads one assessment row per
// line, and a table row would otherwise merge with its neighbours.
function rowsFromItems(items) {
  const rows = [];
  let text = "";
  let y = null;

  const flush = () => {
    const row = text.replace(/\s+/g, " ").trim();
    if (row) rows.push(row);
    text = "";
  };

  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const itemY = item.transform ? item.transform[5] : null;
    if (y !== null && itemY !== null && Math.abs(itemY - y) > 2) flush();
    text += item.str;
    if (itemY !== null) y = itemY;
    if (item.hasEOL) {
      flush();
      y = null;
    }
  }
  flush();
  return rows;
}

/**
 * Extracts the text of every page, one line per text row.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{pdfjs?: object, workerSrc?: string}} [opts] - pdfjs is injected by
 *   tests. workerSrc is only used in a browser.
 * @returns {Promise<string>}
 */
export async function pdfBytesToText(bytes, opts = {}) {
  const lib = opts.pdfjs || (await loadPdfjs(opts.workerSrc));
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const task = lib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        pages.push(rowsFromItems(content.items).join("\n"));
      } finally {
        page.cleanup();
      }
    }
    return pages.join("\n");
  } finally {
    await task.destroy();
  }
}
