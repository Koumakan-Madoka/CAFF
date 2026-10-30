const assert = require('node:assert/strict');
const test = require('node:test');
const { scripts } = require('../../package.json');

// npm uses cmd.exe on Windows even when the author invokes npm from bash.
// The command string itself must fit cmd's 8191-character limit before any
// test can start. Keep a little room for npm's shell wrapper as well.
test('test scripts fit the Windows shell limit and compose planner checks exactly once', () => {
  for (const name of ['test:fast', 'test:planner-security']) {
    assert.ok(scripts[name].length < 8000, `${name} is ${scripts[name].length} characters; split it using an existing npm sub-suite`);
  }
  assert.match(scripts['test:fast'], /^npm run check && npm run test:planner-security && /);
  const expand = name => scripts[name].split(' && ').flatMap(command => {
    const match = /^npm run (test:[\w-]+)$/.exec(command);
    return match ? expand(match[1]) : [command];
  });
  const commands = expand('test:fast');
  const tests = commands.filter(c => /^node tests\//.test(c));
  assert.equal(tests.length, new Set(tests).size, 'sub-suite composition must not execute tests twice');
  const planner = expand('test:planner-security').filter(c => /^node tests\//.test(c));
  assert.deepEqual(tests.slice(0, planner.length), planner, 'retain the existing sequential planner-first test order');
  assert.equal(commands.filter(c => c === 'npm run build').length, 1);
});
