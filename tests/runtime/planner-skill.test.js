const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// ADR 0002 keeps the planner skill in the repository, so every clone receives
// it. Only portable content may live there: one machine's paths, rooms,
// projects and identities belong in the planner's local overlay
// (~/.caff-ops/local.md), which never enters git.
const ROOT = path.resolve(__dirname, '..', '..');
const SKILL_DIR = path.join(ROOT, '.claude', 'skills', 'caff-ops');
const CLI = path.join(SKILL_DIR, 'scripts', 'caff.js');

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

const files = listFiles(SKILL_DIR);
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// Planner text legitimately carries loopback URLs, placeholders such as <id>,
// short public commit SHAs and the four agent commit identities. A bare 8-hex
// room prefix looks exactly like a short SHA, so it is flagged only next to a
// room/session word.
const LOCAL_DATA = [
  ['a drive-letter path', /\b[A-Za-z]:[\\/]/],
  ['a named home directory', /(?<!https?:\/\/\S*)[\\/](?:Users|home)[\\/][^\\/\s<>"'`]+/i],
  ['the root home directory', /(?:^|[\s"'`(（=])\/root(?=[\\/\s"'`)]|$)/],
  ['a network share', /(?:^|[\s"'`(（=])(?:\\\\|\/\/)[\w.$-]+[\\/][\w.$-]+/],
  ['an instance identifier', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['a room or session ID prefix', /(?:\broom|房间|会话|\bconversation)[^\n]{0,6}?\b(?=[0-9a-f]{0,7}\d)[0-9a-f]{8}\b/i],
  ['a project ID', /\bproject-(?=[0-9a-f]{0,7}\d)[0-9a-f]{8}\b/i],
  ['an e-mail address other than an agent identity',
    /(?<![\w.+-])(?!(?:gpt|glm|kimi|claude)@caff\.local\b)[\w.+-]+@[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+/i],
];

test('local-data patterns flag local identifiers and spare portable text', () => {
  const hits = (line) => LOCAL_DATA.filter(([, pattern]) => pattern.test(line)).map(([label]) => label);
  const local = [
    'E:\\pythonproject\\caff',
    'C:/Users/alice/AppData/Local/Temp',
    '/home/alice/caff',
    '/Users/alice/caff',
    'state lives in /root/.caff-ops/local.md',
    'mounted at \\\\fileserver\\share\\caff',
    'mounted at //fileserver/share/caff',
    'room 9fb2a910-a07e-4c91-828e-24c860893336',
    'the P1 room（`e0263bab`）',
    '房间 `0c908ddb` 的演示 Goal',
    'branch room/9fb2a910-p2-claude-code',
    'created in project-52c82405',
    'mail alice@example.com',
    'author alice@caff.local',
  ];
  const portable = [
    'git -c user.name=Claude -c user.email=claude@caff.local commit',
    'GPT <gpt@caff.local>、GLM <glm@caff.local>、Kimi <kimi@caff.local>',
    'see https://example.com/home/user/guide',
    'http://127.0.0.1:3100/api/health',
    'branch room/<id>-<slug> in ../worktrees/room/<会话ID前8位>-<slug>',
    'develop `69b7fa1` 起',
    '%LOCALAPPDATA%\\CAFF\\planner\\planner-<sha256(host)>-<port>.json',
    'default %LOCALAPPDATA%\\\\CAFF\\\\planner\\\\planner-<sha256(host)>-<port>.json',
    'taskkill //PID <pid> //F, then cmd //c rmdir <链接>',
    'node "${CLAUDE_SKILL_DIR}/scripts/caff.js" status <room>',
    '路由靠正文里的 `@名字`，比如 @Kimi',
    '会话 ID 的前 8 位',
  ];
  const missed = local.filter((line) => hits(line).length === 0);
  const falsePositives = portable.filter((line) => hits(line).length > 0).map((line) => `${line} -> ${hits(line).join(', ')}`);
  assert.deepEqual({ missed, falsePositives }, { missed: [], falsePositives: [] });
});

test('planner skill carries no machine-local paths, instance IDs or personal addresses', () => {
  const findings = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      for (const [label, pattern] of LOCAL_DATA) {
        if (pattern.test(line)) findings.push(`${relative(file)}:${index + 1} has ${label}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.equal(findings.length, 0, ['move machine-specific content to ~/.caff-ops/local.md:', ...findings].join('\n'));
});

test('planner skill references only files it ships', () => {
  // Own files are named through ${CLAUDE_SKILL_DIR} or a relative Markdown link,
  // so a script kept in the local overlay cannot be referenced by accident.
  const missing = [];
  for (const file of files.filter((name) => name.endsWith('.md'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, target] of text.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([^\s"'`)]+)/g)) {
      if (!fs.existsSync(path.join(SKILL_DIR, target))) missing.push(`${relative(file)} -> \${CLAUDE_SKILL_DIR}/${target}`);
    }
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) missing.push(`${relative(file)} -> ${target}`);
    }
  }
  assert.equal(missing.length, 0, missing.join('\n'));
});

test('planner skill scripts parse', () => {
  const scripts = files.filter((name) => /\.[cm]?js$/.test(name));
  assert.ok(scripts.length > 0);
  for (const script of scripts) execFileSync(process.execPath, ['--check', script], { stdio: 'pipe' });
});

test('planner skill is discoverable by Claude Code and absent from the in-room agent skill root', () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
  assert.ok(frontmatter, 'SKILL.md starts with YAML frontmatter');
  assert.match(frontmatter[1], /^name: caff-ops$/m);
  assert.match(frontmatter[1], /^description: \S/m);
  // In-room pi agents discover .agents/skills; the planner manual is for the planner only.
  assert.equal(fs.existsSync(path.join(ROOT, '.agents', 'skills', 'caff-ops')), false);
});

// The CLI runs as a child process with a scrubbed environment, so a test never
// inherits a developer's instance settings or reaches a live instance. A child
// still running after timeoutMs, or once stderr matches killOn, is stopped and
// reported as killed.
function runCli(script, args, env = {}, { killOn, timeoutMs = 20000 } = {}) {
  const childEnv = { ...process.env };
  for (const key of ['CAFF_HOME', 'CAFF_PROJECT_ID', 'CAFF_BASE_URL', 'CAFF_PLANNER_CREDENTIAL_FILE']) delete childEnv[key];
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const stop = () => {
      if (!killed) {
        killed = true;
        child.kill();
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (killOn && killOn.test(stderr)) stop();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

function tempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A minimal checkout: package.json, a .git directory (or a linked worktree's
// .git file) and a copy of the CLI at its shipped location.
function checkout(root, { name = 'caff', git } = {}) {
  const scripts = path.join(root, '.claude', 'skills', 'caff-ops', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(CLI, path.join(scripts, 'caff.js'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }));
  if (git === undefined) fs.mkdirSync(path.join(root, '.git'));
  else fs.writeFileSync(path.join(root, '.git'), git);
  return path.join(scripts, 'caff.js');
}

async function home(script, env) {
  const { code, stdout, stderr } = await runCli(script, ['help'], env);
  assert.equal(code, 0, stderr);
  const match = /, home (.*)\)$/.exec(stdout.split(/\r?\n/)[0]);
  assert.ok(match, stdout);
  return match[1];
}

test('caff.js finds its checkout: main, linked worktree, broken pointer, skill link', async (t) => {
  const root = tempDir(t, 'caff-ops-home-');
  const main = path.join(root, 'main');
  assert.equal(await home(checkout(main)), main);

  // Production runs from the main checkout, so a linked worktree resolves to it.
  const gitDir = path.join(main, '.git', 'worktrees', 'room');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  assert.equal(await home(checkout(path.join(root, 'linked'), { git: `gitdir: ${gitDir}\n` })), main);

  // An unreadable worktree pointer falls back to the worktree itself.
  const broken = path.join(root, 'broken');
  assert.equal(await home(checkout(broken, { git: `gitdir: ${path.join(root, 'missing')}\n` })), broken);

  // The planner's ~/.claude/skills entry may be a link to the shipped skill.
  const link = path.join(root, 'skills-link');
  fs.symlinkSync(path.join(main, '.claude', 'skills', 'caff-ops'), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await home(path.join(link, 'scripts', 'caff.js')), main);

  // Outside a CAFF checkout there is no default, and CAFF_HOME always wins.
  const other = checkout(path.join(root, 'other'), { name: 'other' });
  assert.equal(await home(other), '(not found; set CAFF_HOME)');
  assert.equal(await home(other, { CAFF_HOME: main }), main);
});

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function fakeServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function projectsServer(t, projects) {
  return fakeServer(t, (req, res) => {
    const known = req.method === 'GET' && req.url === '/api/projects';
    reply(res, known ? 200 : 404, known ? { activeProjectId: projects[0].id, projects } : { error: 'not found' });
  });
}

test('create-room dry run names its project and refuses an unknown one', async (t) => {
  const own = path.resolve(os.tmpdir(), 'caff-own-checkout');
  const projects = [
    { id: 'project-active', name: 'other', path: path.resolve(os.tmpdir(), 'elsewhere') },
    // Windows paths compare case-insensitively; a trailing separator never matters.
    { id: 'project-own', name: 'caff', path: `${process.platform === 'win32' ? own.toUpperCase() : own}${path.sep}` },
  ];
  const base = await projectsServer(t, projects);
  const dryRun = (args = [], env = {}) => runCli(CLI, ['create-room', '--title', 'T', '--participants', 'kimi', ...args],
    { CAFF_BASE_URL: base, CAFF_HOME: own, ...env });

  // The default is the project whose path is this checkout, not the UI's active project.
  let result = await dryRun();
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stdout, /\| project project-own \(caff, /);
  assert.match(result.stdout, /NOT EXECUTED/);

  result = await dryRun(['--project', 'project-active']);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stdout, /\| project project-active \(other, /);

  // An unknown project fails in the dry run, listing the instance's projects.
  for (const run of [() => dryRun(['--project', 'project-missing']), () => dryRun([], { CAFF_PROJECT_ID: 'project-missing' })]) {
    result = await run();
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /project project-missing does not exist/);
    assert.match(result.stderr, /project-active[\s\S]*project-own/);
  }

  result = await dryRun([], { CAFF_HOME: path.resolve(os.tmpdir(), 'not-a-project') });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /no project has the path/);
  assert.match(result.stderr, /project-active[\s\S]*project-own/);
});

// No planner credential: requests go to the fake server unauthenticated.
function plannerEnv(t, base) {
  return { CAFF_BASE_URL: base, CAFF_PLANNER_CREDENTIAL_FILE: path.join(tempDir(t, 'caff-ops-cred-'), 'none.json') };
}

test('goal-lint flags evidence the server would truncate, drop or relabel', async (t) => {
  const file = path.join(tempDir(t, 'caff-ops-lint-'), 'goal.json');
  const lint = (evidence) => {
    fs.writeFileSync(file, JSON.stringify({
      objective: 'Ship the change.',
      acceptanceCriteria: [{ id: 'c1', statement: 'Tests pass.', verifyBy: 'npm test' }],
      workItems: [{ id: 'w1', text: 'Implement it.', status: 'todo' }],
      evidence,
    }));
    return runCli(path.join(SKILL_DIR, 'scripts', 'goal-lint.js'), [file]);
  };

  let result = await lint([{ id: 'e1', kind: 'test', criterionIds: ['c1'], summary: 'npm test passed.', reference: 'CI run 1' }]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^OK$/m);

  // normalizeGoalEvidence cuts summary and reference to 1000 characters, drops a
  // record without a summary and stores an unknown kind as "artifact".
  result = await lint([
    { id: 'e1', kind: 'test', summary: 'x'.repeat(1001) },
    { id: 'e2', kind: 'screenshot', summary: 'Looks right.', reference: 'y'.repeat(1001) },
    { id: 'e2', summary: '   ' },
  ]);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /evidence e1\.summary: 1001 > 1000/);
  assert.match(result.stdout, /evidence e2\.reference: 1001 > 1000/);
  assert.match(result.stdout, /evidence e2\.kind "screenshot" is stored as "artifact"/);
  assert.match(result.stdout, /duplicate evidence e2/);
  assert.match(result.stdout, /evidence e2\.summary: empty/);
});

test('goal-lint mirrors the server list caps, generated IDs and accepted shapes', async (t) => {
  const file = path.join(tempDir(t, 'caff-ops-lint-'), 'goal.json');
  const lint = (goal) => {
    fs.writeFileSync(file, JSON.stringify({ objective: 'Ship the change.', ...goal }));
    return runCli(path.join(SKILL_DIR, 'scripts', 'goal-lint.js'), [file]);
  };
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const criteria = (n) => many(n, (i) => ({ statement: `Criterion ${i + 1}.`, verifyBy: 'npm test' }));

  // normalizeGoal* accept items without IDs (criterion-<n>, work-<n>, ...), work
  // items as plain strings or without a status (todo), and case-insensitive values.
  let result = await lint({
    acceptanceCriteria: [...criteria(2), { text: 'Aliased.', verify_by: 'npm test', risk: 'High' }],
    workItems: ['Implement it.', { title: 'Test it.' }],
  });
  assert.equal(result.code, 0, result.stdout);

  // A generated ID can still collide with an explicit one.
  result = await lint({
    acceptanceCriteria: [{ id: 'criterion-2', statement: 'A.', verifyBy: 'npm test' }, { statement: 'B.', verifyBy: 'npm test' }],
    workItems: ['Implement it.'],
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /duplicate criterion criterion-2/);

  // Statuses are matched the way the server matches them.
  result = await lint({ acceptanceCriteria: criteria(1), workItems: [{ text: 'Started.', status: 'In-Progress' }, { text: 'New.', status: 'TODO' }] });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /work item work-1 status in_progress/);
  assert.doesNotMatch(result.stdout, /stored as "todo"|work item work-2/);

  // The server keeps only the first 40/40/60/100 items of these lists.
  result = await lint({
    decisions: { committed: many(41, (i) => ({ id: `d${i}`, statement: 'Decided.' })) },
    acceptanceCriteria: criteria(41),
    workItems: many(61, (i) => ({ id: `w${i}`, text: 'Work.' })),
    evidence: many(101, (i) => ({ id: `e${i}`, kind: 'test', summary: 'Passed.' })),
  });
  assert.equal(result.code, 1, result.stdout);
  for (const cap of ['decisions.committed: 41 items > 40', 'acceptanceCriteria: 41 items > 40', 'workItems: 61 items > 60', 'evidence: 101 items > 100']) {
    assert.ok(result.stdout.includes(cap), `missing "${cap}":\n${result.stdout.slice(-600)}`);
  }
});

test('send prints its request ID before posting, so a lost response can be retried without a duplicate', async (t) => {
  const room = '00000000-0000-4000-8000-000000000001';
  const base = await fakeServer(t, (req, res) => {
    if (req.method === 'POST' && req.url === `/api/conversations/${room}/routing-preview`) {
      reply(res, 200, { agents: [{ id: 'role-family-kimi', name: 'Kimi' }], strategy: 'user_mentions', executionMode: 'serial' });
    } else if (req.method === 'POST' && req.url === `/api/conversations/${room}/messages`) {
      // The server takes the message, then the response is lost on the way back.
      req.resume();
      req.on('end', () => req.socket.destroy());
    } else {
      reply(res, 404, { error: 'not found' });
    }
  });
  const result = await runCli(CLI, ['send', room, '--text', 'ping', '--confirm'], plannerEnv(t, base));
  assert.equal(result.code, 1, result.stdout);
  // The default ID is a random UUID: a timestamp collides when two sends start in
  // the same millisecond, and the server then drops one as a duplicate.
  assert.match(result.stdout, /retry with --request-id claude-code-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/);
});

test('wait-attention reports a query that can never succeed instead of retrying it', async (t) => {
  const base = await fakeServer(t, (req, res) => {
    if (req.url.startsWith('/api/planner/attention/wait')) reply(res, 400, { error: 'Invalid attention query', code: 'attention_query_invalid' });
    else if (req.url.startsWith('/api/conversations?')) reply(res, 200, { conversations: [] });
    else reply(res, 404, { error: 'not found' });
  });
  const env = plannerEnv(t, base);

  let result = await runCli(CLI, ['wait-attention', '--status', 'bogus'], env, { timeoutMs: 10000 });
  assert.equal(result.killed, false, `a rejected query was retried:\n${result.stderr}`);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 400 .*attention_query_invalid/);

  result = await runCli(CLI, ['wait-attention', '--room', 'no such room'], env, { timeoutMs: 10000 });
  assert.equal(result.killed, false, `an unknown room was retried:\n${result.stderr}`);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no room matches/);
});

test('wait-attention keeps retrying while the server restarts', async (t) => {
  // Connection refused, a 503 and a 401 from a rotated credential all pass once the restart completes.
  const closed = await new Promise((resolve) => {
    const server = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  const cases = [['connection refused', closed]];
  for (const status of [503, 401]) {
    cases.push([`HTTP ${status}`, await fakeServer(t, (req, res) => reply(res, status, { error: 'restarting' }))]);
  }
  for (const [label, base] of cases) {
    const result = await runCli(CLI, ['wait-attention'], plannerEnv(t, base), { killOn: /retrying in 15s/, timeoutMs: 10000 });
    assert.equal(result.killed, true, `${label} ended the wait:\n${result.stderr}`);
    assert.match(result.stderr, /wait error: .*retrying in 15s/, label);
  }
});
