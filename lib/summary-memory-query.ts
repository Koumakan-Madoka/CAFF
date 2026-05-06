const SUMMARY_MEMORY_QUERY_TOKEN_RE = /[\p{L}\p{N}_-]+/gu;
const SUMMARY_MEMORY_QUERY_SEGMENT_RE = /^[\p{L}\p{N}_-]+$/u;
const SUMMARY_MEMORY_CJK_RE = /\p{Script=Han}/u;

let cjkWordSegmenter: any = null;
let cjkWordSegmenterLoaded = false;

function normalizeSummaryMemorySearchQuery(value: any) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function getCjkWordSegmenter() {
  if (cjkWordSegmenterLoaded) {
    return cjkWordSegmenter;
  }

  cjkWordSegmenterLoaded = true;

  try {
    const Segmenter = (Intl as any).Segmenter;
    cjkWordSegmenter = typeof Segmenter === 'function'
      ? new Segmenter('zh', { granularity: 'word' })
      : null;
  } catch {
    cjkWordSegmenter = null;
  }

  return cjkWordSegmenter;
}

function trimCjkStopTermEdges(value: string, stopTerms: Set<string>) {
  let output = String(value || '').trim();
  let changed = true;

  while (changed && output) {
    changed = false;

    for (const stopTermValue of stopTerms) {
      const stopTerm = String(stopTermValue || '').trim();

      if (stopTerm.length < 2 || !SUMMARY_MEMORY_CJK_RE.test(stopTerm)) {
        continue;
      }

      if (output.startsWith(stopTerm)) {
        output = output.slice(stopTerm.length);
        changed = true;
      }

      if (output.endsWith(stopTerm)) {
        output = output.slice(0, -stopTerm.length);
        changed = true;
      }
    }
  }

  return output;
}

function buildCjkFallbackSegments(token: string, stopTerms: Set<string>) {
  const segments = [] as string[];
  const parts = String(token || '').match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) || [];

  for (const partValue of parts) {
    const part = String(partValue || '').trim();

    if (!part) {
      continue;
    }

    if (!SUMMARY_MEMORY_CJK_RE.test(part)) {
      if (SUMMARY_MEMORY_QUERY_SEGMENT_RE.test(part)) {
        segments.push(part);
      }
      continue;
    }

    const trimmedPart = trimCjkStopTermEdges(part, stopTerms);

    if (!trimmedPart) {
      continue;
    }

    if (trimmedPart.length <= 2) {
      segments.push(trimmedPart);
      continue;
    }

    for (let index = 0; index < trimmedPart.length - 1; index += 1) {
      segments.push(trimmedPart.slice(index, index + 2));
    }
  }

  return segments;
}

function segmentSummaryMemorySearchToken(token: string, options: any = {}) {
  const normalizedToken = String(token || '').trim();

  if (!normalizedToken || !SUMMARY_MEMORY_CJK_RE.test(normalizedToken)) {
    return normalizedToken ? [normalizedToken] : [];
  }

  const stopTerms = options.stopTerms instanceof Set ? options.stopTerms : new Set();
  const fallbackSegments = buildCjkFallbackSegments(normalizedToken, stopTerms);

  if (options.disableCjkSegmenter) {
    return fallbackSegments.length > 0 ? fallbackSegments : [normalizedToken];
  }

  const segmenter = getCjkWordSegmenter();

  if (!segmenter) {
    return fallbackSegments.length > 0 ? fallbackSegments : [normalizedToken];
  }

  const segments = Array.from(segmenter.segment(normalizedToken))
    .map((part: any) => String(part && part.segment || '').trim())
    .filter((part) => SUMMARY_MEMORY_QUERY_SEGMENT_RE.test(part));

  if (segments.length <= 1 && fallbackSegments.length > segments.length) {
    return fallbackSegments;
  }

  return segments.length > 0 ? segments : fallbackSegments.length > 0 ? fallbackSegments : [normalizedToken];
}

export function extractSummaryMemorySearchTerms(value: any, options: any = {}) {
  const source = normalizeSummaryMemorySearchQuery(value);
  if (!source) {
    return [];
  }

  const maxTerms = Number.isFinite(options.maxTerms) && options.maxTerms > 0
    ? Math.floor(options.maxTerms)
    : 8;
  const minTermLength = Number.isFinite(options.minTermLength) && options.minTermLength > 0
    ? Math.floor(options.minTermLength)
    : 1;
  const stopTerms = options.stopTerms instanceof Set ? options.stopTerms : new Set();
  const seen = new Set();
  const terms = [] as string[];
  const tokens = source.match(SUMMARY_MEMORY_QUERY_TOKEN_RE) || [];

  for (const token of tokens) {
    for (const termValue of segmentSummaryMemorySearchToken(token, options)) {
      const term = String(termValue || '').trim();
      const normalizedTerm = term.toLocaleLowerCase();

      if (
        !term ||
        term.length < minTermLength ||
        stopTerms.has(normalizedTerm) ||
        seen.has(normalizedTerm)
      ) {
        continue;
      }

      seen.add(normalizedTerm);
      terms.push(term);

      if (terms.length >= maxTerms) {
        return terms;
      }
    }
  }

  if (terms.length === 0 && source.length >= minTermLength) {
    terms.push(source);
  }

  return terms;
}

export function escapeSummaryMemoryLikePattern(value: any) {
  return String(value || '').replace(/([%_\\])/g, '\\$1');
}

export { normalizeSummaryMemorySearchQuery };
