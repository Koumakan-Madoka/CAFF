const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyBashCommand,
  classifyPathSubcategory,
  createTurnRuleClassifier,
  detectTestFailure,
} = require('../../build/server/domain/runtime/turn-time-breakdown');

function bashStep(command, extra = {}) {
  return { toolName: 'bash', args: { command }, output: '', isError: false, ...extra };
}

function classifyBash(command, extra = {}) {
  return createTurnRuleClassifier().classify(bashStep(command, extra));
}

test('CAFF bridge: CLI form and native tool names → process-report', () => {
  assert.equal(classifyBash('node ./build/lib/agent-chat-tools.js send-public --content x').category, 'process-report');
  assert.equal(classifyBash('node "$CAFF_CHAT_TOOLS_PATH" update-goal --content-stdin').category, 'process-report');

  for (const name of ['update-goal', 'suggest-goal', 'send-public', 'create-delegation', 'await-delegation']) {
    assert.equal(createTurnRuleClassifier().classify({ toolName: name, args: {} }).category, 'process-report');
  }
});

test('full-regression entry points: npm test, test:fast, bare node --test, whole suite dir', () => {
  assert.deepEqual(pick(classifyBash('npm test')), { category: 'test', runKind: 'full-regression' });
  assert.deepEqual(pick(classifyBash('npm run test:fast')), { category: 'test', runKind: 'full-regression' });
  assert.deepEqual(pick(classifyBash('node --test tests/')), { category: 'test', runKind: 'full-regression' });
  assert.deepEqual(pick(classifyBash('pytest')), { category: 'test', runKind: 'full-regression' });
  assert.deepEqual(pick(classifyBash('go test ./...')), { category: 'test', runKind: 'full-regression' });
});

test('targeted tests carry a path/file subset', () => {
  assert.deepEqual(pick(classifyBash('node --test tests/runtime/foo.test.js')), { category: 'test', runKind: 'targeted' });
  assert.deepEqual(pick(classifyBash('node tests/runtime/foo.test.js')), { category: 'test', runKind: 'targeted' });
  assert.deepEqual(pick(classifyBash('pytest tests/unit/')), { category: 'test', runKind: 'targeted' });
  assert.deepEqual(pick(classifyBash('npx vitest run src/x.spec.ts')), { category: 'test', runKind: 'targeted' });
});

test('failed test runs stay in test with runFailed=true', () => {
  const tapFail = classifyBash('node --test tests/runtime/foo.test.js', { output: '# pass 3\n# fail 2', isError: true });

  assert.equal(tapFail.category, 'test');
  assert.equal(tapFail.runFailed, true);

  const tapPass = classifyBash('node --test tests/runtime/foo.test.js', { output: '# pass 5\n# fail 0' });

  assert.equal(tapPass.runFailed, false);

  const exitCode = classifyBash('npm test', { output: 'Command exited with code 1' });

  assert.equal(exitCode.category, 'test');
  assert.equal(exitCode.runFailed, true);
});

test('build and check commands → build-check', () => {
  for (const command of ['npm run build', 'npm run typecheck', 'npm run check', 'npx tsc --noEmit', 'node --check public/app.js', 'npx eslint src/']) {
    assert.equal(classifyBash(command).category, 'build-check', command);
  }
});

test('bash mutations → write; destination path class decides subcategory for file tools', () => {
  for (const command of ['cat > server/x.ts', 'echo hi >> docs/a.md', 'sed -i s/a/b/ server/x.ts', 'apply_patch < p.diff', 'tee server/y.ts', 'mv a.ts server/', 'git checkout -- server/x.ts', 'git restore docs/a.md']) {
    assert.equal(classifyBash(command).category, 'write', command);
  }

  const classifier = createTurnRuleClassifier();

  assert.deepEqual(pick(classifier.classify({ toolName: 'edit', args: { path: 'tests/runtime/x.test.js' } })), { category: 'write', subcategory: 'test-code' });
  assert.deepEqual(pick(classifier.classify({ toolName: 'write', args: { path: 'docs/engineering/backend/x.md' } })), { category: 'write', subcategory: 'docs-evidence' });
  assert.deepEqual(pick(classifier.classify({ toolName: 'edit', args: { path: 'server/domain/runtime/x.ts' } })), { category: 'write', subcategory: 'product-code' });
});

