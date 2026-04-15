const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { withTempDir } = require('../helpers/temp-dir');

delete process.env.CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_RUNTIME_DIR;
delete process.env.CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_PROJECT_DIR;

test('open sandbox factory stays disabled by default', () => {
  const {
    createConfiguredOpenSandboxFactory,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const factory = createConfiguredOpenSandboxFactory({ enabled: false });
  assert.equal(factory, null);
});

test('open sandbox factory falls back to compatibility REST client when sdk create fails', async () => {
  const {
    createConfiguredOpenSandboxFactory,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-compat-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  const sqlitePath = path.join(tempDir, 'store', 'chat.sqlite');
  const skillPath = path.join(agentDir, 'skills', 'werewolf');
  const requests = [];
  const originalFetch = global.fetch;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.trellis'), { recursive: true });
  fs.mkdirSync(skillPath, { recursive: true });
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis', 'workflow.md'), '# Workflow\n', 'utf8');
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Werewolf\n', 'utf8');
  fs.writeFileSync(sqlitePath, 'seed-sqlite', 'utf8');

  function createResponse(status, body = '') {
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return typeof body === 'string' ? body : JSON.stringify(body);
      },
      async json() {
        return typeof body === 'string' ? JSON.parse(body || '{}') : body;
      },
    };
  }

  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({
      url: String(url),
      method,
      headers: options.headers || {},
    });

    if (String(url) === 'https://compat.example.test/api/sandboxes' && method === 'POST') {
      return createResponse(200, {
        sandboxID: 'compat-sandbox-1',
        domain: 'compat.example.test',
        status: 'running',
      });
    }

    if (String(url).includes('/files/mkdir?path=') && method === 'POST') {
      return createResponse(200, '');
    }

    if (String(url).includes('/files?path=') && method === 'PUT') {
      return createResponse(200, '');
    }

    if (String(url) === 'https://compat.example.test/api/sandboxes/compat-sandbox-1' && method === 'DELETE') {
      return createResponse(200, '');
    }

    throw new Error(`Unexpected fetch request: ${method} ${String(url)}`);
  };

  try {
    const factory = createConfiguredOpenSandboxFactory({
      enabled: true,
      apiUrl: 'https://compat.example.test',
      apiKey: 'compat-key',
      remoteRoot: '/remote-root',
      driverVersion: 'compat-driver',
      loadModule: async () => ({
        ConnectionConfig: function ConnectionConfig() {},
        Sandbox: {
          async create() {
            return fetch(new Request('https://compat.example.test/sdk-probe'));
          },
        },
      }),
    });

    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'fixture',
        egressMode: 'deny',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      sqlitePath,
      outputDir,
      skillPath,
    });

    assert.equal(adapter.driverName, 'opensandbox');
    assert.equal(adapter.driverVersion, 'compat-driver');
    assert.equal(adapter.sandboxId, 'compat-sandbox-1');
    assert.equal(adapter.resources.remoteProjectDir, '/remote-root/run-1/case-1/project');
    const createRequest = requests.find((entry) => entry.url === 'https://compat.example.test/api/sandboxes' && entry.method === 'POST');
    assert.ok(requests.some((entry) => entry.url === '[object Request]' && entry.method === 'GET'));
    assert.ok(createRequest);
    assert.ok(requests.some((entry) => entry.url.includes('/files/mkdir?path=') && entry.method === 'POST'));
    assert.ok(requests.some((entry) => entry.url.includes('/files?path=') && entry.method === 'PUT'));
    assert.equal(createRequest.headers['X-API-Key'], 'compat-key');

    await adapter.cleanup();
    assert.ok(requests.some((entry) => entry.url === 'https://compat.example.test/api/sandboxes/compat-sandbox-1' && entry.method === 'DELETE'));
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('open sandbox factory prepares remote case world and cleanup', async () => {
  const {
    createConfiguredOpenSandboxFactory,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  const sqlitePath = path.join(tempDir, 'store', 'chat.sqlite');
  const skillPath = path.join(agentDir, 'skills', 'werewolf');
  const mkdirCalls = [];
  const writeCalls = [];
  const createCalls = [];
  let killCalls = 0;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.trellis'), { recursive: true });
  fs.mkdirSync(skillPath, { recursive: true });
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis', 'workflow.md'), '# Workflow\n', 'utf8');
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Werewolf\n', 'utf8');
  fs.writeFileSync(sqlitePath, 'seed-sqlite', 'utf8');

  const fakeSandbox = {
    sandboxId: 'sandbox-test-1',
    domain: 'sandbox.example.test',
    files: {
      async makeDir(remotePath) {
        mkdirCalls.push(remotePath);
      },
      async write(remotePath, content) {
        writeCalls.push({
          remotePath,
          content: Buffer.isBuffer(content) ? content.toString('utf8') : String(content),
        });
      },
    },
    async kill() {
      killCalls += 1;
    },
  };

  const factory = createConfiguredOpenSandboxFactory({
    enabled: true,
    remoteRoot: '/remote-root',
    driverVersion: 'test-driver',
    loadModule: async () => ({
      Sandbox: {
        async create(options) {
          createCalls.push(options);
          return fakeSandbox;
        },
      },
    }),
  });

  try {
    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'fixture',
        egressMode: 'deny',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      sqlitePath,
      outputDir,
      skillPath,
    });

    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].template, 'base');
    assert.equal(adapter.driverName, 'opensandbox');
    assert.equal(adapter.driverVersion, 'test-driver');
    assert.equal(adapter.sandboxId, 'sandbox-test-1');
    assert.equal(adapter.execution.runtime, 'host');
    assert.equal(adapter.execution.preparedOnly, true);
    assert.equal(adapter.egress.mode, 'deny');
    assert.equal(adapter.egress.enforced, false);
    assert.equal(adapter.resources.remoteRoot, '/remote-root/run-1/case-1');
    assert.equal(adapter.resources.remoteProjectDir, '/remote-root/run-1/case-1/project');
    assert.equal(adapter.resources.remoteSqlitePath, '/remote-root/run-1/case-1/store/chat.sqlite');
    assert.equal(adapter.resources.remoteSkillPath, '/remote-root/run-1/case-1/agent/skills/werewolf');
    assert.ok(mkdirCalls.includes('/remote-root/run-1/case-1'));
    assert.ok(writeCalls.some((entry) => entry.remotePath === '/remote-root/run-1/case-1/project/.trellis/workflow.md'));
    assert.ok(writeCalls.some((entry) => entry.remotePath === '/remote-root/run-1/case-1/agent/skills/werewolf/SKILL.md'));
    assert.ok(writeCalls.some((entry) => entry.remotePath === '/remote-root/run-1/case-1/store/chat.sqlite'));

    await adapter.cleanup();
    assert.equal(killCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('open sandbox factory cleanup treats missing sandbox as already cleaned', async () => {
  const {
    createConfiguredOpenSandboxFactory,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-cleanup-missing-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  let killCalls = 0;
  let closeCalls = 0;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const fakeSandbox = {
    sandboxId: 'sandbox-missing-1',
    domain: 'sandbox.example.test',
    files: {
      async makeDir() {},
      async write() {},
    },
    async kill() {
      killCalls += 1;
      throw new Error('Sandbox sandbox-missing-1 not found.');
    },
    async close() {
      closeCalls += 1;
      const error = new Error('Sandbox sandbox-missing-1 not found.');
      error.status = 404;
      throw error;
    },
  };

  const factory = createConfiguredOpenSandboxFactory({
    enabled: true,
    remoteRoot: '/remote-root',
    driverVersion: 'test-driver',
    loadModule: async () => ({
      Sandbox: {
        async create() {
          return fakeSandbox;
        },
      },
    }),
  });

  try {
    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'none',
        egressMode: 'deny',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      outputDir,
    });

    await assert.doesNotReject(adapter.cleanup());
    assert.equal(killCalls, 1);
    assert.equal(closeCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('open sandbox factory cleanup treats already-deleting sandbox as already cleaned', async () => {
  const {
    createConfiguredOpenSandboxFactory,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-cleanup-deleting-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  let killCalls = 0;
  let closeCalls = 0;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const fakeSandbox = {
    sandboxId: 'sandbox-deleting-1',
    domain: 'sandbox.example.test',
    files: {
      async makeDir() {},
      async write() {},
    },
    async kill() {
      killCalls += 1;
      throw new Error('Delete sandbox failed: Failed to delete sandbox container: 409 Client Error for http+docker://localhost/v1.45/containers/container-id?v=False&link=False&force=True: Conflict ("removal of container container-id is already in progress")');
    },
    async close() {
      closeCalls += 1;
    },
  };

  const factory = createConfiguredOpenSandboxFactory({
    enabled: true,
    remoteRoot: '/remote-root',
    driverVersion: 'test-driver',
    loadModule: async () => ({
      Sandbox: {
        async create() {
          return fakeSandbox;
        },
      },
    }),
  });

  try {
    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'none',
        egressMode: 'deny',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      outputDir,
    });

    await assert.doesNotReject(adapter.cleanup());
    assert.equal(killCalls, 1);
    assert.equal(closeCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('open sandbox factory cleanup treats already-deleting rawBody detail as already cleaned', async () => {
  const {
    createConfiguredOpenSandboxFactory,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-cleanup-deleting-raw-body-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  let killCalls = 0;
  let closeCalls = 0;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const deletingError = new Error('Delete sandbox failed');
  deletingError.rawBody = {
    error: {
      message: 'Failed to delete sandbox container: 409 Client Error for http+docker://localhost/v1.45/containers/container-id?v=False&link=False&force=True: Conflict ("removal of container container-id is already in progress")',
    },
  };

  const fakeSandbox = {
    sandboxId: 'sandbox-deleting-raw-body-1',
    domain: 'sandbox.example.test',
    files: {
      async makeDir() {},
      async write() {},
    },
    async kill() {
      killCalls += 1;
      throw deletingError;
    },
    async close() {
      closeCalls += 1;
    },
  };

  const factory = createConfiguredOpenSandboxFactory({
    enabled: true,
    remoteRoot: '/remote-root',
    driverVersion: 'test-driver',
    loadModule: async () => ({
      Sandbox: {
        async create() {
          return fakeSandbox;
        },
      },
    }),
  });

  try {
    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'none',
        egressMode: 'deny',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      outputDir,
    });

    await assert.doesNotReject(adapter.cleanup());
    assert.equal(killCalls, 1);
    assert.equal(closeCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('open sandbox factory cleanup treats truncated already-deleting message as already cleaned', async () => {
  const {
    createConfiguredOpenSandboxFactory,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-cleanup-deleting-truncated-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  let killCalls = 0;
  let closeCalls = 0;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const fakeSandbox = {
    sandboxId: 'sandbox-deleting-truncated-1',
    domain: 'sandbox.example.test',
    files: {
      async makeDir() {},
      async write() {},
    },
    async kill() {
      killCalls += 1;
      throw new Error('Failed to delete sandbox container: 409 Client Error for http+docker://localhost/v1.45/containers/container-id?v=False&link=False&force=True: Conflict ("removal of container container-id is alr...")');
    },
    async close() {
      closeCalls += 1;
    },
  };

  const factory = createConfiguredOpenSandboxFactory({
    enabled: true,
    remoteRoot: '/remote-root',
    driverVersion: 'test-driver',
    loadModule: async () => ({
      Sandbox: {
        async create() {
          return fakeSandbox;
        },
      },
    }),
  });

  try {
    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'none',
        egressMode: 'deny',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      outputDir,
    });

    await assert.doesNotReject(adapter.cleanup());
    assert.equal(killCalls, 1);
    assert.equal(closeCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('open sandbox factory startRun uses commands.run and copies session output', async () => {
  const {
    createConfiguredOpenSandboxFactory,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-run-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  const sqlitePath = path.join(tempDir, 'store', 'chat.sqlite');
  const skillPath = path.join(agentDir, 'skills', 'werewolf');
  const piPackageDir = path.join(tempDir, 'pi-package');
  const runnerPath = path.join(tempDir, 'runner.js');
  const chatToolsPath = path.join(tempDir, 'agent-chat-tools.js');
  const piAuthFilePath = path.join(tempDir, 'pi-auth.json');
  const remoteFiles = new Map();
  const commandCalls = [];
  let capturedInput = null;
  let killCalls = 0;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.trellis'), { recursive: true });
  fs.mkdirSync(skillPath, { recursive: true });
  fs.mkdirSync(path.join(piPackageDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis', 'workflow.md'), '# Workflow\n', 'utf8');
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Werewolf\n', 'utf8');
  fs.writeFileSync(path.join(piPackageDir, 'dist', 'cli.js'), 'console.log("fake pi");\n', 'utf8');
  fs.writeFileSync(runnerPath, 'console.log("runner");\n', 'utf8');
  fs.writeFileSync(chatToolsPath, 'console.log("chat tools");\n', 'utf8');
  fs.writeFileSync(sqlitePath, 'seed-sqlite', 'utf8');
  fs.writeFileSync(piAuthFilePath, JSON.stringify({
    'kimi-coding': {
      type: 'api_key',
      key: 'sandbox-kimi-key',
    },
  }, null, 2), 'utf8');

  const fakeSandbox = {
    sandboxId: 'sandbox-test-2',
    domain: 'sandbox.example.test',
    files: {
      async makeDir() {},
      async write(remotePath, content) {
        remoteFiles.set(remotePath, Buffer.isBuffer(content) ? content.toString('utf8') : String(content));
      },
      async read(remotePath) {
        if (!remoteFiles.has(remotePath)) {
          throw new Error(`Missing remote file: ${remotePath}`);
        }
        return remoteFiles.get(remotePath);
      },
      async exists(remotePath) {
        return remoteFiles.has(remotePath);
      },
    },
    commands: {
      async run(command, options) {
        commandCalls.push({ command, options });
        const quoted = [...command.matchAll(/'([^']*)'/g)].map((entry) => entry[1]);
        const inputPath = quoted[2];
        const resultPath = quoted[3];
        capturedInput = JSON.parse(remoteFiles.get(inputPath));
        remoteFiles.set(capturedInput.sessionPath, '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"sandbox-ok"}]}}\n');
        remoteFiles.set(resultPath, JSON.stringify({
          status: 'succeeded',
          reply: 'sandbox-ok',
          sessionPath: capturedInput.sessionPath,
          exitCode: 0,
          signal: null,
          stderrTail: '',
          parseErrors: 0,
          assistantErrors: [],
          stdoutLines: [],
          errorMessage: '',
        }));
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      },
    },
    async kill() {
      killCalls += 1;
    },
  };

  const factory = createConfiguredOpenSandboxFactory({
    enabled: true,
    remoteRoot: '/remote-root',
    driverVersion: 'test-driver',
    piPackageDir,
    runnerPath,
    chatToolsPath,
    piAuthFilePath,
    chatApiUrl: 'https://public.example.test',
    loadModule: async () => ({
      Sandbox: {
        async create() {
          return fakeSandbox;
        },
      },
    }),
  });

  try {
    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'fixture',
        egressMode: 'allow',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      sqlitePath,
      outputDir,
      skillPath,
    });

    assert.equal(adapter.execution.runtime, 'sandbox');
    assert.equal(adapter.execution.preparedOnly, false);
    assert.equal(typeof adapter.startRun, 'function');

    const handle = adapter.startRun('kimi-coding', 'model-1', 'say hi', {
      thinking: 'high',
      session: 'session-name',
      extraEnv: {
        PI_AGENT_SANDBOX_DIR: 'host-sandbox-should-not-leak',
        PI_AGENT_PRIVATE_DIR: 'host-private-should-not-leak',
        CAFF_TRELLIS_PROJECT_DIR: 'host-project-should-not-leak',
        CAFF_CHAT_API_URL: 'http://127.0.0.1:3100',
        CUSTOM_TOKEN: 'keep-me',
      },
    });
    const result = await handle.resultPromise;

    assert.equal(commandCalls.length, 1);
    assert.equal(commandCalls[0].options.cwd, '/remote-root/run-1/case-1/project');
    assert.equal(result.reply, 'sandbox-ok');
    assert.equal(result.runId, handle.runId);
    assert.equal(result.sessionPath, path.join(outputDir, 'named-sessions', 'session-name.jsonl'));
    assert.equal(fs.readFileSync(result.sessionPath, 'utf8'), '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"sandbox-ok"}]}}\n');
    assert.equal(capturedInput.piCliPath, '/remote-root/run-1/case-1/runtime/pi-coding-agent/dist/cli.js');
    assert.equal(capturedInput.agentDir, '/remote-root/run-1/case-1/agent');
    assert.equal(capturedInput.cwd, '/remote-root/run-1/case-1/project');
    assert.equal(capturedInput.extraEnv.PI_AGENT_SANDBOX_DIR, '/remote-root/run-1/case-1/agent/agent-sandboxes/agent-test');
    assert.equal(capturedInput.extraEnv.PI_AGENT_PRIVATE_DIR, '/remote-root/run-1/case-1/agent/agent-sandboxes/agent-test/private');
    assert.equal(capturedInput.extraEnv.CAFF_TRELLIS_PROJECT_DIR, '/remote-root/run-1/case-1/project');
    assert.equal(capturedInput.extraEnv.CAFF_CHAT_API_URL, 'https://public.example.test');
    assert.equal(capturedInput.extraEnv.CAFF_SKILL_TEST_RUN_ID, 'run-1');
    assert.equal(capturedInput.extraEnv.CAFF_SKILL_TEST_CASE_ID, 'case-1');
    assert.equal(capturedInput.extraEnv.CAFF_CHAT_TOOLS_PATH, '/remote-root/run-1/case-1/runtime/agent-chat-tools.js');
    assert.equal(capturedInput.extraEnv.CAFF_SKILL_TEST_SKILL_PATH, '/remote-root/run-1/case-1/agent/skills/werewolf/SKILL.md');
    assert.equal(capturedInput.extraEnv.KIMI_API_KEY, 'sandbox-kimi-key');
    assert.equal(capturedInput.extraEnv.CUSTOM_TOKEN, 'keep-me');
    assert.ok(remoteFiles.has('/remote-root/run-1/case-1/runtime/open-sandbox-runner.js'));
    assert.ok(remoteFiles.has('/remote-root/run-1/case-1/runtime/agent-chat-tools.js'));
    assert.ok(remoteFiles.has('/remote-root/run-1/case-1/runtime/pi-coding-agent/dist/cli.js'));

    await adapter.cleanup();
    assert.equal(killCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('open sandbox factory streams runner events and writes remote control requests', async () => {
  const {
    createConfiguredOpenSandboxFactory,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-stream-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  const sqlitePath = path.join(tempDir, 'store', 'chat.sqlite');
  const skillPath = path.join(agentDir, 'skills', 'werewolf');
  const piPackageDir = path.join(tempDir, 'pi-package');
  const runnerPath = path.join(tempDir, 'runner.js');
  const chatToolsPath = path.join(tempDir, 'agent-chat-tools.js');
  const remoteFiles = new Map();
  let capturedInput = null;
  let killCalls = 0;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.trellis'), { recursive: true });
  fs.mkdirSync(skillPath, { recursive: true });
  fs.mkdirSync(path.join(piPackageDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis', 'workflow.md'), '# Workflow\n', 'utf8');
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Werewolf\n', 'utf8');
  fs.writeFileSync(path.join(piPackageDir, 'dist', 'cli.js'), 'console.log("fake pi");\n', 'utf8');
  fs.writeFileSync(runnerPath, 'console.log("runner");\n', 'utf8');
  fs.writeFileSync(chatToolsPath, 'console.log("chat tools");\n', 'utf8');
  fs.writeFileSync(sqlitePath, 'seed-sqlite', 'utf8');

  const fakeSandbox = {
    sandboxId: 'sandbox-stream-1',
    domain: 'sandbox.example.test',
    files: {
      async makeDir() {},
      async write(remotePath, content) {
        remoteFiles.set(remotePath, Buffer.isBuffer(content) ? content.toString('utf8') : String(content));
      },
      async read(remotePath) {
        if (!remoteFiles.has(remotePath)) {
          throw new Error(`Missing remote file: ${remotePath}`);
        }
        return remoteFiles.get(remotePath);
      },
      async exists(remotePath) {
        return remoteFiles.has(remotePath);
      },
    },
    commands: {
      async run(command) {
        const quoted = [...command.matchAll(/'([^']*)'/g)].map((entry) => entry[1]);
        const inputPath = quoted[2];
        const resultPath = quoted[3];
        capturedInput = JSON.parse(remoteFiles.get(inputPath));
        return new Promise((resolve) => {
          setTimeout(() => {
            const runnerEvents = [
              {
                type: 'run_started',
                payload: {
                  pid: 4321,
                  sessionPath: capturedInput.sessionPath,
                },
              },
              {
                type: 'runner_status',
                payload: {
                  stage: 'running',
                  label: '正在 sandbox 内执行…',
                  pid: 4321,
                },
              },
              {
                type: 'pi_event',
                payload: {
                  piEvent: {
                    message: {
                      role: 'assistant',
                      content: [
                        { type: 'toolCall', name: 'read', id: 'tool-1', arguments: { path: '/remote-root/run-1/case-1/agent/skills/werewolf/SKILL.md' } },
                      ],
                    },
                  },
                },
              },
              {
                type: 'assistant_text_delta',
                payload: {
                  delta: 'stream-',
                  isFallback: false,
                  messageKey: 'response:test-stream',
                },
              },
            ];
            remoteFiles.set(capturedInput.eventPath, `${runnerEvents.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
          }, 5);
          setTimeout(() => {
            remoteFiles.set(capturedInput.sessionPath, '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"stream-ok"}]}}\n');
            remoteFiles.set(resultPath, JSON.stringify({
              status: 'succeeded',
              reply: 'stream-ok',
              sessionPath: capturedInput.sessionPath,
              exitCode: 0,
              signal: null,
              stderrTail: '',
              parseErrors: 0,
              assistantErrors: [],
              stdoutLines: [],
              errorMessage: '',
            }));
            resolve({ exitCode: 0, stdout: '', stderr: '' });
          }, 25);
        });
      },
    },
    async kill() {
      killCalls += 1;
    },
  };

  const factory = createConfiguredOpenSandboxFactory({
    enabled: true,
    remoteRoot: '/remote-root',
    driverVersion: 'test-driver',
    piPackageDir,
    runnerPath,
    chatToolsPath,
    eventPollIntervalMs: 5,
    loadModule: async () => ({
      Sandbox: {
        async create() {
          return fakeSandbox;
        },
      },
    }),
  });

  try {
    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'fixture',
        egressMode: 'deny',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      sqlitePath,
      outputDir,
      skillPath,
    });

    const handle = adapter.startRun('provider-1', 'model-1', 'say hi', {
      session: 'stream-session',
    });

    const piEvents = [];
    const textDeltas = [];
    const runnerStatuses = [];
    const runStartedEvents = [];
    const streamed = new Promise((resolve) => {
      handle.on('runner_status', (event) => {
        runnerStatuses.push(event);
      });
      handle.on('run_started', (event) => {
        runStartedEvents.push(event);
      });
      handle.on('assistant_text_delta', (event) => {
        textDeltas.push(event);
      });
      handle.on('pi_event', (event) => {
        piEvents.push(event);
        handle.complete('stop after first tool');
        resolve();
      });
    });

    await streamed;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await handle.resultPromise;

    assert.equal(result.reply, 'stream-ok');
    assert.ok(runnerStatuses.some((event) => event && event.stage === 'preparing_assets' && event.label === '正在准备 sandbox runner…'));
    assert.ok(runnerStatuses.some((event) => event && event.stage === 'input_ready' && event.label === '正在启动 sandbox 内进程…'));
    assert.ok(runStartedEvents.some((event) => event && event.sessionPath === capturedInput.sessionPath));
    assert.equal(piEvents.length, 1);
    assert.equal(piEvents[0].piEvent.message.content[0].name, 'read');
    assert.equal(textDeltas.length, 1);
    assert.equal(textDeltas[0].delta, 'stream-');
    assert.equal(textDeltas[0].messageKey, 'response:test-stream');
    assert.equal(capturedInput.eventPath, '/remote-root/run-1/case-1/runtime/events/stream-session.jsonl');
    assert.equal(capturedInput.controlPath, '/remote-root/run-1/case-1/runtime/controls/stream-session.json');
    assert.ok(remoteFiles.has(capturedInput.controlPath));
    const controlPayload = JSON.parse(remoteFiles.get(capturedInput.controlPath));
    assert.equal(controlPayload.action, 'complete');
    assert.equal(controlPayload.message, 'stop after first tool');
    assert.ok(controlPayload.createdAt);

    await adapter.cleanup();
    assert.equal(killCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('open sandbox factory reuses pre-baked runtime image assets when configured', async () => {
  const {
    createConfiguredOpenSandboxFactory,
    DEFAULT_PREBAKED_RUNTIME_DIR,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-prebaked-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  const sqlitePath = path.join(tempDir, 'store', 'chat.sqlite');
  const skillPath = path.join(agentDir, 'skills', 'werewolf');
  const remoteFiles = new Map();
  const writeCalls = [];
  const commandCalls = [];
  const runnerStatuses = [];
  let killCalls = 0;
  let closeCalls = 0;
  let capturedInput = null;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.trellis'), { recursive: true });
  fs.mkdirSync(skillPath, { recursive: true });
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis', 'workflow.md'), '# Workflow\n', 'utf8');
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Werewolf\n', 'utf8');
  fs.writeFileSync(sqlitePath, 'seed-sqlite', 'utf8');

  remoteFiles.set(`${DEFAULT_PREBAKED_RUNTIME_DIR}/open-sandbox-runner.js`, 'console.log("runner");\n');
  remoteFiles.set(`${DEFAULT_PREBAKED_RUNTIME_DIR}/agent-chat-tools.js`, 'console.log("chat tools");\n');
  remoteFiles.set(`${DEFAULT_PREBAKED_RUNTIME_DIR}/pi-coding-agent/dist/cli.js`, 'console.log("fake pi");\n');

  const fakeSandbox = {
    id: 'official-sandbox-prebaked',
    domain: 'local.opensandbox.test',
    files: {
      async makeDir(targetPath) {
        remoteFiles.set(targetPath, remoteFiles.get(targetPath) || '');
      },
      async write(targetPath, data) {
        const content = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        writeCalls.push({ remotePath: targetPath, content });
        remoteFiles.set(targetPath, content);
      },
      async read(targetPath) {
        if (!remoteFiles.has(targetPath)) {
          throw new Error(`Missing remote file: ${targetPath}`);
        }
        return remoteFiles.get(targetPath);
      },
      async exists(targetPath) {
        return remoteFiles.has(targetPath);
      },
      async createDirectories(entries) {
        for (const entry of entries) {
          remoteFiles.set(entry.path, remoteFiles.get(entry.path) || '');
        }
      },
      async writeFiles(entries) {
        for (const entry of entries) {
          const content = Buffer.isBuffer(entry.data) ? entry.data.toString('utf8') : String(entry.data);
          writeCalls.push({ remotePath: entry.path, content });
          remoteFiles.set(entry.path, content);
        }
      },
      async getFileInfo(paths) {
        const result = {};
        for (const targetPath of paths) {
          if (remoteFiles.has(targetPath)) {
            result[targetPath] = { path: targetPath };
          }
        }
        return result;
      },
      async readFile(targetPath) {
        if (!remoteFiles.has(targetPath)) {
          throw new Error(`Missing remote file: ${targetPath}`);
        }
        return remoteFiles.get(targetPath);
      },
    },
    commands: {
      async run(command, options) {
        commandCalls.push({ command, options });
        const quoted = [...command.matchAll(/'([^']*)'/g)].map((entry) => entry[1]);
        const inputPath = quoted[2];
        const resultPath = quoted[3];
        capturedInput = JSON.parse(remoteFiles.get(inputPath));
        remoteFiles.set(capturedInput.sessionPath, '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"prebaked-ok"}]}}\n');
        remoteFiles.set(resultPath, JSON.stringify({
          status: 'succeeded',
          reply: 'prebaked-ok',
          sessionPath: capturedInput.sessionPath,
          exitCode: 0,
          signal: null,
          stderrTail: '',
          parseErrors: 0,
          assistantErrors: [],
          stdoutLines: [],
          errorMessage: '',
        }));
        return {
          exitCode: 0,
          logs: {
            stdout: [{ text: 'runner stdout' }],
            stderr: [],
          },
        };
      },
    },
    async kill() {
      killCalls += 1;
    },
    async close() {
      closeCalls += 1;
    },
  };

  const factory = createConfiguredOpenSandboxFactory({
    enabled: true,
    apiUrl: 'http://127.0.0.1:8080/v1',
    image: 'caff-skill-test-runtime:local',
    prebakedRuntimeDir: DEFAULT_PREBAKED_RUNTIME_DIR,
    remoteRoot: '/remote-root',
    driverVersion: 'official-driver',
    useServerProxy: true,
    loadModule: async () => ({
      ConnectionConfig: function ConnectionConfig() {},
      Sandbox: {
        async create() {
          return fakeSandbox;
        },
      },
    }),
  });

  try {
    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'fixture',
        egressMode: 'deny',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      sqlitePath,
      outputDir,
      skillPath,
    });

    assert.equal(adapter.execution.runtime, 'sandbox');
    assert.equal(adapter.resources.remoteRuntimeAssetDir, DEFAULT_PREBAKED_RUNTIME_DIR);
    assert.equal(adapter.resources.usesPrebakedRuntimeAssets, true);

    const handle = adapter.startRun('provider-1', 'model-1', 'say hi', {
      session: 'prebaked-session',
    });
    handle.on('runner_status', (event) => {
      runnerStatuses.push(event);
    });
    const result = await handle.resultPromise;
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(result.reply, 'prebaked-ok');
    assert.equal(commandCalls.length, 1);
    assert.equal(capturedInput.piCliPath, `${DEFAULT_PREBAKED_RUNTIME_DIR}/pi-coding-agent/dist/cli.js`);
    assert.equal(capturedInput.extraEnv.CAFF_CHAT_TOOLS_PATH, `${DEFAULT_PREBAKED_RUNTIME_DIR}/agent-chat-tools.js`);
    assert.ok(commandCalls[0].command.includes(`'${DEFAULT_PREBAKED_RUNTIME_DIR}/open-sandbox-runner.js'`));
    assert.ok(runnerStatuses.some((event) => event && event.stage === 'preparing_assets' && event.assetSource === 'prebaked'));
    assert.ok(!writeCalls.some((entry) => entry.remotePath === `${DEFAULT_PREBAKED_RUNTIME_DIR}/open-sandbox-runner.js`));
    assert.ok(!writeCalls.some((entry) => entry.remotePath === `${DEFAULT_PREBAKED_RUNTIME_DIR}/agent-chat-tools.js`));
    assert.ok(!writeCalls.some((entry) => entry.remotePath.startsWith(`${DEFAULT_PREBAKED_RUNTIME_DIR}/pi-coding-agent/`)));
    assert.ok(writeCalls.some((entry) => entry.remotePath === '/remote-root/run-1/case-1/runtime/inputs/prebaked-session.json'));

    await adapter.cleanup();
    assert.equal(killCalls, 1);
    assert.equal(closeCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('open sandbox factory copies pre-baked CAFF source into isolated project dir', async () => {
  const {
    createConfiguredOpenSandboxFactory,
    DEFAULT_PREBAKED_PROJECT_DIR,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-prebaked-project-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  const skillPath = path.join(agentDir, 'skills', 'werewolf');
  const remoteFiles = new Map();
  const writeCalls = [];
  const commandCalls = [];
  let killCalls = 0;
  let closeCalls = 0;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.trellis'), { recursive: true });
  fs.mkdirSync(skillPath, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis', 'workflow.md'), '# Case Workflow\n', 'utf8');
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Werewolf\n', 'utf8');

  remoteFiles.set(`${DEFAULT_PREBAKED_PROJECT_DIR}/package.json`, '{"name":"caff"}\n');
  remoteFiles.set(`${DEFAULT_PREBAKED_PROJECT_DIR}/server/domain/example.js`, 'console.log("source");\n');

  const fakeSandbox = {
    id: 'official-sandbox-prebaked-project',
    domain: 'local.opensandbox.test',
    files: {
      async makeDir(targetPath) {
        remoteFiles.set(targetPath, remoteFiles.get(targetPath) || '');
      },
      async write(targetPath, data) {
        const content = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        writeCalls.push({ remotePath: targetPath, content });
        remoteFiles.set(targetPath, content);
      },
      async exists(targetPath) {
        return remoteFiles.has(targetPath);
      },
      async createDirectories(entries) {
        for (const entry of entries) {
          remoteFiles.set(entry.path, remoteFiles.get(entry.path) || '');
        }
      },
      async writeFiles(entries) {
        for (const entry of entries) {
          const content = Buffer.isBuffer(entry.data) ? entry.data.toString('utf8') : String(entry.data);
          writeCalls.push({ remotePath: entry.path, content });
          remoteFiles.set(entry.path, content);
        }
      },
      async getFileInfo(paths) {
        const result = {};
        for (const targetPath of paths) {
          if (remoteFiles.has(targetPath)) {
            result[targetPath] = { path: targetPath };
          }
        }
        return result;
      },
    },
    commands: {
      async run(command, options) {
        commandCalls.push({ command, options });
        const remoteProjectDir = '/remote-root/run-1/case-1/project';
        for (const [remotePath, content] of Array.from(remoteFiles.entries())) {
          if (remotePath.startsWith(`${DEFAULT_PREBAKED_PROJECT_DIR}/`)) {
            const relativePath = remotePath.slice(DEFAULT_PREBAKED_PROJECT_DIR.length + 1);
            remoteFiles.set(`${remoteProjectDir}/${relativePath}`, content);
          }
        }
        return {
          exitCode: 0,
          logs: {
            stdout: [{ text: 'copied project' }],
            stderr: [],
          },
        };
      },
    },
    async kill() {
      killCalls += 1;
    },
    async close() {
      closeCalls += 1;
    },
  };

  const factory = createConfiguredOpenSandboxFactory({
    enabled: true,
    apiUrl: 'http://127.0.0.1:8080/v1',
    image: 'caff-skill-test-caff:local',
    prebakedProjectDir: DEFAULT_PREBAKED_PROJECT_DIR,
    remoteRoot: '/remote-root',
    driverVersion: 'official-driver',
    useServerProxy: true,
    loadModule: async () => ({
      ConnectionConfig: function ConnectionConfig() {},
      Sandbox: {
        async create() {
          return fakeSandbox;
        },
      },
    }),
  });

  try {
    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'fixture',
        egressMode: 'deny',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      outputDir,
      skillPath,
    });

    assert.equal(commandCalls.length, 1);
    assert.ok(commandCalls[0].command.includes(`cp -a '${DEFAULT_PREBAKED_PROJECT_DIR}/.' '/remote-root/run-1/case-1/project'`));
    assert.equal(commandCalls[0].options.cwd, '/');
    assert.equal(adapter.resources.remoteProjectDir, '/remote-root/run-1/case-1/project');
    assert.equal(adapter.resources.remoteProjectTemplateDir, DEFAULT_PREBAKED_PROJECT_DIR);
    assert.equal(adapter.resources.usesPrebakedProjectSource, true);
    assert.equal(adapter.resources.upload.projectSource, 'prebaked');
    assert.equal(adapter.resources.upload.projectTemplateDir, DEFAULT_PREBAKED_PROJECT_DIR);
    assert.equal(remoteFiles.get('/remote-root/run-1/case-1/project/package.json'), '{"name":"caff"}\n');
    assert.equal(remoteFiles.get('/remote-root/run-1/case-1/project/server/domain/example.js'), 'console.log("source");\n');
    assert.ok(writeCalls.some((entry) => entry.remotePath === '/remote-root/run-1/case-1/project/.trellis/workflow.md' && entry.content === '# Case Workflow\n'));

    await adapter.cleanup();
    assert.equal(killCalls, 1);
    assert.equal(closeCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('open sandbox factory supports official local lifecycle sdk shape', async () => {
  const {
    createConfiguredOpenSandboxFactory,
  } = require('../../build/server/domain/skill-test/open-sandbox-factory');

  const tempDir = withTempDir('caff-open-sandbox-factory-official-');
  const agentDir = path.join(tempDir, 'agent');
  const projectDir = path.join(tempDir, 'project');
  const sandboxDir = path.join(agentDir, 'agent-sandboxes', 'agent-test');
  const privateDir = path.join(sandboxDir, 'private');
  const outputDir = path.join(tempDir, 'outputs');
  const sqlitePath = path.join(tempDir, 'store', 'chat.sqlite');
  const skillPath = path.join(agentDir, 'skills', 'werewolf');
  const piPackageDir = path.join(tempDir, 'pi-package');
  const runnerPath = path.join(tempDir, 'runner.js');
  const chatToolsPath = path.join(tempDir, 'agent-chat-tools.js');
  const remoteFiles = new Map();
  const createCalls = [];
  const commandCalls = [];
  let killCalls = 0;
  let closeCalls = 0;

  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.trellis'), { recursive: true });
  fs.mkdirSync(skillPath, { recursive: true });
  fs.mkdirSync(path.join(piPackageDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis', 'workflow.md'), '# Workflow\n', 'utf8');
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Werewolf\n', 'utf8');
  fs.writeFileSync(path.join(piPackageDir, 'dist', 'cli.js'), 'console.log("fake pi");\n', 'utf8');
  fs.writeFileSync(runnerPath, 'console.log("runner");\n', 'utf8');
  fs.writeFileSync(chatToolsPath, 'console.log("chat tools");\n', 'utf8');
  fs.writeFileSync(sqlitePath, 'seed-sqlite', 'utf8');

  const fakeSandbox = {
    id: 'official-sandbox-1',
    domain: 'local.opensandbox.test',
    files: {
      async makeDir(targetPath) {
        remoteFiles.set(targetPath, remoteFiles.get(targetPath) || '');
      },
      async write(targetPath, data) {
        remoteFiles.set(targetPath, Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
      },
      async read(targetPath) {
        if (!remoteFiles.has(targetPath)) {
          throw new Error(`Missing remote file: ${targetPath}`);
        }
        return remoteFiles.get(targetPath);
      },
      async exists(targetPath) {
        return remoteFiles.has(targetPath);
      },
      async createDirectories(entries) {
        for (const entry of entries) {
          remoteFiles.set(entry.path, remoteFiles.get(entry.path) || '');
        }
      },
      async writeFiles(entries) {
        for (const entry of entries) {
          remoteFiles.set(entry.path, Buffer.isBuffer(entry.data) ? entry.data.toString('utf8') : String(entry.data));
        }
      },
      async getFileInfo(paths) {
        const result = {};
        for (const targetPath of paths) {
          if (remoteFiles.has(targetPath)) {
            result[targetPath] = { path: targetPath };
          }
        }
        return result;
      },
      async readFile(targetPath) {
        if (!remoteFiles.has(targetPath)) {
          throw new Error(`Missing remote file: ${targetPath}`);
        }
        return remoteFiles.get(targetPath);
      },
    },
    commands: {
      async run(command, options) {
        commandCalls.push({ command, options });
        const quoted = [...command.matchAll(/'([^']*)'/g)].map((entry) => entry[1]);
        const inputPath = quoted[2];
        const resultPath = quoted[3];
        const payload = JSON.parse(remoteFiles.get(inputPath));
        remoteFiles.set(payload.sessionPath, '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"official-ok"}]}}\n');
        remoteFiles.set(resultPath, JSON.stringify({
          status: 'succeeded',
          reply: 'official-ok',
          sessionPath: payload.sessionPath,
          exitCode: 0,
          signal: null,
          stderrTail: '',
          parseErrors: 0,
          assistantErrors: [],
          stdoutLines: ['runner stdout'],
          errorMessage: '',
        }));
        return {
          exitCode: 0,
          logs: {
            stdout: [{ text: 'runner stdout' }],
            stderr: [],
          },
        };
      },
    },
    async kill() {
      killCalls += 1;
    },
    async close() {
      closeCalls += 1;
    },
  };

  const factory = createConfiguredOpenSandboxFactory({
    enabled: true,
    apiUrl: 'http://127.0.0.1:8080/v1',
    apiKey: 'local-key',
    image: 'node:22-bookworm',
    useServerProxy: true,
    remoteRoot: '/remote-root',
    driverVersion: 'official-driver',
    piPackageDir,
    runnerPath,
    chatToolsPath,
    loadModule: async () => ({
      ConnectionConfig: function ConnectionConfig() {},
      Sandbox: {
        async create(options) {
          createCalls.push(options);
          return fakeSandbox;
        },
      },
    }),
  });

  try {
    const adapter = await factory({
      caseId: 'case-1',
      runId: 'run-1',
      isolation: {
        mode: 'isolated',
        trellisMode: 'fixture',
        egressMode: 'deny',
      },
      agentDir,
      projectDir,
      sandboxDir,
      privateDir,
      sqlitePath,
      outputDir,
      skillPath,
    });

    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].connectionConfig.domain, 'http://127.0.0.1:8080');
    assert.equal(createCalls[0].connectionConfig.apiKey, 'local-key');
    assert.equal(createCalls[0].connectionConfig.useServerProxy, true);
    assert.equal(createCalls[0].image, 'node:22-bookworm');
    assert.deepEqual(createCalls[0].env, {
      CAFF_SKILL_TEST_RUN_ID: 'run-1',
      CAFF_SKILL_TEST_CASE_ID: 'case-1',
    });
    assert.equal(adapter.driverVersion, 'official-driver');
    assert.equal(adapter.sandboxId, 'official-sandbox-1');
    assert.equal(adapter.extraEnv.CAFF_OPENSANDBOX_FLAVOR, 'official');
    assert.equal(adapter.resources.sdkFlavor, 'official');
    assert.equal(adapter.execution.runtime, 'sandbox');

    const handle = adapter.startRun('provider-1', 'model-1', 'say hi', {
      session: 'official-session',
    });
    const result = await handle.resultPromise;

    assert.equal(commandCalls.length, 1);
    assert.equal(result.reply, 'official-ok');
    assert.equal(result.sandboxCommand.stdout, 'runner stdout');
    assert.equal(result.sessionPath, path.join(outputDir, 'named-sessions', 'official-session.jsonl'));
    assert.equal(fs.readFileSync(result.sessionPath, 'utf8'), '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"official-ok"}]}}\n');

    await adapter.cleanup();
    assert.equal(killCalls, 1);
    assert.equal(closeCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
