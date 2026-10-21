const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

function readPublic(relativePath) {
  return fs.readFileSync(path.join(ROOT, 'public', relativePath), 'utf8');
}

const timelineSource = readPublic('chat/message-timeline.js');
const appSource = readPublic('app.js');
const stylesSource = readPublic('styles.css');

test('time breakdown toggle sits beside the trace toggle with a sibling section', () => {
  // Button label and class (contract §10: 耗时分析 next to 查看观测时间线).
  assert.match(timelineSource, /isOpen \? '收起耗时分析' : '耗时分析'/u);
  assert.match(timelineSource, /'message-time-breakdown-toggle ghost-button'/u);

  // The toggle is appended in the trace header in both the live-spotlight
  // branch and the normal branch.
  assert.match(timelineSource, /header\.append\(liveSpotlight\);[\s\S]*?header\.append\(breakdownToggle\);/u);
  assert.match(timelineSource, /header\.append\(buildTraceToggleButton\(message\.id, traceState\.open\), breakdownToggle, summaryWrap\);/u);

  // The breakdown section is a sibling element of the trace section in the card.
  assert.match(timelineSource, /card\.append\(meta, failurePanel, crossConversationPanel, recoveryPanel, toolTrace, timeBreakdown, imageGallery/u);
  assert.match(timelineSource, /syncTimeBreakdownSection\(timeBreakdown, message\);/u);
  assert.match(timelineSource, /timeBreakdownSignature,/u);
});

test('time breakdown taxonomy labels match the engineering contract', () => {
  for (const label of ['读', '改', '测', '构建与检查', '流程与汇报', '模型思考', '异常与重试', '未分类']) {
    assert.ok(timelineSource.includes(`'${label}'`), `missing category label ${label}`);
  }

  for (const subcategory of ['上下文重读', '有目的查阅', '产品代码', '文档与证据']) {
    assert.ok(timelineSource.includes(`'${subcategory}'`), `missing subcategory label ${subcategory}`);
  }
});

test('time breakdown view renders key metrics and honest statuses', () => {
  // Key metrics (AC1): first write time, session reuse with reason, full
  // regression pass/fail counts.
  assert.match(timelineSource, /首次改文件：本轮无写入/u);
  assert.match(timelineSource, /首次改文件：\$\{formatBreakdownDuration\(metrics\.firstWriteMs\)\}/u);
  assert.match(timelineSource, /会话复用：无记录/u);
  assert.match(timelineSource, /会话复用：已复用/u);
  assert.match(timelineSource, /会话复用：未复用/u);
  assert.match(timelineSource, /全量回归：\$\{fullRunCount\} 遍，失败 \$\{fullRunFailCount\} 次/u);

  // Honest statuses (AC5): truncated / interrupted / live.
  assert.match(timelineSource, /日志截断，结果不完整/u);
  assert.match(timelineSource, /轮次中断或失败，结果不完整/u);
  assert.match(timelineSource, /轮次仍在进行/u);

  // Refresh affordance for live turns (AC1).
  assert.match(timelineSource, /'message-time-breakdown-refresh ghost-button'/u);
  assert.match(timelineSource, /button\.textContent = '刷新';/u);

  // Open-ended steps are labeled instead of silently dropped (§4).
  assert.match(timelineSource, /'无终点'/u);
});

test('app wires time breakdown state, fetch, and click delegation', () => {
  assert.match(appSource, /messageTimeBreakdownById: new Map\(\)/u);
  assert.match(appSource, /\/messages\/\$\{encodeURIComponent\(messageId\)\}\/time-breakdown/u);
  assert.match(appSource, /timeBreakdownSignatureForMessage,/u);
  assert.match(appSource, /timeBreakdownStateForMessage,/u);

  // A missing record resolves to an honest empty state, not an error (§9).
  assert.match(appSource, /error\.status === 404[\s\S]*?breakdownState\.status = 'empty'/u);

  // Click delegation for both the toggle and the refresh button.
  assert.match(appSource, /event\.target\.closest\('\.message-time-breakdown-toggle'\)/u);
  assert.match(appSource, /event\.target\.closest\('\.message-time-breakdown-refresh'\)/u);
  assert.match(appSource, /toggleMessageTimeBreakdown\(state\.currentConversation\.id, message\)/u);
  assert.match(appSource, /fetchMessageTimeBreakdown\(state\.currentConversation\.id, message, \{ force: true \}\)/u);
});

test('time breakdown styles cover bars, per-category colors, and states', () => {
  assert.match(stylesSource, /\.message-time-breakdown\.hidden\s*\{\s*display:\s*none/u);
  assert.match(stylesSource, /\.message-time-breakdown-bar-track/u);
  assert.match(stylesSource, /\.message-time-breakdown-bar-fill/u);
  assert.match(stylesSource, /\.message-time-breakdown-metrics/u);
  assert.match(stylesSource, /\.message-time-breakdown-steps[\s\S]*?overflow-y:\s*auto/u);

  for (const category of ['read', 'write', 'test', 'build-check', 'process-report', 'thinking', 'exception-retry', 'unclassified']) {
    assert.match(
      stylesSource,
      new RegExp(`\\.message-time-breakdown-bar\\.category-${category} \\.message-time-breakdown-bar-fill`, 'u'),
      `missing bar color for category ${category}`
    );
  }
});
