// Turns a Learn HTML page into plain text. Two shapes are useful:
//
//   htmlToText  one flattened line, inline whitespace collapsed. Used when a
//               caller only checks whether a phrase is present.
//   htmlToLines one line per block (paragraph, table row, list item). Used when
//               the shape of the page carries meaning, for example a course
//               outline read row by row.
//
// Both strip tags. Only the final whitespace pass differs, so a line break the
// page author intended survives in htmlToLines and not in htmlToText.

const BLOCK_TAGS = [
  "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "section", "article", "header",
  "footer", "ul", "ol", "dl", "dt", "dd", "pre", "blockquote", "form",
  "fieldset", "figure", "figcaption", "address", "hr", "main", "nav", "aside",
].join("|");

const BLOCK_CLOSE = new RegExp(`<\\s*/\\s*(?:${BLOCK_TAGS})\\s*>`, "gi");
const BLOCK_OPEN = new RegExp(`<\\s*(?:${BLOCK_TAGS})(?:\\s[^>]*)?/?>`, "gi");
const LINE_BREAK = /<\s*br\s*\/?\s*>/gi;

export function htmlToText(html) {
  return String(html == null ? "" : html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ");
}

export function htmlToLines(html) {
  return String(html == null ? "" : html)
    .replace(LINE_BREAK, "\n")
    .replace(BLOCK_CLOSE, "\n")
    .replace(BLOCK_OPEN, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    // Collapse runs of spaces and tabs, but keep the newlines just added.
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
