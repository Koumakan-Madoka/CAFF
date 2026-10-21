const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseSessionTurnSteps } = require('../../build/server/domain/runtime/turn-time-breakdown');
const { withTempDir } = require('../helpers/temp-dir');

function inTempDir(fn) {
  const dir = withTempDir();

  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assistantLine(timestamp, toolCalls, extra = {}) {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      timestamp,
      content: toolCalls.map((call) => ({
        type: 'toolCall',
        id: call.id,
        name: call.name,
        arguments: call.arguments || {},
      })),
      ...extra,
    },
  });
}

function toolResultLine(timestamp, toolCallId, toolName, text, isError = false) {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName,
      content: [{ type: 'text', text }],
      isError,
      timestamp,
    },
  });
}

function writeSession(agentDir, name, lines) {
  const dir = path.join(agentDir, 'named-sessions');

  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, name);

  fs.writeFileSync(filePath, lines.join('\n') + '\n');

  return filePath;
}

test('parser joins assistant tool_call starts with toolResult ends by toolCallId', () => {
  inTempDir((agentDir) => {
    const sessionPath = writeSession(agentDir, 's.jsonl', [
      assistantLine(1000, [{ id: 'c1', name: 'bash', arguments: { command: 'npm test' } }]),
      toolResultLine(5000, 'c1', 'bash', '# pass 42'),
    ]);

    const parsed = parseSessionTurnSteps(sessionPath, agentDir);

    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].toolCallId, 'c1');
    assert.equal(parsed.steps[0].toolName, 'bash');
    assert.equal(parsed.steps[0].startedAtMs, 1000);
    assert.equal(parsed.steps[0].endedAtMs, 5000);
    assert.equal(parsed.steps[0].durationMs, 4000);
    assert.equal(parsed.steps[0].output, '# pass 42');
    assert.equal(parsed.steps[0].isError, false);
    assert.equal(parsed.steps[0].open, false);
    assert.equal(parsed.steps[0].orphan, false);
    assert.equal(parsed.truncated, false);
  });
});

test('parser shares one start timestamp across parallel calls in one assistant message', () => {
  inTempDir((agentDir) => {
    const sessionPath = writeSession(agentDir, 's.jsonl', [
      assistantLine(2000, [
        { id: 'a', name: 'read', arguments: { path: 'docs/a.md' } },
        { id: 'b', name: 'read', arguments: { path: 'docs/b.md' } },
      ]),
      toolResultLine(2600, 'a', 'read', 'A'),
      toolResultLine(3100, 'b', 'read', 'B'),
    ]);

    const parsed = parseSessionTurnSteps(sessionPath, agentDir);

    assert.equal(parsed.steps.length, 2);
    assert.equal(parsed.steps[0].startedAtMs, 2000);
    assert.equal(parsed.steps[1].startedAtMs, 2000);
    const byId = new Map(parsed.steps.map((step) => [step.toolCallId, step]));

    assert.equal(byId.get('a').durationMs, 600);
    assert.equal(byId.get('b').durationMs, 1100);
  });
});

test('parser records orphan toolResults end-only and flags them', () => {
  inTempDir((agentDir) => {
    const sessionPath = writeSession(agentDir, 's.jsonl', [
      toolResultLine(9000, 'ghost', 'bash', 'output without call'),
    ]);

    const parsed = parseSessionTurnSteps(sessionPath, agentDir);

    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].orphan, true);
    assert.equal(parsed.steps[0].startedAtMs, null);
    assert.equal(parsed.steps[0].endedAtMs, 9000);
    assert.equal(parsed.steps[0].durationMs, null);
  });
});

test('parser leaves calls without results as open steps', () => {
  inTempDir((agentDir) => {
    const sessionPath = writeSession(agentDir, 's.jsonl', [
      assistantLine(1000, [{ id: 'c1', name: 'bash', arguments: { command: 'sleep 99' } }]),
    ]);

    const parsed = parseSessionTurnSteps(sessionPath, agentDir);

    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].open, true);
    assert.equal(parsed.steps[0].endedAtMs, null);
    assert.equal(parsed.steps[0].durationMs, null);
  });
});

test('parser slices by assistantStartIndex', () => {
  inTempDir((agentDir) => {
    const sessionPath = writeSession(agentDir, 's.jsonl', [
      assistantLine(1000, [{ id: 'old', name: 'read', arguments: { path: 'a' } }]),
      toolResultLine(1500, 'old', 'read', 'x'),
      assistantLine(2000, [{ id: 'new', name: 'bash', arguments: { command: 'ls' } }]),
      toolResultLine(2500, 'new', 'bash', 'y'),
    ]);

    const parsed = parseSessionTurnSteps(sessionPath, agentDir, { assistantStartIndex: 1 });

    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].toolCallId, 'new');
    assert.equal(parsed.assistantMessageTotal, 2);
  });
});

