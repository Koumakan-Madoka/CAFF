// D16: fixed before observing results. One-sided Fisher, candidate > original.
// Shared by execution and persisted-result verification; no semantic grading.
export function fisherImprovement(originalPass: number, originalN: number, candidatePass: number, candidateN: number): number {
  for (const n of [originalPass, originalN, candidatePass, candidateN]) if (!Number.isSafeInteger(n) || n < 0 || n > 10000) throw Error('wiki_gate_counts_invalid');
  if (originalPass > originalN || candidatePass > candidateN) throw Error('wiki_gate_counts_invalid');
  const choose = (n: number, k: number) => { if (k < 0 || k > n) return -Infinity; let s = 0; for (let i = 1; i <= Math.min(k, n-k); i++) s += Math.log(n-i+1)-Math.log(i); return s; };
  const successes = originalPass + candidatePass, total = originalN + candidateN, denominator = choose(total, candidateN);
  let p = 0;
  for (let x = candidatePass; x <= Math.min(candidateN, successes); x++) p += Math.exp(choose(successes,x)+choose(total-successes,candidateN-x)-denominator);
  return Math.min(1,p);
}
export function decideWikiGate(cases: any[], targetReproductionCaseIds: string[], repeats: number) {
  const gate = cases.filter(c => c.stage === 'gate' && c.reportOnly !== true);
  const totals = (selected: any[]) => Object.fromEntries(['original','candidate'].map(variant => {
    const runs = selected.flatMap(c=>c.runs || []).filter(r=>r.variant===variant && r.status!=='error');
    return [variant,{ passed:runs.filter(r=>r.status==='pass').length, total:runs.length }];
  }));
  const repairCases = gate.filter(c=>c.category==='reproduction' && targetReproductionCaseIds.includes(c.sourceCaseId));
  const repair = totals(repairCases), controls = gate.filter(c=>c.category==='control'), harm = totals(controls);
  const complete = gate.length > 0 && gate.every(c=>c.status==='completed' && ['original','candidate'].every(v=>(c.runs || []).filter((r:any)=>r.variant===v && ['pass','fail'].includes(r.status)).length===repeats));
  const pValue = repairCases.length ? fisherImprovement(repair.original.passed,repair.original.total,repair.candidate.passed,repair.candidate.total) : null;
  const allowedLoss = Math.max(1,harm.original.total*.05), loss = harm.original.passed-harm.candidate.passed;
  const repaired = pValue !== null && pValue < .05 && repair.candidate.passed > repair.original.passed, noHarm = controls.length>0 && loss<=allowedLoss;
  return { policy:'wikiskill-gate-v1', outcome:!complete || !repairCases.length || !controls.length ? 'indeterminate' : repaired && noHarm ? 'accepted' : 'rejected',
    repair:{caseIds:repairCases.map(c=>c.sourceCaseId),...repair,pValue,alpha:.05,passed:repaired},
    noHarm:{caseIds:controls.map(c=>c.sourceCaseId),...harm,allowedLoss,loss,passed:noHarm},
    ignoredCaseIds:gate.filter(c=>!repairCases.includes(c) && !controls.includes(c)).map(c=>c.sourceCaseId) };
}
