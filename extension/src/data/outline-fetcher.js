// Finds and fetches course outlines from D2L/CourseLink Content,
// and extracts in-person midterms, tests, and deliverables.

import { parseOutline } from "./outline-parser.js";

const OUTLINE_TITLE_RE = /\b(?:course\s+outline|syllabus|course\s+information|course\s+schedule|evaluation\s+scheme|evaluation\s+breakdown|method\s+and\s+timing\s+of\s+evaluation)\b/i;

// A topic that is probably inline text we can read, rather than a download.
const TEXT_TOPIC_RE = /\.(?:html?|txt|xml)$/i;

// Below this many characters the page is almost certainly a shell or a stub.
const MIN_OUTLINE_CHARS = 50;

// How many candidate topics to try before giving up on the automatic scan.
const MAX_TOPICS = 4;

/** Ranks topics so text/HTML ones are tried before binary downloads. */
function scoreTopic(topic) {
  let score = 0;
  const type = String(topic.type || "").toLowerCase();
  if (type.includes("html") || type.includes("contentobject") || type.includes("file")) score += 1;
  if (topic.url && TEXT_TOPIC_RE.test(topic.url)) score += 4;
  if (topic.url && /\.pdf$/i.test(topic.url)) score -= 2;
  return score;
}

/**
 * Recursively searches a D2L Content Table of Contents for outline topics.
 * A module named like an outline (a "Course Outline" folder) is treated as a
 * match too, so its topics are returned even when the topics themselves aren't
 * named that way.
 *
 * @param {object} toc - The TableOfContents object from /d2l/api/le/{le}/{ou}/content/toc
 * @returns {Array} List of matching topic candidates { topicId, title, url, type }
 */
export function findOutlineTopics(toc) {
  const matches = [];
  const seen = new Set();

  function addTopic(top) {
    if (!top || top.TopicId == null) return;
    const key = String(top.TopicId);
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({
      topicId: top.TopicId,
      title: top.Title || "",
      url: top.Url || null,
      type: top.TypeIdentifier || "File",
    });
  }

  function collectTopics(mod, out) {
    for (const top of mod.Topics || []) out.push(top);
    for (const child of mod.Modules || []) collectTopics(child, out);
  }

  function walkModules(modules = []) {
    for (const mod of modules) {
      if (!mod) continue;
      if (mod.Title && OUTLINE_TITLE_RE.test(mod.Title)) {
        // Outline-named module: take every topic it holds, anywhere inside it.
        const out = [];
        collectTopics(mod, out);
        for (const top of out) addTopic(top);
      } else {
        for (const top of mod.Topics || []) {
          if (top && top.Title && OUTLINE_TITLE_RE.test(top.Title)) addTopic(top);
        }
      }
      if (mod.Modules) walkModules(mod.Modules);
    }
  }

  if (toc && Array.isArray(toc.Modules)) walkModules(toc.Modules);

  matches.sort((a, b) => scoreTopic(b) - scoreTopic(a));
  return matches;
}

/** The content API path that serves a topic's file, used for a PDF outline. */
function fileEndpoint(le, ou, topicId) {
  return `/d2l/api/le/${le}/${ou}/content/topics/${topicId}/file`;
}

/** Absolute D2L URLs become relative paths so pageText can prefix the base. */
function toRelativePath(url) {
  if (!url) return null;
  try {
    if (/^https?:\/\//i.test(url)) {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    }
    return url.startsWith("/") ? url : `/${url}`;
  } catch {
    return null;
  }
}

/**
 * Drops obvious binary payloads (a PDF read as text) so they don't get parsed
 * as an outline, and trims control characters.
 */
function cleanOutlineText(text) {
  if (!text) return null;
  if (/^\s*%PDF/i.test(text)) return null;
  let printable = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) printable++;
  }
  if (text.length && printable / text.length < 0.5) return null;
  return text;
}

/**
 * Reads a topic's text, trying the topic's own URL first, then the content
 * viewer, then the raw file endpoint. Returns null when nothing readable came
 * back. Rethrows a signed-out error so the caller can report it.
 */
