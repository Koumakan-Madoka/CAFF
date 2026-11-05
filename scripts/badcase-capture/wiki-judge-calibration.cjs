// Pure calibration summary; no prompt, model call, old literal results or store.
const fail = () => { throw Error('wiki_calibration_invalid'); };
const yes = v => v === 'satisfied';
function decision(result) {
  if (!result || !['pass', 'fail', 'error'].includes(result.status)) fail();
  if (result.status === 'error') return null;
  if (!Array.isArray(result.judgments) || !result.judgments.length || result.judgments.length > 4
    || !Array.isArray(result.votes) || result.votes.length !== 3) fail();
  const ids = result.judgments.map(j => j.criterionId);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))) fail();
  const vector = row => {
    if (!Array.isArray(row) || row.length !== ids.length || new Set(row.map(j => j?.criterionId)).size !== ids.length) fail();
    return ids.map(id => {
      const j = row.find(j => j.criterionId === id);
      if (!j || !['satisfied', 'not-satisfied'].includes(j.verdict)) fail();
      return yes(j.verdict);
    });
  };
  const votes = result.votes.map(vector), majority = vector(result.judgments);
  if (majority.some((v, i) => v !== (votes.filter(row => row[i]).length >= 2)) || (result.status === 'pass') !== majority.every(Boolean)) fail();
  return { values: Object.fromEntries(ids.map((id, i) => [id, majority[i]])), pass: majority.every(Boolean),
    consistent: votes.every(row => row.every((v, i) => v === votes[0][i])), passConsistent: votes.every(row => row.every(Boolean) === votes[0].every(Boolean)) };
}
function metric(correct, total) { return { correct, total, ratio: total ? correct / total : null }; }
function summarizeWikiCalibration({ a, b }) {
  if (!Array.isArray(a) || !a.length || !Array.isArray(b) || !b.length || a.length > 10000 || b.length > 10000) fail();
  const rows = [...a, ...b];
  if (rows.some(r => typeof r.id !== 'string' || !r.id) || new Set(rows.map(r => r.id)).size !== rows.length) fail();
  const sides = { original: [], candidate: [] }, assertions = Object.create(null), compared = [], repeated = [], passRepeated = [];
  const errors = { a: 0, b: 0 };
  let ids;
  for (const row of a) {
    if (!Object.hasOwn(sides, row.side) || !row.human || typeof row.human !== 'object' || Array.isArray(row.human)
      || !Object.keys(row.human).length || Object.values(row.human).some(v => typeof v !== 'boolean')) fail();
    const keys = Object.keys(row.human).sort();
    if (keys.length > 4 || keys.some(id => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))) fail();
    ids ||= keys;
    if (keys.join(',') !== ids.join(',')) fail();
    const d = decision(row.result);
    for (const id of ids) {
      assertions[id] ||= { positive: 0, negative: 0, correct: 0, total: 0 };
      assertions[id][row.human[id] ? 'positive' : 'negative']++;
    }
    if (!d) { errors.a++; continue; }
    if (Object.keys(d.values).sort().join(',') !== ids.join(',')) fail();
    const same = d.pass === Object.values(row.human).every(Boolean);
    compared.push(same); sides[row.side].push(same); repeated.push(d.consistent); passRepeated.push(d.passConsistent);
    for (const id of ids) { assertions[id].total++; assertions[id].correct += Number(d.values[id] === row.human[id]); }
  }
  const knownBad = b.map(row => decision(row.result)); errors.b = knownBad.filter(v => !v).length;
  const overall = metric(compared.filter(Boolean).length, compared.length);
  const sideMetrics = Object.fromEntries(Object.entries(sides).map(([side, values]) => [side, metric(values.filter(Boolean).length, values.length)]));
  const assertionMetrics = Object.fromEntries(Object.entries(assertions).map(([id, v]) => [id, { ...v, ratio: v.total ? v.correct / v.total : null, required: v.positive > 0 && v.negative > 0 }]));
  const repeatedResults = { consistent: repeated.filter(Boolean).length, total: repeated.length, ratio: repeated.length ? repeated.filter(Boolean).length / repeated.length : null };
  const repeatedPassFail = { consistent: passRepeated.filter(Boolean).length, total: passRepeated.length, ratio: passRepeated.length ? passRepeated.filter(Boolean).length / passRepeated.length : null };
  const bad = { detected: knownBad.filter(v => v && !v.pass).length, total: b.length };
  const failures = [];
  if (errors.a || errors.b) failures.push('incomplete');
  if (overall.ratio === null || overall.ratio < 0.9) failures.push('overall');
  for (const [side, v] of Object.entries(sideMetrics)) if (v.ratio === null || v.ratio < 0.85) failures.push('side:' + side);
  for (const [id, v] of Object.entries(assertionMetrics)) if (v.required && (v.ratio === null || v.ratio < 0.9)) failures.push('assertion:' + id);
  if (repeatedResults.ratio === null || repeatedResults.ratio < 0.95) failures.push('repeated-results');
  if (bad.detected !== bad.total) failures.push('known-bad');
  return { kind: 'wiki-judge-calibration-summary-v1', eligible: failures.length === 0, failures, overall, sides: sideMetrics, assertions: assertionMetrics,
    repeatedResults, repeatedPassFail, knownBad: bad, errors };
}
module.exports = { summarizeWikiCalibration };
