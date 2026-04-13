const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveSkillTestOpenSandboxChatApiUrl } = require('../../build/server/app/config');

test('resolveSkillTestOpenSandboxChatApiUrl prefers explicit sandbox override', () => {
  const result = resolveSkillTestOpenSandboxChatApiUrl({
    explicitUrl: 'https://sandbox-bridge.example.test/',
    advertisedUrl: 'https://advertised.example.test',
    host: '192.168.1.20',
    port: 3100,
  });

  assert.equal(result, 'https://sandbox-bridge.example.test');
});

test('resolveSkillTestOpenSandboxChatApiUrl falls back to advertised base url', () => {
  const result = resolveSkillTestOpenSandboxChatApiUrl({
    advertisedUrl: 'https://advertised.example.test/',
    host: '0.0.0.0',
    port: 3100,
  });

  assert.equal(result, 'https://advertised.example.test');
});

test('resolveSkillTestOpenSandboxChatApiUrl ignores wildcard and loopback listen hosts', () => {
  assert.equal(resolveSkillTestOpenSandboxChatApiUrl({ host: '0.0.0.0', port: 3100 }), '');
  assert.equal(resolveSkillTestOpenSandboxChatApiUrl({ host: '127.0.0.1', port: 3100 }), '');
  assert.equal(resolveSkillTestOpenSandboxChatApiUrl({ host: 'localhost', port: 3100 }), '');
});

test('resolveSkillTestOpenSandboxChatApiUrl derives a url from a concrete host', () => {
  const result = resolveSkillTestOpenSandboxChatApiUrl({
    host: '192.168.31.48',
    port: 3100,
  });

  assert.equal(result, 'http://192.168.31.48:3100');
});
