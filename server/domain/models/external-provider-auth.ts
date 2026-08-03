import fs from 'node:fs';
import path from 'node:path';

function isPlainObject(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readExternalAuthProviderIds(agentDir: any) {
  const normalizedAgentDir = typeof agentDir === 'string' ? agentDir.trim() : '';
  if (!normalizedAgentDir) {
    return new Set<string>();
  }

  const authPath = path.join(path.resolve(normalizedAgentDir), 'auth.json');

  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    if (!isPlainObject(parsed)) {
      return new Set<string>();
    }

    return new Set(
      Object.entries(parsed)
        .filter(([, credential]) => isPlainObject(credential) && typeof credential.type === 'string' && credential.type.trim())
        .map(([providerId]) => providerId.trim())
        .filter(Boolean)
    );
  } catch {
    return new Set<string>();
  }
}
