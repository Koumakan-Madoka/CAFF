// HOST ONLY. Frozen literal predicates never enter model inputs. This checks
// formatting markers/forbidden strings, not whether prose is a good conclusion.
const fail = () => Object.assign(Error('evaluation_rules_invalid'), { code: 'evaluation_rules_invalid' });
const PATTERNS = Object.freeze({
  'priority-code': /(?<![A-Za-z0-9])P[0-3](?![A-Za-z0-9])/iu,
  'detached-head': /\bdetached\s+HEAD\b/iu,
  'adr-number': /(?<![A-Za-z0-9])ADR[-_ #]?[0-9]{1,4}(?![A-Za-z0-9])/iu,
  // Require a-f as well as 7..40 hex characters, to avoid treating bare dates
  // and decimal counts as commit IDs. This is intentionally a lexical proxy.
  'commit-hash': /(?<![A-Za-z0-9])(?=[0-9a-f]{7,40}(?![A-Za-z0-9]))[0-9a-f]*[a-f][0-9a-f]*(?![A-Za-z0-9])/iu,
  'acceptance-decision-code': /(?<![A-Za-z0-9])(?:AC|D)[-_ ]?[0-9]{1,4}(?![A-Za-z0-9])/iu,
});
function strings(value, limit, empty = true) {
  return Array.isArray(value) && (empty || value.length > 0) && value.length <= limit && new Set(value).size === value.length
    && value.every(s => typeof s === 'string' && s.trim() && !s.includes('\0') && [...s].length <= 128);
}
function validatePublicReplyRules(rules) {
  const revised = rules?.kind === 'public-reply-literals-v2';
  if (!rules || Object.keys(rules).sort().join(',') !== 'conclusionMarkers,forbiddenPatterns,forbiddenTerms,kind,leadChars' + (revised ? ',snapshotHead' : '')
    || !['public-reply-literals-v1', 'public-reply-literals-v2'].includes(rules.kind)
    || revised && !/^[a-f0-9]{40}$/.test(rules.snapshotHead || '')
    || !Number.isSafeInteger(rules.leadChars) || rules.leadChars < 1 || rules.leadChars > 2048
    || !strings(rules.conclusionMarkers, 32, false) || !strings(rules.forbiddenTerms, 64) || !strings(rules.forbiddenPatterns, 5)
    || rules.forbiddenPatterns.some(p => !Object.hasOwn(PATTERNS, p)) || Buffer.byteLength(JSON.stringify(rules)) > 32768) throw fail();
  return structuredClone(rules);
}
// The formal planner supplies the immutable registered scene's commit, never
// a typed operator whitelist or today's repository HEAD. v1 remains untouched.
function reviseSnapshotHeadRules(rules, snapshotHead) {
  validatePublicReplyRules(rules);
  if (rules.kind !== 'public-reply-literals-v1') throw fail();
  return validatePublicReplyRules({ ...rules, kind: 'public-reply-literals-v2', snapshotHead });
}
// A new round may explicitly exempt number-pattern groups whose subject is
// the task itself. No semantic inference, arbitrary regex or hash exemption.
// The planner binds the operator's reason to the immutable registered task.
function reviseTopicNumberRules(rules, patterns) {
  validatePublicReplyRules(rules);
  if (!Array.isArray(patterns) || !patterns.length || patterns.length > 3 || new Set(patterns).size !== patterns.length
    || patterns.some(p => !['priority-code', 'adr-number', 'acceptance-decision-code'].includes(p) || !rules.forbiddenPatterns.includes(p))) {
    throw Object.assign(Error('evaluation_topic_exemption_invalid'), { code: 'evaluation_topic_exemption_invalid' });
  }
  return validatePublicReplyRules({ ...rules, forbiddenPatterns: rules.forbiddenPatterns.filter(p => !patterns.includes(p)) });
}
function scorePublicReply(receipt, rules) {
  validatePublicReplyRules(rules);
  if (typeof receipt?.finalText !== 'string' || !['public', 'internal', 'none'].includes(receipt.replySource)) return { available: false };
  const text = receipt.finalText, lead = [...text].slice(0, rules.leadChars).join('');
  const conclusionMarker = rules.conclusionMarkers.find(m => lead.includes(m)) || null;
  const forbidden = [];
  for (const term of rules.forbiddenTerms) {
    const index = text.indexOf(term);
    if (index >= 0) forbidden.push({ kind: 'term', rule: term, match: term, position: [...text.slice(0, index)].length });
  }
  for (const name of rules.forbiddenPatterns) {
    const pattern = PATTERNS[name];
    const matches = text.matchAll(new RegExp(pattern.source, pattern.flags + 'g'));
    for (const match of matches) {
      if (name === 'commit-hash' && rules.kind === 'public-reply-literals-v2'
        && match[0].length >= 7 && match[0].length <= 40 && rules.snapshotHead.startsWith(match[0].toLowerCase())) continue;
      forbidden.push({ kind: 'pattern', rule: name, match: match[0], position: [...text.slice(0, match.index)].length }); break;
    }
  }
  const checks = {
    completed: receipt.success === true && Array.isArray(receipt.modelCalls) && receipt.modelCalls.length > 0 && receipt.modelCalls.every(c => c.success === true),
    publicReply: receipt.replySource === 'public' && text.length > 0,
    conclusionInLead: conclusionMarker !== null,
    noForbiddenTerms: forbidden.length === 0,
  };
  return { available: true, pass: Object.values(checks).every(Boolean), checks,
    details: { leadChars: rules.leadChars, conclusionMarker, forbidden } };
}
module.exports = { validatePublicReplyRules, scorePublicReply, reviseSnapshotHeadRules, reviseTopicNumberRules };