async function fetchTopicText(source, ou, le, topic) {
  // Prefer the reader that keeps one line per block, so a table row stays one
  // line. Fall back to the flattened reader for a source that only has that.
  const read = typeof source.pageRows === "function"
    ? (path) => source.pageRows(path, "worker")
    : (path) => source.pageText(path, "worker");

  const candidates = [];
  const ownPath = toRelativePath(topic.url);
  if (ownPath) candidates.push(ownPath);
  candidates.push(`/d2l/le/content/${ou}/viewContent/${topic.topicId}/View`);
  candidates.push(`/d2l/api/le/${le}/${ou}/content/topics/${topic.topicId}/file`);

  for (const path of candidates) {
    let text;
    try {
      text = await read(path);
    } catch (e) {
      if (e && e.code === "signed-out") throw e;
      continue;
    }
    const clean = cleanOutlineText(text);
    if (clean && clean.trim().length >= MIN_OUTLINE_CHARS) return clean;
  }
  return null;
}

/**
 * Fetches outline content from D2L and parses candidate assessment items.
 *
 * @param {object} source - LiveSource instance
 * @param {object} course - Course object ({ id, orgUnitId, code, name })
 * @param {Array} existingItems - Items already synced from CourseLink for this course
 * @returns {Promise<{ found: boolean, topic: object|null, items: Array, rawText: string|null, reason: string|null }>}
 */
export async function scanCourseOutline(source, course, existingItems = []) {
  const canReadPages = typeof source?.pageRows === "function" || typeof source?.pageText === "function";
  if (!source || typeof source.ensureVersions !== "function" || typeof source.api !== "function" || !canReadPages) {
    return { found: false, topic: null, items: [], rawText: null, reason: "unsupported-source" };
  }
  if (!course || course.orgUnitId == null) {
    return { found: false, topic: null, items: [], rawText: null, reason: "invalid-course" };
  }

  const { le } = await source.ensureVersions();
  const ou = course.orgUnitId;

  // 1. Fetch Table of Contents
  let toc;
  try {
    toc = await source.api(`/d2l/api/le/${le}/${ou}/content/toc`);
  } catch (e) {
    // A signed-out session is not a read failure to report as "no outline";
    // let it through so the caller can ask the user to sign in.
    if (e && e.code === "signed-out") throw e;
    return { found: false, topic: null, items: [], rawText: null, reason: `toc-failed: ${e.code || e.message}` };
  }

  const topics = findOutlineTopics(toc);
  if (!topics.length) {
    return { found: false, topic: null, items: [], rawText: null, reason: "no-outline-topic" };
  }

  // 2. Read the first topic that yields usable text
  let text = null;
  let usedTopic = null;
  for (const topic of topics.slice(0, MAX_TOPICS)) {
    let candidate;
    try {
      candidate = await fetchTopicText(source, ou, le, topic);
    } catch (e) {
      if (e && e.code === "signed-out") throw e;
      return { found: true, topic, items: [], rawText: null, reason: `fetch-failed: ${e.code || e.message}` };
    }
    if (candidate) {
      text = candidate;
      usedTopic = topic;
      break;
    }
  }

  // No readable text: hand back the topic's file so the caller can try a PDF.
  if (!text) {
    const topic = topics[0];
    return {
      found: true,
      topic,
      items: [],
      rawText: null,
      reason: "empty-content",
      filePath: fileEndpoint(le, ou, topic.topicId),
    };
  }

  // 3. Parse candidates using deterministic parser
  const candidates = parseOutline(text, {
    course,
    existingItems,
    defaultYear: new Date().getFullYear(),
  });

  const chosen = usedTopic || topics[0];
  const readable = candidates.length > 0;
  return {
    found: true,
    topic: chosen,
    items: candidates,
    rawText: text,
    reason: readable ? null : "no-assessments",
    // Nothing parsed from the page text, so the topic may be a PDF to try.
    filePath: readable ? null : fileEndpoint(le, ou, chosen.topicId),
  };
}