test('parser collects stopReason=error assistant rows as error events', () => {
  inTempDir((agentDir) => {
    const sessionPath = writeSession(agentDir, 's.jsonl', [
      assistantLine(1000, [], { stopReason: 'error', errorMessage: 'provider overloaded' }),
    ]);

    const parsed = parseSessionTurnSteps(sessionPath, agentDir);

    assert.equal(parsed.errorEvents.length, 1);
    assert.equal(parsed.errorEvents[0].timestampMs, 1000);
    assert.equal(parsed.errorEvents[0].errorMessage, 'provider overloaded');
  });
});

test('parser leaves an unterminated in-flight tail unconsumed without flagging truncation', () => {
  inTempDir((agentDir) => {
    const good = assistantLine(1000, [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }]);
    const dir = path.join(agentDir, 'named-sessions');

    fs.mkdirSync(dir, { recursive: true });

    const sessionPath = path.join(dir, 's.jsonl');

    fs.writeFileSync(sessionPath, good + '\n' + '{"type":"message","message":{"role":"ass'); // in-flight partial line

    const parsed = parseSessionTurnSteps(sessionPath, agentDir);

    assert.equal(parsed.inFlightTail, true);
    assert.equal(parsed.truncated, false); // in-flight tail is normal mid-turn
    assert.equal(parsed.corruptLines, 0);
    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].open, true);

    // Next pass from endOffset must see the completed line.
    fs.appendFileSync(sessionPath, 'istant","timestamp":2000,"content":[]}}\n');

    const reparsed = parseSessionTurnSteps(sessionPath, agentDir, { fromOffset: parsed.endOffset });

    assert.equal(reparsed.truncated, false);
    assert.equal(reparsed.inFlightTail, false);
    assert.equal(reparsed.assistantMessageTotal, 1);
    assert.equal(reparsed.endOffset, fs.statSync(sessionPath).size);
  });
});

test('parser flags corrupted middle lines as truncated but keeps parsing', () => {
  inTempDir((agentDir) => {
    const sessionPath = writeSession(agentDir, 's.jsonl', [
      assistantLine(1000, [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }]),
      '{not json',
      toolResultLine(1500, 'c1', 'bash', 'ok'),
    ]);

    const parsed = parseSessionTurnSteps(sessionPath, agentDir);

    assert.equal(parsed.truncated, true);
    assert.equal(parsed.corruptLines, 1);
    assert.equal(parsed.inFlightTail, false);
    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].durationMs, 500);
  });
});

test('parser rejects paths outside the agent named-sessions dir', () => {
  inTempDir((agentDir) => {
    const outside = path.join(agentDir, 'elsewhere.jsonl');

    fs.writeFileSync(outside, '{}\n');

    assert.equal(parseSessionTurnSteps(outside, agentDir), null);
    assert.equal(parseSessionTurnSteps('', agentDir), null);
    assert.equal(parseSessionTurnSteps(null, agentDir), null);
    assert.equal(parseSessionTurnSteps(path.join(agentDir, 'named-sessions', 'missing.jsonl'), agentDir), null);
  });
});

test('parser incremental offsets are byte-accurate with multibyte content', () => {
  inTempDir((agentDir) => {
    const dir = path.join(agentDir, 'named-sessions');

    fs.mkdirSync(dir, { recursive: true });

    const sessionPath = path.join(dir, 's.jsonl');
    const line1 = assistantLine(1000, [{ id: 'c1', name: 'bash', arguments: { command: 'echo 你好世界' } }]);
    const line2 = toolResultLine(1500, 'c1', 'bash', '输出：耗时分析 ✓');
    const line3 = assistantLine(2000, [{ id: 'c2', name: 'read', arguments: { path: '文档/说明.md' } }]);
    const line4 = toolResultLine(2600, 'c2', 'read', '文件内容');

    // Pass 1 consumes a complete call/result pair; pass 2 resumes at the
    // byte offset and must see exactly the new pair — no duplicates, no loss.
    fs.writeFileSync(sessionPath, line1 + '\n' + line2 + '\n');

    const first = parseSessionTurnSteps(sessionPath, agentDir);

    assert.equal(first.steps.map((step) => step.toolCallId).join(','), 'c1');
    assert.equal(first.inFlightTail, false);

    fs.appendFileSync(sessionPath, line3 + '\n' + line4 + '\n');

    const second = parseSessionTurnSteps(sessionPath, agentDir, { fromOffset: first.endOffset });

    assert.equal(second.steps.map((step) => step.toolCallId).join(','), 'c2');
    assert.equal(second.steps[0].durationMs, 600);
    assert.equal(second.truncated, false);
    assert.equal(second.endOffset, fs.statSync(sessionPath).size);

    const full = parseSessionTurnSteps(sessionPath, agentDir);
    const incrementalIds = [...first.steps, ...second.steps].map((step) => step.toolCallId).sort();

    assert.deepEqual(incrementalIds, full.steps.map((step) => step.toolCallId).sort());
  });
});

