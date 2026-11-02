// HOST ONLY: literal predicates/reference values never enter the SDK input.
const crypto = require('node:crypto');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const fail = code => Object.assign(Error(code), { code });
const safePath = p => typeof p === 'string' && p.length <= 512 && /^[A-Za-z0-9_.@/-]+$/.test(p)
  && p.split('/').every(s => s && s !== '.' && s !== '..' && s !== '.git');
function validateLiteralRules(rules) {
  if (!rules || rules.kind !== 'file-literals-v1' || Object.keys(rules).sort().join(',') !== 'files,kind'
    || !Array.isArray(rules.files) || !rules.files.length || rules.files.length > 16) throw fail('evaluation_rules_invalid');
  for (const file of rules.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'contains,notContains,path' || !safePath(file.path)
      || !Array.isArray(file.contains) || !Array.isArray(file.notContains) || !(file.contains.length + file.notContains.length)
      || [file.contains, file.notContains].some(a => a.length > 32 || new Set(a).size !== a.length
        || a.some(s => typeof s !== 'string' || !s.trim() || s.includes('\0') || Buffer.byteLength(s) > 1024))) throw fail('evaluation_rules_invalid');
  }
  if (new Set(rules.files.map(f => f.path)).size !== rules.files.length || Buffer.byteLength(JSON.stringify(rules)) > 32768) throw fail('evaluation_rules_invalid');
  return structuredClone(rules);
}
function parseLiteralEvidence(receipt, rules) {
  const evidence = receipt?.fileEvidence;
  if (!Array.isArray(evidence) || evidence.length !== rules.files.length) return null;
  const result = []; let total = 0;
  for (const [i, rule] of rules.files.entries()) {
    const item = evidence[i];
    if (!item || item.path !== rule.path) return null;
    if (item.state === 'missing' && Object.keys(item).sort().join(',') === 'path,state') { result.push({ path: item.path, state: 'missing' }); continue; }
    if (item.state !== 'file' || Object.keys(item).sort().join(',') !== 'base64,path,sha256,size,state'
      || typeof item.base64 !== 'string' || item.base64.length > 87384 || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 65536
      || !/^[a-f0-9]{64}$/.test(item.sha256)) return null;
    const bytes = Buffer.from(item.base64, 'base64'); total += bytes.length;
    const text = bytes.toString('utf8');
    if (total > 262144 || bytes.toString('base64') !== item.base64 || bytes.length !== item.size
      || crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256 || !Buffer.from(text).equals(bytes)
      || text.includes('\0') || containsSecretSentinel(bytes)) return null;
    result.push({ ...item, text });
  }
  return result;
}
function scoreLiteralFiles(receipt, rules) {
  validateLiteralRules(rules);
  const evidence = parseLiteralEvidence(receipt, rules);
  if (!evidence) return { available: false };
  const details = rules.files.map((rule, i) => {
    const file = evidence[i], exists = file.state === 'file';
    return { path: rule.path, exists, contains: exists && rule.contains.every(s => file.text.includes(s)),
      notContains: exists && rule.notContains.every(s => !file.text.includes(s)) };
  });
  const checks = { completed: receipt?.success === true && Array.isArray(receipt.modelCalls) && receipt.modelCalls.length > 0 && receipt.modelCalls.every(c => c.success === true),
    files: details.every(d => d.exists && d.contains && d.notContains) };
  return { available: true, pass: Object.values(checks).every(Boolean), checks, details };
}
module.exports = { validateLiteralRules, parseLiteralEvidence, scoreLiteralFiles };
