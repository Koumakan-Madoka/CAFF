// Render only a verified, already-redacted Wiki packet. No source lookups,
// additional redaction, truncation, generated timestamps or scene file bytes.
export function wikiTraceMarkdown(bundle: any) {
  const { context, steps, metrics, scene, ...metadata } = bundle;
  const block = (value: any) => {
    const text = JSON.stringify(value, null, 2);
    const runs: string[] = text.match(/`+/g) || [];
    const longest = runs.reduce((max, s) => Math.max(max, s.length), 2);
    const fence = '`'.repeat(longest + 1);
    return fence + 'json\n' + text + '\n' + fence;
  };
  const lines = ['# Badcase 冻结轨迹包', '', '> 内容来自冻结包；缺失原因保留，不补造历史。现场仅含清单，不含文件内容。', '',
    '## 包信息', '', block(metadata), '', '## 上下文', '', block(context), '', '## 轨迹', ''];
  for (const step of steps) lines.push('### 模型调用 #' + step.step + (step.step === bundle.markedStep ? ' · 发出被标记消息' : ''), '', block(step), '');
  if (!steps.length) lines.push('没有可确认的当轮模型步骤；见包信息中的缺失原因。', '');
  lines.push('### 耗时与用量', '', block(metrics), '', '## 现场', '', block(scene), '');
  return lines.join('\n');
}
