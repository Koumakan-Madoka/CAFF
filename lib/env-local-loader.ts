const fs = require('node:fs');
const path = require('node:path');

function normalizeEnvKey(value: any) {
  return String(value || '').trim();
}

function normalizeEnvValue(value: any) {
  const trimmed = String(value || '').trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const firstChar = trimmed[0];
  const lastChar = trimmed[trimmed.length - 1];
  if (firstChar !== lastChar || (firstChar !== '"' && firstChar !== "'")) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  if (firstChar === "'") {
    return inner;
  }

  return inner
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseEnvLine(line: any) {
  const normalizedLine = String(line || '').replace(/^\uFEFF/, '').trim();
  if (!normalizedLine || normalizedLine.startsWith('#')) {
    return null;
  }

  const lineWithoutExport = normalizedLine.startsWith('export ')
    ? normalizedLine.slice('export '.length).trim()
    : normalizedLine;
  const separatorIndex = lineWithoutExport.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }

  const key = normalizeEnvKey(lineWithoutExport.slice(0, separatorIndex));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
    return null;
  }

  return {
    key,
    value: normalizeEnvValue(lineWithoutExport.slice(separatorIndex + 1)),
  };
}

export function parseEnvFile(content: any) {
  const parsed: Record<string, string> = {};
  const text = String(content || '');
  const lines = text.split(/\r?\n/u);

  for (const line of lines) {
    const entry = parseEnvLine(line);
    if (!entry) {
      continue;
    }

    parsed[entry.key] = entry.value;
  }

  return parsed;
}

export function loadDotEnvLocal(options: any = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  if (String(env.CAFF_DISABLE_ENV_LOCAL || '').trim() === '1') {
    return {
      filePath: '',
      exists: false,
      loaded: false,
      appliedKeys: [],
      skippedKeys: [],
      disabled: true,
    };
  }

  const explicitPath = String(options.filePath || '').trim();
  const cwd = path.resolve(String(options.cwd || process.cwd()).trim() || process.cwd());
  const fileName = String(options.fileName || '.env.local').trim() || '.env.local';
  const filePath = explicitPath ? path.resolve(explicitPath) : path.resolve(cwd, fileName);

  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      loaded: false,
      appliedKeys: [],
      skippedKeys: [],
      disabled: false,
    };
  }

  const parsed = parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  const appliedKeys: string[] = [];
  const skippedKeys: string[] = [];
  const override = options.override === true;

  for (const [key, value] of Object.entries(parsed)) {
    if (!override && Object.prototype.hasOwnProperty.call(env, key)) {
      skippedKeys.push(key);
      continue;
    }

    env[key] = value;
    appliedKeys.push(key);
  }

  return {
    filePath,
    exists: true,
    loaded: appliedKeys.length > 0,
    appliedKeys,
    skippedKeys,
    disabled: false,
  };
}
