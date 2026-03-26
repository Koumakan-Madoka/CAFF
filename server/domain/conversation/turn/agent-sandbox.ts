const fs = require('node:fs');
const path = require('node:path');

export function sanitizeSandboxSegment(value, fallback = 'agent') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return normalized || fallback;
}

export function resolveAgentSandboxSegment(agent) {
  const fallbackSegment = sanitizeSandboxSegment(agent && agent.id ? agent.id : '', 'agent');
  return sanitizeSandboxSegment(agent && agent.sandboxName ? agent.sandboxName : agent && agent.id ? agent.id : '', fallbackSegment);
}

export function resolveAgentSandboxDir(agentDir, agent) {
  return path.resolve(agentDir, 'agent-sandboxes', resolveAgentSandboxSegment(agent));
}

export function resolveAgentPrivateDir(agentDir, agent) {
  return path.join(resolveAgentSandboxDir(agentDir, agent), 'private');
}

export function ensureAgentSandbox(agentDir, agent) {
  const sandboxDir = resolveAgentSandboxDir(agentDir, agent);
  const privateDir = resolveAgentPrivateDir(agentDir, agent);
  fs.mkdirSync(privateDir, { recursive: true });
  return { sandboxDir, privateDir };
}

export function toPortableShellPath(filePath) {
  return path.resolve(String(filePath || '')).replace(/\\/g, '/');
}

