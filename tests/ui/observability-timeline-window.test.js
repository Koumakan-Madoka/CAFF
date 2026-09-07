const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function loadHelper() {
  const window = { CaffShared: {} };
  const context = { window, console, Map, Array, Number, String, Math, Object };
  vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, 'public/shared/observability-timeline.js'), 'utf8'),
    context
  );
  return window.CaffShared.observabilityTimeline;
}

test('browser observability helper bounds five concurrent long timelines independently', () => {
  const helper = loadHelper();
  const timelines = Array.from({ length: 5 }, () => ({ events: [], totalEventCount: 0 }));

  timelines.forEach((timeline, agentIndex) => {
    for (let sequence = 1; sequence <= 65; sequence += 1) {
      const merged = helper.merge(timeline.events, [{
        eventId: `agent-${agentIndex}:event-${sequence}`,
        eventType: sequence % 2 === 0 ? 'tool_execution' : 'model_call',
        timelineSequence: sequence,
      }], { totalEventCount: sequence });
      timeline.events = merged.events;
      timeline.totalEventCount = merged.totalEventCount;
      timeline.droppedEventCount = merged.droppedEventCount;
    }
  });

  timelines.forEach((timeline) => {
    assert.equal(timeline.events.length, 16);
    assert.deepEqual(
      Array.from(timeline.events, (event) => event.timelineSequence),
      [1, ...Array.from({ length: 15 }, (_, index) => index + 51)]
    );
    assert.equal(timeline.totalEventCount, 65);
    assert.equal(timeline.droppedEventCount, 49);
  });
});

test('browser observability helper reorders a late model event by occurrence time', () => {
  const helper = loadHelper();
  const first = helper.merge([], [{
    eventId: 'tool:session:late-bash',
    eventType: 'tool_execution',
    timelineSequence: 1,
    createdAt: 200,
  }], { totalEventCount: 1 });
  const second = helper.merge(first.events, [{
    eventId: 'model-call:before-bash',
    eventType: 'model_call',
    timelineSequence: 2,
    timestamp: 100,
  }], { totalEventCount: 2 });

  assert.deepEqual(second.events.map((event) => event.eventType), ['model_call', 'tool_execution']);
  assert.deepEqual(second.events.map((event) => event.timelineSequence), [1, 2]);
});

test('timeline renderer exposes original sequence and one bounded omission row', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/chat/message-timeline.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  assert.match(source, /中间省略 \$\{timelineWindow\.droppedEventCount\} 条事件/u);
  assert.match(source, /Number\(call && call\.timelineSequence\)/u);
  assert.match(source, /Number\(step && step\.timelineSequence\)/u);
  assert.match(source, /保留 \$\{timelineWindow\.retainedEventCount\}\/\$\{timelineWindow\.totalEventCount\} 条/u);
  assert.match(source, /JSON\.stringify\(value, \(key, entry\) =>/u);
  assert.match(source, /\[结构化数据无法序列化\]/u);
  assert.doesNotMatch(source, /const partialJson = step && step\.partialJson \? String\(step\.partialJson\)/u);
  assert.match(styles, /\.message-tool-trace-omission[\s\S]*overflow-wrap:\s*anywhere/u);
});
