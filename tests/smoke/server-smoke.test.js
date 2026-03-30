const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const test = require('node:test');

const { requireSpawn } = require('../helpers/spawn');
const { withTempDir } = require('../helpers/temp-dir');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForServer(baseUrl, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'Server did not respond';

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);

      if (response.ok) {
        return;
      }

      lastError = `Unexpected status: ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(lastError);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  const exitPromise = new Promise((resolve) => {
    child.once('exit', resolve);
  });

  child.kill('SIGTERM');

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }

      resolve();
    }, 5000);
  });

  await Promise.race([exitPromise, timeoutPromise]);
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}

test('server smoke: bootstrap, static files, projects, skills, agents, and conversations work', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const port = await findFreePort();
  const tempDir = withTempDir('caff-m0-');
  const sqlitePath = path.join(tempDir, 'smoke.sqlite');
  const child = spawn(process.execPath, ['build/lib/app-server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CHAT_APP_HOST: '127.0.0.1',
      CHAT_APP_PORT: String(port),
      PI_CODING_AGENT_DIR: tempDir,
      PI_SQLITE_PATH: sqlitePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrText = '';
  child.stderr.on('data', (chunk) => {
    stderrText += String(chunk);
  });

  t.after(async () => {
    await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child);

  const homeResponse = await fetch(baseUrl);
  assert.equal(homeResponse.status, 200);
  assert.match(homeResponse.headers.get('content-type') || '', /text\/html/);

  const sharedResponse = await fetch(`${baseUrl}/shared/api-client.js`);
  assert.equal(sharedResponse.status, 200);
  assert.match(sharedResponse.headers.get('content-type') || '', /javascript/);

  const casebookResponse = await fetch(`${baseUrl}/eval-cases.html`);
  assert.equal(casebookResponse.status, 200);
  assert.match(casebookResponse.headers.get('content-type') || '', /text\/html/);

  const bootstrap = await fetchJson(baseUrl, '/api/bootstrap');
  assert.ok(Array.isArray(bootstrap.conversations));
  assert.ok(Array.isArray(bootstrap.agents));
  assert.ok(Array.isArray(bootstrap.skills));

  const metrics = await fetchJson(baseUrl, '/api/metrics/agent');
  assert.ok(Array.isArray(metrics.agents));
  assert.ok(Array.isArray(metrics.tools));

  const evalCases = await fetchJson(baseUrl, '/api/eval-cases');
  assert.ok(Array.isArray(evalCases.cases));

  const projects = await fetchJson(baseUrl, '/api/projects');
  assert.ok(Array.isArray(projects.projects));
  assert.ok(projects.projects.length >= 1);
  assert.ok(projects.projects.some((project) => project && project.active));

  const createdProject = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: {
      name: 'Smoke Project',
      path: tempDir,
    },
  });
  assert.equal(createdProject.activeProject.path, tempDir);

  const skillPayload = {
    name: 'Smoke Skill',
    description: 'Created by the M0 smoke test',
    body: 'Use this skill for smoke testing only.',
  };
  const skillResult = await fetchJson(baseUrl, '/api/skills', {
    method: 'POST',
    body: skillPayload,
  });
  assert.equal(skillResult.skill.name, 'Smoke Skill');

  const agentResult = await fetchJson(baseUrl, '/api/agents', {
    method: 'POST',
    body: {
      name: 'Smoke Agent',
      description: 'Created by the M0 smoke test',
      personaPrompt: 'Reply briefly.',
      skillIds: [skillResult.skill.id],
    },
  });
  assert.equal(agentResult.agent.name, 'Smoke Agent');

  const conversationResult = await fetchJson(baseUrl, '/api/conversations', {
    method: 'POST',
    body: {
      title: 'Smoke Conversation',
      participants: [agentResult.agent.id],
    },
  });
  assert.equal(conversationResult.conversation.title, 'Smoke Conversation');
  assert.ok(Array.isArray(conversationResult.conversation.agents));
  assert.equal(conversationResult.conversation.agents[0].id, agentResult.agent.id);

  assert.equal(stderrText.trim(), '');
});