test('parser incremental offsets resume without double counting', () => {
  inTempDir((agentDir) => {
    const dir = path.join(agentDir, 'named-sessions');

    fs.mkdirSync(dir, { recursive: true });

    const sessionPath = path.join(dir, 's.jsonl');

    fs.writeFileSync(sessionPath, assistantLine(1000, [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }]) + '\n');

    const first = parseSessionTurnSteps(sessionPath, agentDir);

    assert.equal(first.steps.length, 1);

    fs.appendFileSync(sessionPath, toolResultLine(1500, 'c1', 'bash', 'ok') + '\n');

    const second = parseSessionTurnSteps(sessionPath, agentDir, { fromOffset: first.endOffset });

    assert.equal(second.steps.length, 1);
    assert.equal(second.steps[0].orphan, true); // result only; the call was in the first slice
    assert.equal(second.steps[0].endedAtMs, 1500);
  });
});

test('incremental passes with a slice boundary count assistant messages cumulatively', () => {
  inTempDir((agentDir) => {
    // Turn slice starts after 2 prior assistant messages; the turn's own
    // first assistant row arrives in pass 1, its toolResult in pass 2.
    const sessionPath = writeSession(agentDir, 'sliced-inc.jsonl', [
      assistantLine(100, [{ id: 'old1', name: 'bash', arguments: { command: 'ls' } }]),
      toolResultLine(200, 'old1', 'bash', 'old'),
      assistantLine(300, [{ id: 'old2', name: 'bash', arguments: { command: 'ls' } }]),
      toolResultLine(400, 'old2', 'bash', 'old'),
      assistantLine(1000, [{ id: 'c1', name: 'bash', arguments: { command: 'npm test' } }]),
    ]);

    const first = parseSessionTurnSteps(sessionPath, agentDir, { assistantStartIndex: 2 });

    assert.equal(first.steps.length, 1);
    assert.equal(first.steps[0].toolCallId, 'c1');
    assert.equal(first.steps[0].open, true);
    assert.equal(first.assistantMessageTotal, 3);

    fs.appendFileSync(sessionPath, toolResultLine(5000, 'c1', 'bash', '# pass 3') + '\n');

    // Without assistantCountBase the resumed pass would restart the counter
    // at 0 and skip the result as pre-slice traffic.
    const second = parseSessionTurnSteps(sessionPath, agentDir, {
      assistantStartIndex: 2,
      fromOffset: first.endOffset,
      assistantCountBase: first.assistantMessageTotal,
    });

    assert.equal(second.steps.length, 1);
    assert.equal(second.steps[0].toolCallId, 'c1');
    assert.equal(second.steps[0].orphan, true);
    assert.equal(second.steps[0].endedAtMs, 5000);
  });
});

test('slice startIndex 0 never skips results in incremental passes', () => {
  inTempDir((agentDir) => {
    const sessionPath = writeSession(agentDir, 'zero-index.jsonl', [
      assistantLine(1000, [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }]),
    ]);

    const first = parseSessionTurnSteps(sessionPath, agentDir, { assistantStartIndex: 0 });

    assert.equal(first.steps.length, 1);

    fs.appendFileSync(sessionPath, toolResultLine(2000, 'c1', 'bash', 'ok') + '\n');

    const second = parseSessionTurnSteps(sessionPath, agentDir, {
      assistantStartIndex: 0,
      fromOffset: first.endOffset,
      assistantCountBase: first.assistantMessageTotal,
    });

    // startIndex 0 means "no slice": the result must surface as an orphan
    // for the pipeline's cross-chunk merge, not be skipped.
    assert.equal(second.steps.length, 1);
    assert.equal(second.steps[0].orphan, true);
  });
});

test('performance: a multi-MB session log parses and classifies well under 10s (AC5)', () => {
  inTempDir((agentDir) => {
    // ~6MB synthetic log: 3000 tool steps with ~1KB outputs each, mirroring
    // the shape of the largest real session logs seen in the 三期房间 corpus.
    const lines = [];
    const output = 'x'.repeat(1500);
    for (let i = 0; i < 4000; i++) {
      const start = 1000000 + i * 2000;
      lines.push(assistantLine(start, [{ id: 'c' + i, name: 'bash', arguments: { command: i % 7 === 0 ? 'npm test' : 'rg pattern src/' } }]));
      lines.push(toolResultLine(start + 1500, 'c' + i, 'bash', output, i % 11 === 0));
    }
    const sessionPath = writeSession(agentDir, 'big.jsonl', lines);
    const sizeMb = fs.statSync(sessionPath).size / (1024 * 1024);
    assert.ok(sizeMb > 4, `synthetic log only ${sizeMb.toFixed(1)}MB — expected multi-MB`);

    const { createTurnRuleClassifier } = require('../../build/server/domain/runtime/turn-time-breakdown');
    const t0 = performance.now();
    const parsed = parseSessionTurnSteps(sessionPath, agentDir);
    const classifier = createTurnRuleClassifier();
    let classified = 0;
    for (const s of parsed.steps) {
      if (classifier.classify(s)) classified++;
    }
    const elapsedMs = performance.now() - t0;

    assert.equal(parsed.steps.length, 4000);
    assert.ok(classified > 0);
    assert.ok(elapsedMs < 10000, `parse+classify took ${elapsedMs.toFixed(0)}ms for ${sizeMb.toFixed(1)}MB — AC5 budget is 10s`);
  });
});
