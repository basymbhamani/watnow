// Finds and fetches course outlines from D2L/CourseLink Content,
// and extracts in-person midterms, tests, and deliverables.

import { parseOutline } from "./outline-parser.js";

const OUTLINE_TITLE_RE = /\b(?:course\s+outline|syllabus|course\s+information|course\s+schedule|evaluation\s+scheme)\b/i;

/**
 * Recursively searches a D2L Content Table of Contents for outline topics.
 *
 * @param {object} toc - The TableOfContents object from /d2l/api/le/{le}/{ou}/content/toc
 * @returns {Array} List of matching topic candidates { topicId, title, url, type }
 */
export function findOutlineTopics(toc) {
  const matches = [];

  function walkModules(modules = []) {
    for (const mod of modules) {
      if (mod.Topics && Array.isArray(mod.Topics)) {
        for (const top of mod.Topics) {
          if (top && top.Title && OUTLINE_TITLE_RE.test(top.Title)) {
            matches.push({
              topicId: top.TopicId,
              title: top.Title,
              url: top.Url,
              type: top.TypeIdentifier || "File",
            });
          }
        }
      }
      if (mod.Modules && Array.isArray(mod.Modules)) {
        walkModules(mod.Modules);
      }
    }
  }

  if (toc && toc.Modules) {
    walkModules(toc.Modules);
  }

  return matches;
}

/**
 * Fetches outline content from D2L and parses candidate assessment items.
 *
 * @param {object} source - LiveSource instance
 * @param {object} course - Course object ({ id, orgUnitId, code, name })
 * @param {Array} existingItems - Items already synced from CourseLink for this course
 * @returns {Promise<{ found: boolean, topic: object|null, items: Array, rawText: string|null }>}
 */
export async function scanCourseOutline(source, course, existingItems = []) {
  if (!source || !course || !course.orgUnitId) {
    return { found: false, topic: null, items: [], rawText: null, reason: "invalid-course" };
  }

  const { le } = await source.ensureVersions();
  const ou = course.orgUnitId;

  // 1. Fetch Table of Contents
  let toc;
  try {
    toc = await source.api(`/d2l/api/le/${le}/${ou}/content/toc`);
  } catch (e) {
    return { found: false, topic: null, items: [], rawText: null, reason: `toc-failed: ${e.code || e.message}` };
  }

  const topics = findOutlineTopics(toc);
  if (!topics.length) {
    return { found: false, topic: null, items: [], rawText: null, reason: "no-outline-topic" };
  }

  // 2. Fetch the text of the first matching outline topic
  const topic = topics[0];
  let text = null;

  try {
    // Try reading the topic view page or file endpoint
    text = await source.pageText(`/d2l/le/content/${ou}/viewContent/${topic.topicId}/View`, "worker");
    if (!text || text.length < 50) {
      // Fallback: try direct file text if it is text/html
      text = await source.pageText(`/d2l/api/le/${le}/${ou}/content/topics/${topic.topicId}/file`, "worker");
    }
  } catch (e) {
    return { found: true, topic, items: [], rawText: null, reason: `fetch-failed: ${e.code || e.message}` };
  }

  if (!text || text.length < 50) {
    return { found: true, topic, items: [], rawText: null, reason: "empty-content" };
  }

  // 3. Parse candidates using deterministic parser
  const candidates = parseOutline(text, {
    course,
    existingItems,
    defaultYear: new Date().getFullYear(),
  });

  return {
    found: true,
    topic,
    items: candidates,
    rawText: text,
    reason: null,
  };
}
