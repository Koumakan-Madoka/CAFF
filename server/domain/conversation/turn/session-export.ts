const path = require('node:path');
const { resolveSessionPath } = require('../../../../lib/minimal-pi');
const { createHttpError } = require('../../../http/http-errors');

export function isPathWithin(parentDir: any, targetPath: any) {
  const relative = path.relative(parentDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function createSessionExporter(options: any = {}) {
  const agentDir = path.resolve(String(options.agentDir || '').trim());
  const sessionsDir = path.resolve(agentDir, 'named-sessions');

  function resolveAssistantMessageSessionPath(message: any) {
    if (!message || message.role !== 'assistant') {
      throw createHttpError(400, 'Only assistant messages can export a session');
    }

    const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    const sessionPathValue = metadata && metadata.sessionPath ? String(metadata.sessionPath).trim() : '';
    const sessionNameValue = metadata && metadata.sessionName ? String(metadata.sessionName).trim() : '';
    const sessionPath = sessionPathValue
      ? path.resolve(sessionPathValue)
      : sessionNameValue
        ? resolveSessionPath(sessionNameValue, agentDir)
        : '';

    if (!sessionPath) {
      throw createHttpError(404, 'No session is available for this message yet');
    }

    if (!isPathWithin(sessionsDir, sessionPath)) {
      throw createHttpError(400, 'Session path is outside the allowed export directory');
    }

    return sessionPath;
  }

  return {
    resolveAssistantMessageSessionPath,
  };
}
