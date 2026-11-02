// Synthetic source values use the REAL capture normalizer. No provider secrets.
const fixture = require('./badcase-caff-bridge-fixture.cjs');
const { replaceControlledVariables } = require('../../build/server/domain/runtime/badcase-capture/secrets');
module.exports = (t, mode = 'fresh', platform = 'linux') => fixture(t, mode, platform, ({ cp, r, session, put }) => {
  const values = { CAFF_CHAT_API_URL: 'http://127.0.0.1:54321', CAFF_CHAT_INVOCATION_ID: 'old-local-invocation',
    CAFF_CHAT_CALLBACK_TOKEN: 'old-local-callback-auth', CAFF_CHAT_CONVERSATION_ID: 'old-conversation', CAFF_CHAT_TURN_ID: 'old-execution',
    CAFF_CHAT_TOOLS_PATH: '/old/distribution/cli.js', CAFF_CHAT_TOOLS_RELATIVE_PATH: '../tools/bridge.js' };
  const prompt = replaceControlledVariables('Inspect ' + cp.targetDir + '\nRuntime:\n' + Object.keys(values).map(n => n + ': ' + values[n]).join('\n'), values);
  r.promptBlobHash = r.normalizedPromptHash = put(prompt.text); r.controlledReplacements = prompt.replacements;
  if (mode === 'resume') {
    session[2].message.content += '\nUse ' + values.CAFF_CHAT_API_URL;
    session[3].message.content[0].text += '\nUse ' + values.CAFF_CHAT_CALLBACK_TOKEN;
    const normalized = replaceControlledVariables(session.map(JSON.stringify).join('\r\n') + '\r\n', values);
    r.sessionBlobHash = put(normalized.text); r.controlledReplacements.push(...normalized.replacements);
  }
});
