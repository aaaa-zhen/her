/**
 * Edit diff utilities — fuzzy matching, BOM handling, line ending preservation.
 * Ported from pi-mono's edit-diff.ts (simplified for Node.js/CommonJS).
 */

function detectLineEnding(content) {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text, ending) {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content) {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

/**
 * Normalize text for fuzzy matching:
 * - Strip trailing whitespace per line
 * - Smart quotes → ASCII
 * - Unicode dashes → hyphen
 * - Special spaces → regular space
 */
function normalizeForFuzzyMatch(text) {
  return text
    .normalize("NFKC")
    .split("\n").map(l => l.trimEnd()).join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/**
 * Find oldText in content — exact match first, then fuzzy.
 * Returns { found, index, matchLength, usedFuzzyMatch, contentForReplacement }
 */
function fuzzyFindText(content, oldText) {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false, contentForReplacement: content };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
  }
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true, contentForReplacement: fuzzyContent };
}

module.exports = {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  normalizeForFuzzyMatch,
  fuzzyFindText,
};
