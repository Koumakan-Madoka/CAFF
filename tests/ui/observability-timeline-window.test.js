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

test('timeline renderer exposes original sequence and one bounded omission row', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/chat/message-timeline.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  assert.match(source, /中间省略 \$\{timelineWindow\.droppedEventCount\} 条事件/u);
  assert.match(source, /Number\(call && call\.timelineSequence\)/u);
  assert.match(source, /Number\(step && step\.timelineSequence\)/u);
  assert.match(source, /保留 \$\{timelineWindow\.retainedEventCount\}\/\$\{timelineWindow\.totalEventCount\} 条/u);
  assert.match(styles, /\.message-tool-trace-omission[\s\S]*overflow-wrap:\s*anywhere/u);
});
