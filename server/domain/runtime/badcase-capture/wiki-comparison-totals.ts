// Pure counters shared by immutable result validation and human review.
export function wikiComparisonTotals(cases: any[], repeats: number) {
  cases = cases.filter(c => c.reportOnly !== true);
  return Object.fromEntries(['original', 'candidate'].map(variant => {
    const rows = cases.flatMap(c => c.runs || []).filter(r => r.variant === variant), planned = cases.length * repeats;
    const passed = rows.filter(r => r.status === 'pass').length, failed = rows.filter(r => r.status === 'fail').length, errors = rows.filter(r => r.status === 'error').length;
    const staged = cases.some(c => c.stage === 'gate' || c.stage === 'test');
    // Historical trace rubrics could co-freeze an ignored toolCheck. Only the
    // new assessment marker (or existing run level) widens the counter shape.
    const reportsInvalid = cases.some(c => c.execution?.level === 'run' || c.runs?.some((r: any) => r.assessment?.tool));
    return [variant, { planned, attempted: rows.length, passed, failed, errors, ...(reportsInvalid ? { invalid: rows.filter(r => r.status === 'invalid').length } : {}), notRun: planned - (staged ? passed + failed : rows.length),
      scored: passed + failed, passRate: passed + failed ? passed / (passed + failed) : null, plannedPassRate: planned ? passed / planned : null }];
  }));
}
