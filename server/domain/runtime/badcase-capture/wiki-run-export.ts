// Current accounting plus the exact immutable evidence; never rewrite a legacy
// result to hide the rules under which it was originally recorded.
export function wikiRunMarkdown(packet: any) {
  const a = packet.accounting;
  const codeJudged = !!packet.result?.checks && !packet.result?.report?.assessment;
  const label = ({ reached: '有效输出（未判分）', pass: '已判通过' + (codeJudged ? '（代码判断）' : ''),
    fail: '已判失败' + (codeJudged ? '（代码判断）' : ''), invalid: '无效，不算通过也不算不通过',
    error: a.reportOnly ? '技术错误' : '请求失败', reserved: '结果未知' } as any)[a.status] || '未知分类';
  const text = JSON.stringify(packet, null, 2);
  const runs: string[] = text.match(/`+/g) || [];
  const fence = '`'.repeat(runs.reduce((max, s) => Math.max(max, s.length), 2) + 1);
  return ['# Badcase 单次 run 级回放', '', '当前分类：' + label + '。',
    a.reportOnly ? '只出报告，不作采纳依据；不进门槛统计。' : '',
    a.excludedReason ? '已被用户改判，不计入；历史回放原文保留。' : a.baselineStatus === 'no_valid_output' ? '原版无有效输出：无效测试用例，不进门槛和初筛。' : '', '',
    '> accounting 是当前规则的只读投影，不是一次新的判分；pass/fail 展示已记录的判定，reached 仍待判分，不代替正式批次结论。reservation/result 是核验 hash 后的原始包；历史分类字段仅供审计，不参与当前计数。工具执行次数见原始记录。', '',
    fence + 'json', text, fence, ''].join('\n');
}
