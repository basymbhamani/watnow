// Parses course outline text/HTML to extract in-person midterms, tests,
// and exams not already present in CourseLink/D2L.

const MONTHS = {
  jan: 0, january: 0, janurary: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const MONTH_NAMES = "(?:Jan(?:uary|urary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

// "October 11, 2026", "Oct 16", "Oct 16th", "11 October 2026", "16th Oct"
const DATE_MDY = new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`, "gi");
const DATE_DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?(?:\\s*,?\\s*(\\d{4}))?\\b`, "gi");

// "5:30-6:50 PM", "8:30 a.m.", "7:00 PM", "19:00"
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(?:-\s*(\d{1,2})(?::(\d{2}))?)?\s*(am|pm|a\.m\.|p\.m\.)\b/i;

// Unscheduled markers to ignore
const TBA_RE = /\b(?:tba|tbd|to\s+be\s+announced|refer\s+to\s+webadvisor|scheduled\s+by\s+(?:the\s+)?registrar|university('s)?\s+final\s+exam\s+period)\b/i;

// Administrative noise headers to ignore
const EXCLUDE_LINES_RE = /\b(?:policy|policies|missed|deferred|procedure|guideline|accommodation|rules?|calculator|textbook|marking\s+scheme|feedback|questionnaire|office\s+hours|drop\s+date|reading\s+week|syllabus|academic\s+integrity|breakdown)\b/i;

// Target assessments (in-person tests, midterms, lab tests, final exams)
const ASSESSMENT_KW_RE = /\b(midterm(?:\s+(?:exam|examination|test))?|term\s+test|lab\s+(?:test|exam)|in-?(?:class|lab|person)\s+(?:test|quiz|exam)|final\s+exam(?:ination)?)\b/i;

const LOCATION_RE = /\b(?:in[-\s]+(?:class|person|[A-Z]{2,4}\s*\d{2,4}[A-Z]?))\b/i;
const WEIGHT_RE = /\b(\d{1,2})\s*%/;

/**
 * Determines category from title to match WATnow's categories:
 * "assignment", "lab", "quiz", "discussion", "content".
 */
export function categoryFromTitle(title) {
  const t = String(title || "");
  if (/\blab\b/i.test(t)) return "lab";
  if (/\b(?:quiz|test|midterm|exam)\b/i.test(t)) return "quiz";
  if (/\b(?:assignment|presentation|project|report|deliverable|proposal|essay)\b/i.test(t)) return "assignment";
  return "content";
}

/**
 * Normalizes title for deduplication against D2L items.
 * "Midterm Exam #1 (25%)" -> "midterm 1 test"
 * "Assignment 1 - Due Oct 5" -> "assignment 1"
 */
export function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\s*\(?\d+%\)?/g, "")
    .replace(/#\s*(\d+)/g, "$1")
    .replace(/\b(?:examination|exam|test)\b/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts date objects from a text string.
 */
function extractDates(str, defaultYear) {
  const dates = [];
  let m;

  DATE_MDY.lastIndex = 0;
  while ((m = DATE_MDY.exec(str)) !== null) {
    const monStr = m[1].toLowerCase();
    const day = parseInt(m[2], 10);
    const yr = m[3] ? parseInt(m[3], 10) : defaultYear;
    if (MONTHS[monStr] !== undefined && day >= 1 && day <= 31) {
      dates.push({ index: m.index, month: MONTHS[monStr], day, year: yr, raw: m[0] });
    }
  }

  DATE_DMY.lastIndex = 0;
  while ((m = DATE_DMY.exec(str)) !== null) {
    const day = parseInt(m[1], 10);
    const monStr = m[2].toLowerCase();
    const yr = m[3] ? parseInt(m[3], 10) : defaultYear;
    if (MONTHS[monStr] !== undefined && day >= 1 && day <= 31) {
      // Avoid duplicate matches at the exact same location
      if (!dates.some((d) => Math.abs(d.index - m.index) < 3)) {
        dates.push({ index: m.index, month: MONTHS[monStr], day, year: yr, raw: m[0] });
      }
    }
  }

  dates.sort((a, b) => a.index - b.index);
  return dates;
}

/**
 * Extracts time (hour, minute) from text. Defaults to 23:59 if no time found.
 */
function extractTime(str) {
  const m = str.match(TIME_RE);
  if (!m) return { hour: 23, minute: 59, specified: false, raw: null };

  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[5].replace(/\./g, "").toLowerCase();

  if (ampm === "pm" && h < 12) h += 12;
  else if (ampm === "am" && h === 12) h = 0;

  return { hour: h, minute: min, specified: true, raw: m[0] };
}

/**
 * Formats a local date and time as an ISO string.
 */
function toIsoDate(year, month, day, hour, minute) {
  const d = new Date(year, month, day, hour, minute, 0, 0);
  return d.toISOString();
}

export function toLocalDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Checks if a candidate item matches any existing D2L item.
 */
export function isDuplicateItem(candidate, existingItems = []) {
  const normCandidate = normalizeTitle(candidate.title);
  const candDate = toLocalDay(candidate.dueAt);
  const numCand = (normCandidate.match(/\b\d+\b/) || [])[0];

  for (const ex of existingItems) {
    const normExisting = normalizeTitle(ex.title);
    const exDate = toLocalDay(ex.dueAt);
    const numEx = (normExisting.match(/\b\d+\b/) || [])[0];

    // If both have explicit item numbers and they differ (e.g. "1" vs "2"), they are different items
    if (numCand && numEx && numCand !== numEx) {
      continue;
    }

    // Rule 1: Exact normalized title match (e.g. "midterm 1" === "midterm 1")
    if (normCandidate && normExisting && normCandidate === normExisting) {
      return { isDuplicate: true, duplicateOf: ex.title || ex.id, reason: "title_match" };
    }

    // Rule 2: Title substring match only if item numbers agree (or both absent)
    // and dates are not conflicting on different days
    if (normCandidate && normExisting && numCand === numEx) {
      if (normCandidate.includes(normExisting) || normExisting.includes(normCandidate)) {
        if (!candDate || !exDate || candDate === exDate) {
          return { isDuplicate: true, duplicateOf: ex.title || ex.id, reason: "title_match" };
        }
      }
    }

    // Rule 3: Same calendar day + matching assessment type (e.g. in-person test matches LMS test entry)
    if (candDate && exDate && candDate === exDate) {
      const isTestA = /\b(?:test|midterm|exam|quiz)\b/i.test(candidate.title);
      const isTestB = /\b(?:test|midterm|exam|quiz)\b/i.test(ex.title);
      if (isTestA && isTestB) {
        return { isDuplicate: true, duplicateOf: ex.title || ex.id, reason: "same_day_assessment" };
      }
    }
  }

  return { isDuplicate: false, duplicateOf: null, reason: null };
}

/**
 * Parses outline text to extract in-person midterms/tests.
 *
 * @param {string} text - Raw outline text or HTML
 * @param {object} options
 * @param {object} [options.course] - Course object ({ id, code, name })
 * @param {Array} [options.existingItems] - Already synced items from CourseLink
 * @param {number} [options.defaultYear] - Fallback year (e.g. 2026)
 * @returns {Array} List of extracted assessment items
 */
export function parseOutline(text, options = {}) {
  const { course = { id: "custom", code: "" }, existingItems = [], defaultYear = new Date().getFullYear() } = options;
  if (!text || typeof text !== "string") return [];

  // Strip HTML tags if HTML is provided
  const plainText = text.replace(/<[^>]+>/g, " ");
  const lines = plainText.split(/\r?\n/);
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.length < 5 || raw.length > 300) continue;

    // Must mention an assessment keyword
    const kwMatch = raw.match(ASSESSMENT_KW_RE);
    if (!kwMatch) continue;

    // Skip administrative lines and policies
    if (EXCLUDE_LINES_RE.test(raw)) continue;

    // Skip lines marked as TBA/TBD
    if (TBA_RE.test(raw)) continue;

    // Look at current line, plus next line if it carries date/time info
    let target = raw;
    if (i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (next.length > 0 && next.length < 80 && (DATE_MDY.test(next) || DATE_DMY.test(next))) {
        target = `${raw} ${next}`;
      }
    }

    const dates = extractDates(target, defaultYear);
    if (!dates.length) continue;

    const time = extractTime(target);
    const weightMatch = target.match(WEIGHT_RE);
    const locMatch = target.match(LOCATION_RE);

    let rawTitle = kwMatch[0].trim();
    // Check if an item number follows (e.g. "Midterm 1", "Term Test 2")
    const numMatch = target.match(new RegExp(`${rawTitle.replace(/\s+/g, "\\s+")}\\s*(?:#|no\\.?|exam\\s*)?\\s*(\\d+)`, "i"));
    let title = numMatch ? `${rawTitle} ${numMatch[1]}` : rawTitle;
    title = title.replace(/\b\w/g, (c) => c.toUpperCase());

    // Edge case: Multiple midterms on one line (e.g. "Midterm 1 & 2 : Feb 12 and March 18")
    if (dates.length > 1 && /\b(?:1\s*(?:&|and)\s*2|two\s+midterm)/i.test(target)) {
      for (let dIdx = 0; dIdx < Math.min(dates.length, 2); dIdx++) {
        const dt = dates[dIdx];
        const subTitle = `Midterm ${dIdx + 1}`;
        candidates.push({
          title: subTitle,
          month: dt.month,
          day: dt.day,
          year: dt.year,
          hour: time.hour,
          minute: time.minute,
          timeSpecified: time.specified,
          timeRaw: time.raw,
          weight: weightMatch ? `${weightMatch[1]}%` : null,
          location: locMatch ? locMatch[0].replace(/^in[-\s]+/i, "") : null,
          rawLine: raw,
        });
      }
    } else {
      const dt = dates[0];
      candidates.push({
        title,
        month: dt.month,
        day: dt.day,
        year: dt.year,
        hour: time.hour,
        minute: time.minute,
        timeSpecified: time.specified,
        timeRaw: time.raw,
        weight: weightMatch ? `${weightMatch[1]}%` : null,
        location: locMatch ? locMatch[0].replace(/^in[-\s]+/i, "") : null,
        rawLine: raw,
      });
    }
  }

  // Deduplicate candidates among themselves
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const key = `${c.title.toLowerCase()}|${c.year}-${c.month}-${c.day}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  // Convert to WATnow item schema and run deduplication against existing D2L items
  return unique.map((c, idx) => {
    const dueAt = toIsoDate(c.year, c.month, c.day, c.hour, c.minute);
    const slug = `${c.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${c.year}${c.month + 1}${c.day}`;
    const id = `outline:${course.id || "c"}:${slug}`;

    const cat = categoryFromTitle(c.title);
    const candidateItem = {
      id,
      courseId: course.id,
      kind: cat,
      category: cat,
      title: c.title,
      dueAt,
      dueField: "event",
      url: null,
      status: "open",
      completedAt: null,
      moved: null,
      seenIn: ["outline"],
      timeSpecified: c.timeSpecified,
      timeRaw: c.timeRaw,
      weight: c.weight,
      location: c.location,
      rawLine: c.rawLine,
    };

    const dup = isDuplicateItem(candidateItem, existingItems);
    candidateItem.isDuplicate = dup.isDuplicate;
    candidateItem.duplicateOf = dup.duplicateOf;
    candidateItem.duplicateReason = dup.reason;

    return candidateItem;
  });
}