test('read tools: cold-start before first write, purposeful after', () => {
  const classifier = createTurnRuleClassifier();

  assert.equal(classifier.classify({ toolName: 'read', args: { path: 'server/x.ts' } }).subcategory, 'cold-start-reread');
  assert.equal(classifier.classify({ toolName: 'grep', args: { pattern: 'foo' } }).subcategory, 'cold-start-reread');

  classifier.classify({ toolName: 'edit', args: { path: 'server/x.ts' } });

  assert.equal(classifier.classify({ toolName: 'read', args: { path: 'server/y.ts' } }).subcategory, 'purposeful-lookup');
  assert.equal(classifier.classify(bashStep('git log --oneline -3')).subcategory, 'purposeful-lookup');
});

test('bash read-only commands → read', () => {
  for (const command of ['ls server/', 'cat docs/a.md', 'git status', 'git diff HEAD~1', 'grep -rn foo server/', 'rg pattern']) {
    assert.equal(classifyBash(command).category, 'read', command);
  }
});

test('opaque wrapper scripts and unknown commands → null (JEV fallback)', () => {
  assert.equal(classifyBash('bash scripts/run-all.sh'), null);
  assert.equal(classifyBash('node scripts/custom-runner.js'), null);
  assert.equal(classifyBash('./mystery-binary --flag'), null);
  assert.equal(classifyBash('npm test && bash scripts/wrap.sh'), null); // one opaque segment poisons the chain
});

test('multi-segment commands merge by priority (test > write > build-check > read)', () => {
  assert.equal(classifyBash('npm run build && node tests/runtime/foo.test.js').category, 'test');
  assert.equal(classifyBash('git status && npm run typecheck').category, 'build-check');
  assert.equal(classifyBash('cat a.md && cat b.md').category, 'read');
});

test('infra failure without semantic execution → exception-retry', () => {
  const classifier = createTurnRuleClassifier();

  assert.equal(classifier.classify({ toolName: 'mystery-tool', args: {}, isError: true, output: 'tool not found' }).category, 'exception-retry');
  assert.equal(classifier.classify({ toolName: 'mystery-tool', args: {}, isError: true, output: '' }).category, 'exception-retry');

  // Unknown command with a real (non-infra) failure stays JEV-bound.
  assert.equal(classifier.classify(bashStep('./mystery-binary', { isError: true, output: 'segmentation fault' })), null);
});

test('path subcategory classes', () => {
  assert.equal(classifyPathSubcategory('tests/runtime/x.test.js'), 'test-code');
  assert.equal(classifyPathSubcategory('E:\\repo\\tests\\x.js'), 'test-code');
  assert.equal(classifyPathSubcategory('docs/engineering/x.md'), 'docs-evidence');
  assert.equal(classifyPathSubcategory('.agents/skills/x/SKILL.md'), 'docs-evidence');
  assert.equal(classifyPathSubcategory('server/domain/x.ts'), 'product-code');
  assert.equal(classifyPathSubcategory(''), 'product-code');
});

test('detectTestFailure fingerprints', () => {
  assert.equal(detectTestFailure('# fail 3', false), true);
  assert.equal(detectTestFailure('2 failing', false), true);
  assert.equal(detectTestFailure('# pass 9\n# fail 0', false), false);
  assert.equal(detectTestFailure('', true), true);
  assert.equal(detectTestFailure('all green', false), false);
});

function pick(result) {
  const picked = { category: result.category };

  if (result.subcategory) {
    picked.subcategory = result.subcategory;
  }

  if (result.runKind) {
    picked.runKind = result.runKind;
  }

  return picked;
}
