import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { createHttpError } from '../../http/http-errors';
import { ROOT_DIR } from '../../app/config';
import type { SkillTestEnvironmentRuntime } from './sandbox-tool-contract';

const tarStream = require('tar-stream');

const ALLOWED_ENVIRONMENT_POLICIES = new Set(['optional', 'required']);
const ALLOWED_ENVIRONMENT_REQUIREMENT_KINDS = new Set(['command', 'package', 'env', 'capability', 'service']);
const ALLOWED_ENVIRONMENT_DOC_MODES = new Set(['none', 'suggest-patch']);
const ALLOWED_ENVIRONMENT_CACHE_ROOTS = new Set(['project', 'private']);
const DEFAULT_ENVIRONMENT_BOOTSTRAP_TIMEOUT_SEC = 900;
const DEFAULT_ENVIRONMENT_VERIFY_TIMEOUT_SEC = 120;
const DEFAULT_ENVIRONMENT_CACHE_ROOT_DIR = path.join(ROOT_DIR, '.pi-sandbox', 'skill-test-environment-cache');
const DEFAULT_ENVIRONMENT_MANIFEST_ROOT_DIR = path.join(ROOT_DIR, '.pi-sandbox', 'skill-test-environment-manifests');
const TESTING_DOCUMENT_ENVIRONMENT_BLOCK_TOKEN = 'skill-test-environment';
const UNSUPPORTED_ENVIRONMENT_CAPABILITIES = new Set([
  'gui',
  'browser',
  'administrator',
  'admin',
  'system-service',
  'service-manager',
  'hardware',
  'device',
  'physical-device',
  'credential',
  'credentials',
  'real-login',
  'login',
  'account',
  'oauth',
]);

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value: any) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePathForJson(value: any) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function hasOwn(value: any, key: string) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function buildValidationIssue(code: string, severity: 'error' | 'warning' | 'needs-review', path: string, message: string) {
  return { code, severity, path, message };
}

function mergeValidationIssues(...groups: any[]) {
  const merged: any[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const entry of group) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const issue = buildValidationIssue(
        String(entry.code || 'validation_issue').trim() || 'validation_issue',
        entry.severity === 'warning' || entry.severity === 'needs-review' ? entry.severity : 'error',
        String(entry.path || '').trim(),
        String(entry.message || '').trim()
      );
      const key = `${issue.code}\u0000${issue.severity}\u0000${issue.path}\u0000${issue.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(issue);
    }
  }
  return merged;
}

function createValidationHttpError(issueOrIssues: any, fallbackMessage?: string, extraDetails: any = {}) {
  const issues = mergeValidationIssues(Array.isArray(issueOrIssues) ? issueOrIssues : [issueOrIssues]);
  const firstMessage = issues[0] && issues[0].message ? String(issues[0].message) : '';
  return createHttpError(400, fallbackMessage || firstMessage || 'Validation failed', {
    issues,
    ...(extraDetails && typeof extraDetails === 'object' ? extraDetails : {}),
  });
}

function slugifyValidationId(value: any, fallback: string) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

function normalizeBooleanFlag(value: any, fallback = true) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
}

function normalizePositiveInteger(value: any) {
  if (value == null || value === '') {
    return null;
  }
  const normalized = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function clipSkillTestText(value: any, maxLength = 240) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}
function escapeShellToken(value: any) {
  const text = String(value || '').trim();
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function normalizeEnvironmentPolicy(value: any, fallback = 'optional') {
  const normalized = String(value || fallback).trim().toLowerCase() || fallback;
  return ALLOWED_ENVIRONMENT_POLICIES.has(normalized) ? normalized : '';
}

function normalizeEnvironmentDocMode(value: any, fallback = 'suggest-patch') {
  const normalized = String(value || fallback).trim().toLowerCase() || fallback;
  return ALLOWED_ENVIRONMENT_DOC_MODES.has(normalized) ? normalized : '';
}

function hashSkillTestValue(value: any) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function stableStringify(value: any): string {
  if (value == null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    return JSON.stringify(String(value));
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizeEnvironmentCacheRoot(value: any, fallback = 'project') {
  const normalized = String(value || fallback).trim().toLowerCase() || fallback;
  return ALLOWED_ENVIRONMENT_CACHE_ROOTS.has(normalized) ? normalized : '';
}

function normalizeEnvironmentCacheRelativePath(value: any) {
  const raw = String(value || '').trim().replace(/\\+/g, '/');
  if (!raw || raw === '.' || raw === './') {
    return '';
  }
  if (raw.startsWith('/') || /^[a-z]:\//i.test(raw)) {
    return '';
  }
  const normalized = path.posix.normalize(raw.replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return '';
  }
  const topLevel = normalized.split('/')[0] || '';
  if (topLevel === '.git' || topLevel === '.trellis') {
    return '';
  }
  return normalized;
}

function normalizeEnvironmentAssetRef(input: any) {
  if (input == null || input === '') {
    return { asset: null, issues: [] };
  }
  if (!isPlainObject(input)) {
    return {
      asset: null,
      issues: [buildValidationIssue('environment_asset_invalid', 'error', 'environmentConfig.asset', 'asset must be an object')],
    };
  }

  const envProfile = String(input.envProfile || input.env_profile || input.profile || 'default').trim() || 'default';
  const image = String(input.image || input.imageRef || input.image_ref || '').trim();
  const manifestPath = normalizePathForJson(input.manifestPath || input.manifest_path || '');
  const imageDigest = String(input.imageDigest || input.image_digest || '').trim();
  const baseImageDigest = String(input.baseImageDigest || input.base_image_digest || '').trim();
  const testingMdHash = String(input.testingMdHash || input.testing_md_hash || '').trim();
  const manifestHash = String(input.manifestHash || input.manifest_hash || '').trim();
  const buildCaseId = String(input.buildCaseId || input.build_case_id || '').trim();
  const issues: any[] = [];

  if (!envProfile) {
    issues.push(buildValidationIssue('environment_asset_profile_required', 'error', 'environmentConfig.asset.envProfile', 'asset envProfile is required'));
  }

  return {
    asset: {
      enabled: hasOwn(input, 'enabled') ? normalizeBooleanFlag(input.enabled, true) : true,
      envProfile,
      image,
      imageDigest,
      baseImageDigest,
      testingMdHash,
      manifestHash,
      manifestPath,
      buildCaseId,
    },
    issues,
  };
}

function normalizeEnvironmentCachePathEntry(input: any, index: number) {
  if (!isPlainObject(input)) {
    return {
      entry: null,
      issues: [buildValidationIssue('environment_cache_path_invalid', 'error', `environmentConfig.cache.paths[${index}]`, 'cache path must be an object')],
    };
  }

  const root = normalizeEnvironmentCacheRoot(input.root);
  const relativePath = normalizeEnvironmentCacheRelativePath(input.path || input.relativePath);
  const issues: any[] = [];

  if (!root) {
    issues.push(buildValidationIssue(
      'environment_cache_root_invalid',
      'error',
      `environmentConfig.cache.paths[${index}].root`,
      `cache root must be one of: ${[...ALLOWED_ENVIRONMENT_CACHE_ROOTS].join(', ')}`
    ));
  }
  if (!relativePath) {
    issues.push(buildValidationIssue(
      'environment_cache_path_required',
      'error',
      `environmentConfig.cache.paths[${index}].path`,
      'cache path must be a non-empty relative path inside the sandbox case world'
    ));
  }

  if (issues.length > 0) {
    return { entry: null, issues };
  }

  return {
    entry: {
      root,
      path: relativePath,
    },
    issues: [],
  };
}

function normalizeEnvironmentRequirement(input: any, index: number) {
  if (typeof input === 'string') {
    const name = String(input || '').trim();
    if (!name) {
      return {
        requirement: null,
        issues: [buildValidationIssue('environment_requirement_invalid', 'error', `environmentConfig.requirements[${index}]`, 'Requirement name is required')],
      };
    }
    return {
      requirement: {
        id: slugifyValidationId(name, `req-${index + 1}`),
        kind: 'command',
        name,
        versionHint: '',
        required: true,
        installable: true,
        probeCommand: '',
      },
      issues: [],
    };
  }

  if (!isPlainObject(input)) {
    return {
      requirement: null,
      issues: [buildValidationIssue('environment_requirement_invalid', 'error', `environmentConfig.requirements[${index}]`, 'Requirement must be a string or object')],
    };
  }

  const kind = String(input.kind || 'command').trim().toLowerCase() || 'command';
  const name = String(input.name || input.command || input.envName || input.capability || '').trim();
  const issues: any[] = [];

  if (!ALLOWED_ENVIRONMENT_REQUIREMENT_KINDS.has(kind)) {
    issues.push(buildValidationIssue(
      'environment_requirement_kind_invalid',
      'error',
      `environmentConfig.requirements[${index}].kind`,
      `Requirement kind must be one of: ${[...ALLOWED_ENVIRONMENT_REQUIREMENT_KINDS].join(', ')}`
    ));
  }
  if (!name) {
    issues.push(buildValidationIssue(
      'environment_requirement_name_required',
      'error',
      `environmentConfig.requirements[${index}].name`,
      'Requirement name is required'
    ));
  }
  if (issues.length > 0) {
    return { requirement: null, issues };
  }

  const installableDefault = kind === 'command' || kind === 'package';
  return {
    requirement: {
      id: slugifyValidationId(input.id || `${kind}-${name}`, `req-${index + 1}`),
      kind,
      name,
      versionHint: String(input.versionHint || input.version_hint || '').trim(),
      required: normalizeBooleanFlag(input.required, true),
      installable: hasOwn(input, 'installable') ? normalizeBooleanFlag(input.installable, installableDefault) : installableDefault,
      probeCommand: String(input.probeCommand || input.probe_command || '').trim(),
    },
    issues: [],
  };
}

function normalizeEnvironmentCommandList(value: any, fieldPath: string, errorCode: string) {
  if (value == null) {
    return { commands: [], issues: [] };
  }
  if (!Array.isArray(value)) {
    return {
      commands: [],
      issues: [buildValidationIssue(errorCode, 'error', fieldPath, `${fieldPath} must be an array of commands`)],
    };
  }

  const commands = value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);

  if (commands.length !== value.length) {
    return {
      commands,
      issues: [buildValidationIssue(errorCode, 'error', fieldPath, `${fieldPath} items must be non-empty strings`)],
    };
  }

  return { commands, issues: [] };
}

function normalizeEnvironmentConfigInput(input: any, options: { partial?: boolean } = {}) {
  if (input == null || input === '') {
    return { config: null, issues: [] };
  }

  if (!isPlainObject(input)) {
    return {
      config: null,
      issues: [buildValidationIssue('environment_config_invalid', 'error', 'environmentConfig', 'environmentConfig must be an object')],
    };
  }
  if (Object.keys(input).length === 0) {
    return { config: null, issues: [] };
  }

  const partial = options.partial === true;
  const issues: any[] = [];
  const normalized: Record<string, any> = {};

  if (hasOwn(input, 'enabled')) {
    normalized.enabled = normalizeBooleanFlag(input.enabled, true);
  } else if (!partial) {
    normalized.enabled = true;
  }

  if (hasOwn(input, 'policy')) {
    const policy = normalizeEnvironmentPolicy(input.policy);
    if (!policy) {
      issues.push(buildValidationIssue('environment_policy_invalid', 'error', 'environmentConfig.policy', `policy must be one of: ${[...ALLOWED_ENVIRONMENT_POLICIES].join(', ')}`));
    } else {
      normalized.policy = policy;
    }
  } else if (!partial) {
    normalized.policy = 'optional';
  }

  if (hasOwn(input, 'requirements')) {
    if (!Array.isArray(input.requirements)) {
      issues.push(buildValidationIssue('environment_requirements_invalid', 'error', 'environmentConfig.requirements', 'requirements must be an array'));
    } else {
      const requirements: any[] = [];
      for (let index = 0; index < input.requirements.length; index += 1) {
        const normalizedRequirement = normalizeEnvironmentRequirement(input.requirements[index], index);
        issues.push(...normalizedRequirement.issues);
        if (normalizedRequirement.requirement) {
          requirements.push(normalizedRequirement.requirement);
        }
      }
      normalized.requirements = requirements;
    }
  } else if (!partial) {
    normalized.requirements = [];
  }

  if (hasOwn(input, 'bootstrap')) {
    if (!isPlainObject(input.bootstrap)) {
      issues.push(buildValidationIssue('environment_bootstrap_invalid', 'error', 'environmentConfig.bootstrap', 'bootstrap must be an object'));
    } else {
      const commandsResult = normalizeEnvironmentCommandList(input.bootstrap.commands, 'environmentConfig.bootstrap.commands', 'environment_bootstrap_commands_invalid');
      issues.push(...commandsResult.issues);
      const shell = hasOwn(input.bootstrap, 'shell')
        ? String(input.bootstrap.shell || '').trim().toLowerCase()
        : '';
      if (shell && shell !== 'bash') {
        issues.push(buildValidationIssue('environment_bootstrap_shell_invalid', 'error', 'environmentConfig.bootstrap.shell', 'bootstrap.shell must be bash when provided'));
      }
      normalized.bootstrap = {
        commands: commandsResult.commands,
        shell: shell || 'bash',
        timeoutSec: normalizePositiveInteger(input.bootstrap.timeoutSec || input.bootstrap.timeout_sec),
      };
    }
  } else if (!partial) {
    normalized.bootstrap = {
      commands: [],
      shell: 'bash',
      timeoutSec: DEFAULT_ENVIRONMENT_BOOTSTRAP_TIMEOUT_SEC,
    };
  }

  if (hasOwn(input, 'verify')) {
    if (!isPlainObject(input.verify)) {
      issues.push(buildValidationIssue('environment_verify_invalid', 'error', 'environmentConfig.verify', 'verify must be an object'));
    } else {
      const commandsResult = normalizeEnvironmentCommandList(input.verify.commands, 'environmentConfig.verify.commands', 'environment_verify_commands_invalid');
      issues.push(...commandsResult.issues);
      normalized.verify = {
        commands: commandsResult.commands,
        timeoutSec: normalizePositiveInteger(input.verify.timeoutSec || input.verify.timeout_sec),
      };
    }
  } else if (!partial) {
    normalized.verify = {
      commands: [],
      timeoutSec: DEFAULT_ENVIRONMENT_VERIFY_TIMEOUT_SEC,
    };
  }

  if (hasOwn(input, 'cache')) {
    if (!isPlainObject(input.cache)) {
      issues.push(buildValidationIssue('environment_cache_invalid', 'error', 'environmentConfig.cache', 'cache must be an object'));
    } else {
      const paths: any[] = [];
      if (hasOwn(input.cache, 'paths')) {
        if (!Array.isArray(input.cache.paths)) {
          issues.push(buildValidationIssue('environment_cache_paths_invalid', 'error', 'environmentConfig.cache.paths', 'cache.paths must be an array'));
        } else {
          for (let index = 0; index < input.cache.paths.length; index += 1) {
            const normalizedPath = normalizeEnvironmentCachePathEntry(input.cache.paths[index], index);
            issues.push(...normalizedPath.issues);
            if (normalizedPath.entry) {
              paths.push(normalizedPath.entry);
            }
          }
        }
      }

      normalized.cache = {
        enabled: hasOwn(input.cache, 'enabled') ? normalizeBooleanFlag(input.cache.enabled, true) : true,
        paths,
        maxArtifactBytes: normalizePositiveInteger(input.cache.maxArtifactBytes || input.cache.max_artifact_bytes),
        ttlHours: normalizePositiveInteger(input.cache.ttlHours || input.cache.ttl_hours),
      };
    }
  } else if (!partial) {
    normalized.cache = {
      enabled: false,
      paths: [],
      maxArtifactBytes: null,
      ttlHours: null,
    };
  }

  if (hasOwn(input, 'docs')) {
    if (!isPlainObject(input.docs)) {
      issues.push(buildValidationIssue('environment_docs_invalid', 'error', 'environmentConfig.docs', 'docs must be an object'));
    } else {
      const mode = hasOwn(input.docs, 'mode')
        ? normalizeEnvironmentDocMode(input.docs.mode)
        : '';
      if (hasOwn(input.docs, 'mode') && !mode) {
        issues.push(buildValidationIssue('environment_docs_mode_invalid', 'error', 'environmentConfig.docs.mode', `docs.mode must be one of: ${[...ALLOWED_ENVIRONMENT_DOC_MODES].join(', ')}`));
      }
      normalized.docs = {
        mode: mode || 'suggest-patch',
        target: String(input.docs.target || 'TESTING.md').trim() || 'TESTING.md',
      };
    }
  } else if (!partial) {
    normalized.docs = {
      mode: 'suggest-patch',
      target: 'TESTING.md',
    };
  }

  if (hasOwn(input, 'asset') || hasOwn(input, 'environmentAsset') || hasOwn(input, 'environment_asset')) {
    const assetSource = hasOwn(input, 'asset')
      ? input.asset
      : hasOwn(input, 'environmentAsset')
        ? input.environmentAsset
        : input.environment_asset;
    const assetResult = normalizeEnvironmentAssetRef(assetSource);
    issues.push(...assetResult.issues);
    if (assetResult.asset) {
      normalized.asset = assetResult.asset;
    }
  }

  if (issues.some((issue) => issue && issue.severity === 'error')) {
    return { config: null, issues };
  }

  if (partial) {
    return {
      config: Object.keys(normalized).length > 0 ? normalized : null,
      issues,
    };
  }

  return {
    config: {
      enabled: normalized.enabled !== false,
      policy: normalized.policy || 'optional',
      requirements: Array.isArray(normalized.requirements) ? normalized.requirements : [],
      bootstrap: normalized.bootstrap || {
        commands: [],
        shell: 'bash',
        timeoutSec: DEFAULT_ENVIRONMENT_BOOTSTRAP_TIMEOUT_SEC,
      },
      verify: normalized.verify || {
        commands: [],
        timeoutSec: DEFAULT_ENVIRONMENT_VERIFY_TIMEOUT_SEC,
      },
      cache: normalized.cache || {
        enabled: false,
        paths: [],
        maxArtifactBytes: null,
        ttlHours: null,
      },
      docs: normalized.docs || {
        mode: 'suggest-patch',
        target: 'TESTING.md',
      },
      asset: normalized.asset || null,
    },
    issues,
  };
}

function mergeEnvironmentConfig(baseConfig: any, overrideConfig: any) {
  if (!baseConfig && !overrideConfig) {
    return null;
  }

  const base = isPlainObject(baseConfig) ? baseConfig : {};
  const override = isPlainObject(overrideConfig) ? overrideConfig : {};
  const merged: any = {
    ...base,
    ...override,
  };

  if (base.bootstrap || override.bootstrap) {
    merged.bootstrap = {
      ...(isPlainObject(base.bootstrap) ? base.bootstrap : {}),
      ...(isPlainObject(override.bootstrap) ? override.bootstrap : {}),
    };
  }
  if (base.verify || override.verify) {
    merged.verify = {
      ...(isPlainObject(base.verify) ? base.verify : {}),
      ...(isPlainObject(override.verify) ? override.verify : {}),
    };
  }
  if (base.cache || override.cache) {
    merged.cache = {
      ...(isPlainObject(base.cache) ? base.cache : {}),
      ...(isPlainObject(override.cache) ? override.cache : {}),
    };
  }
  if (base.docs || override.docs) {
    merged.docs = {
      ...(isPlainObject(base.docs) ? base.docs : {}),
      ...(isPlainObject(override.docs) ? override.docs : {}),
    };
  }
  if (base.asset || override.asset || base.environmentAsset || override.environmentAsset || base.environment_asset || override.environment_asset) {
    merged.asset = {
      ...(isPlainObject(base.asset) ? base.asset : {}),
      ...(isPlainObject(base.environmentAsset) ? base.environmentAsset : {}),
      ...(isPlainObject(base.environment_asset) ? base.environment_asset : {}),
      ...(isPlainObject(override.asset) ? override.asset : {}),
      ...(isPlainObject(override.environmentAsset) ? override.environmentAsset : {}),
      ...(isPlainObject(override.environment_asset) ? override.environment_asset : {}),
    };
  }
  if (Array.isArray(override.requirements)) {
    merged.requirements = override.requirements;
  } else if (!Array.isArray(merged.requirements)) {
    merged.requirements = [];
  }
  if (isPlainObject(override.bootstrap) && Array.isArray(override.bootstrap.commands)) {
    merged.bootstrap.commands = override.bootstrap.commands;
  }
  if (isPlainObject(override.verify) && Array.isArray(override.verify.commands)) {
    merged.verify.commands = override.verify.commands;
  }
  if (isPlainObject(override.cache) && Array.isArray(override.cache.paths)) {
    merged.cache.paths = override.cache.paths;
  }

  return normalizeEnvironmentConfigInput(merged).config;
}

function normalizeEnvironmentRunInput(input: any) {
  if (input == null) {
    return {
      enabled: undefined,
      explicitEnabled: false,
      mode: 'case-default',
      allowBootstrap: true,
      persistAdvice: true,
      override: null,
      issues: [],
    };
  }

  if (!isPlainObject(input)) {
    throw createValidationHttpError(
      buildValidationIssue('environment_run_invalid', 'error', 'environment', 'environment run options must be an object')
    );
  }

  const mode = String(input.mode || 'case-default').trim().toLowerCase() || 'case-default';
  if (mode !== 'case-default' && mode !== 'override-only') {
    throw createValidationHttpError(
      buildValidationIssue('environment_run_mode_invalid', 'error', 'environment.mode', 'environment.mode must be case-default or override-only')
    );
  }

  const overrideResult = hasOwn(input, 'override')
    ? normalizeEnvironmentConfigInput(input.override, { partial: true })
    : { config: null, issues: [] };
  if (overrideResult.issues.some((issue) => issue && issue.severity === 'error')) {
    throw createValidationHttpError(overrideResult.issues);
  }

  return {
    enabled: hasOwn(input, 'enabled') ? normalizeBooleanFlag(input.enabled, true) : undefined,
    explicitEnabled: hasOwn(input, 'enabled'),
    mode,
    allowBootstrap: hasOwn(input, 'allowBootstrap') ? normalizeBooleanFlag(input.allowBootstrap, true) : true,
    persistAdvice: hasOwn(input, 'persistAdvice') ? normalizeBooleanFlag(input.persistAdvice, true) : true,
    override: overrideResult.config,
    issues: overrideResult.issues,
  };
}

export function readSkillTestingDocument(skill: any) {
  if (!skill || !skill.path) {
    return { path: '', exists: false, content: '', contentHash: '', readError: false };
  }

  const skillDir = path.resolve(String(skill.path || '').trim() || '.');
  const testingDocPath = path.join(skillDir, 'TESTING.md');
  if (!fs.existsSync(testingDocPath)) {
    return { path: testingDocPath, exists: false, content: '', contentHash: '', readError: false };
  }

  try {
    const content = fs.readFileSync(testingDocPath, 'utf8');
    return {
      path: testingDocPath,
      exists: true,
      content,
      contentHash: hashSkillTestValue(content),
      readError: false,
    };
  } catch {
    return { path: testingDocPath, exists: true, content: '', contentHash: '', readError: true };
  }
}

function extractTestingDocumentEnvironmentBlock(markdown: any) {
  const normalized = String(markdown || '').replace(/\r\n/g, '\n');
  const fencePattern = /(^|\n)(```+|~~~+)([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
  let match = null as RegExpExecArray | null;

  while ((match = fencePattern.exec(normalized))) {
    const infoTokens = String(match[3] || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!infoTokens.includes(TESTING_DOCUMENT_ENVIRONMENT_BLOCK_TOKEN)) {
      continue;
    }

    const rawContent = String(match[4] || '').trim();
    if (!rawContent) {
      return {
        found: true,
        config: null,
        issues: [
          buildValidationIssue(
            'testing_doc_contract_invalid',
            'warning',
            'TESTING.md#skill-test-environment',
            'TESTING.md 中的 skill-test-environment 合同块不能为空 JSON 对象'
          ),
        ],
      };
    }

    const parsed = safeJsonParse(rawContent);
    if (!isPlainObject(parsed)) {
      return {
        found: true,
        config: null,
        issues: [
          buildValidationIssue(
            'testing_doc_contract_invalid',
            'warning',
            'TESTING.md#skill-test-environment',
            'TESTING.md 中的 skill-test-environment 合同块必须是合法 JSON 对象'
          ),
        ],
      };
    }

    return {
      found: true,
      config: parsed,
      issues: [],
    };
  }

  return { found: false, config: null, issues: [] };
}

function formatEnvironmentRequirementDocLine(entry: any) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }

  const kind = String(entry.kind || 'command').trim().toLowerCase() || 'command';
  const name = String(entry.name || '').trim();
  const versionHint = String(entry.versionHint || '').trim();
  if (!name) {
    return '';
  }

  const label = versionHint ? `${name} (${versionHint})` : name;
  return kind && kind !== 'command' ? `[${kind}] ${label}` : label;
}

export function loadSkillTestingDocumentEnvironmentConfig(skill: any) {
  const testingDocument = readSkillTestingDocument(skill);
  if (!testingDocument.path) {
    return {
      config: null,
      issues: [],
      path: '',
      used: false,
      contentHash: '',
      content: '',
      contractBlockFound: false,
      contractBlockParsed: false,
    };
  }
  if (!testingDocument.exists || testingDocument.readError) {
    return {
      config: null,
      issues: [],
      path: testingDocument.path,
      used: false,
      contentHash: testingDocument.contentHash,
      content: testingDocument.content,
      contractBlockFound: false,
      contractBlockParsed: false,
    };
  }

  const contractBlock = extractTestingDocumentEnvironmentBlock(testingDocument.content);
  if (!contractBlock.found) {
    return {
      config: null,
      issues: [],
      path: testingDocument.path,
      used: false,
      contentHash: testingDocument.contentHash,
      content: testingDocument.content,
      contractBlockFound: false,
      contractBlockParsed: false,
    };
  }

  const contractSource = isPlainObject(contractBlock.config) ? contractBlock.config : null;
  if (!contractSource) {
    return {
      config: null,
      issues: Array.isArray(contractBlock.issues) ? contractBlock.issues : [],
      path: testingDocument.path,
      used: false,
      contentHash: testingDocument.contentHash,
      content: testingDocument.content,
      contractBlockFound: true,
      contractBlockParsed: false,
    };
  }

  const normalized = normalizeEnvironmentConfigInput({
    ...contractSource,
    enabled: hasOwn(contractSource, 'enabled') ? contractSource.enabled : true,
    docs: {
      ...(isPlainObject(contractSource.docs) ? contractSource.docs : {}),
      mode: isPlainObject(contractSource.docs) && contractSource.docs.mode ? contractSource.docs.mode : 'suggest-patch',
      target: 'TESTING.md',
    },
  });

  return {
    config: normalized.config,
    issues: mergeValidationIssues(contractBlock.issues, normalized.issues),
    path: testingDocument.path,
    used: Boolean(normalized.config),
    contentHash: testingDocument.contentHash,
    content: testingDocument.content,
    contractBlockFound: true,
    contractBlockParsed: Boolean(normalized.config),
  };
}

function resolveEnvironmentRunConfig(testCase: any, runEnvironment: any, skill: any = null, options: any = {}) {
  const request = normalizeEnvironmentRunInput(runEnvironment);
  const caseConfig = isPlainObject(testCase && testCase.environmentConfig) ? testCase.environmentConfig : null;
  const allowTestingDocumentDefault = options && options.allowTestingDocumentDefault !== false;
  const shouldLoadTestingDocument = !caseConfig
    && request.mode !== 'override-only'
    && (allowTestingDocumentDefault || request.explicitEnabled === true || Boolean(request.override));
  const testingDocument = shouldLoadTestingDocument
    ? loadSkillTestingDocumentEnvironmentConfig(skill)
    : { config: null, issues: [], path: '', used: false, contentHash: '' };
  const baseConfig = request.mode === 'override-only'
    ? null
    : (caseConfig || testingDocument.config);
  const mergedConfig = mergeEnvironmentConfig(baseConfig, request.override);
  const enabled = request.enabled !== undefined
    ? request.enabled
    : Boolean(mergedConfig && mergedConfig.enabled === true);

  return {
    enabled,
    allowBootstrap: request.allowBootstrap,
    persistAdvice: request.persistAdvice,
    config: enabled && mergedConfig ? mergedConfig : null,
    issues: [...(Array.isArray(testingDocument.issues) ? testingDocument.issues : []), ...request.issues],
    source: {
      testingDocPath: testingDocument && testingDocument.path ? normalizePathForJson(testingDocument.path) : '',
      testingDocUsed: Boolean(!caseConfig && testingDocument && testingDocument.used),
      testingDocHash: testingDocument && testingDocument.contentHash ? String(testingDocument.contentHash) : '',
    },
  };
}

function buildEnvironmentAdvice(config: any, result: any) {
  const docs = config && isPlainObject(config.docs) ? config.docs : { mode: 'suggest-patch', target: 'TESTING.md' };
  if (docs.mode !== 'suggest-patch') {
    return null;
  }

  const requirements = result && result.requirements ? result.requirements : { satisfied: [], missing: [], unsupported: [] };
  const bootstrapCommands = Array.isArray(result && result.bootstrap && result.bootstrap.commands) ? result.bootstrap.commands : [];
  const verifyCommands = Array.isArray(result && result.verify && result.verify.commands) ? result.verify.commands : [];
  const unsupportedLines = Array.isArray(requirements.unsupported)
    ? requirements.unsupported.map((entry: any) => `- ${entry.name}: ${entry.reason || 'unsupported'}`)
    : [];
  const requirementLines = Array.isArray((config && config.requirements))
    ? config.requirements
      .map((entry: any) => formatEnvironmentRequirementDocLine(entry))
      .filter(Boolean)
      .map((entry: string) => `- ${entry}`)
    : [];
  const patch = [
    '# Testing Environment',
    '',
    '## Prerequisites',
    ...(requirementLines.length > 0 ? requirementLines : ['- None recorded yet.']),
    '',
    '## Bootstrap',
    ...(bootstrapCommands.length > 0 ? bootstrapCommands.map((command: string) => `- ` + command) : ['- No bootstrap commands recorded.']),
    '',
    '## Verification',
    ...(verifyCommands.length > 0 ? verifyCommands.map((command: string) => `- ` + command) : ['- No verification commands recorded.']),
    '',
    '## Known Limits',
    ...(unsupportedLines.length > 0 ? unsupportedLines : ['- No known runtime limits recorded.']),
    '',
  ].join('\n');

  return {
    target: String(docs.target || 'TESTING.md').trim() || 'TESTING.md',
    mode: docs.mode,
    patch,
    summary: clipSkillTestText(`Environment ${result && result.status ? result.status : 'skipped'}; generated ${docs.target || 'TESTING.md'} advice`, 180),
  };
}

function createEnvironmentCacheResult(input: any = {}) {
  return {
    enabled: Boolean(input.enabled),
    eligible: Boolean(input.eligible),
    key: String(input.key || '').trim(),
    planHash: String(input.planHash || '').trim(),
    worldHash: String(input.worldHash || '').trim(),
    status: String(input.status || '').trim() || (input.enabled ? 'disabled' : 'disabled'),
    reason: String(input.reason || '').trim(),
    paths: Array.isArray(input.paths) ? input.paths.map((entry: any) => ({
      root: String(entry && entry.root || '').trim(),
      path: String(entry && entry.path || '').trim(),
    })).filter((entry: any) => entry.root && entry.path) : [],
    manifestPath: String(input.manifestPath || '').trim(),
    summaryPath: String(input.summaryPath || '').trim(),
    artifactBytes: Number.isFinite(input.artifactBytes) ? Number(input.artifactBytes) : null,
    artifactSha256: String(input.artifactSha256 || '').trim(),
    restoredFiles: Number.isFinite(input.restoredFiles) ? Number(input.restoredFiles) : 0,
    restoredDirectories: Number.isFinite(input.restoredDirectories) ? Number(input.restoredDirectories) : 0,
    restoredSymlinks: Number.isFinite(input.restoredSymlinks) ? Number(input.restoredSymlinks) : 0,
    ignoredEntries: Number.isFinite(input.ignoredEntries) ? Number(input.ignoredEntries) : 0,
    createdAt: String(input.createdAt || '').trim(),
    savedAt: String(input.savedAt || '').trim(),
    expiresAt: String(input.expiresAt || '').trim(),
    lastValidatedAt: String(input.lastValidatedAt || '').trim(),
  };
}

function resolveEnvironmentCacheRootDir(root: string, runtime: SkillTestEnvironmentRuntime | null = null) {
  if (root === 'private') {
    return runtime && runtime.privateDir ? String(runtime.privateDir).trim() : '';
  }
  return runtime && runtime.projectDir ? String(runtime.projectDir).trim() : '';
}

function resolveEnvironmentCacheEntryPaths(cacheMeta: any, runtime: SkillTestEnvironmentRuntime | null = null) {
  const cacheRootDir = String(runtime && runtime.environmentCacheRootDir || DEFAULT_ENVIRONMENT_CACHE_ROOT_DIR).trim() || DEFAULT_ENVIRONMENT_CACHE_ROOT_DIR;
  const key = String(cacheMeta && cacheMeta.key || '').trim();
  const entryDir = key ? path.join(cacheRootDir, key) : '';
  return {
    cacheRootDir,
    entryDir,
    manifestPath: entryDir ? path.join(entryDir, 'manifest.json') : '',
    artifactPath: entryDir ? path.join(entryDir, 'artifact.tgz') : '',
    summaryPath: entryDir ? path.join(entryDir, 'summary.json') : '',
  };
}

function readEnvironmentCacheJsonFile(filePath: string) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = safeJsonParse(fs.readFileSync(filePath, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function computeEnvironmentCacheExpiresAt(baseAt: any, ttlHours: any) {
  const normalizedTtlHours = normalizePositiveInteger(ttlHours);
  const baseValue = String(baseAt || '').trim();
  if (!normalizedTtlHours || !baseValue) {
    return '';
  }
  const baseTime = Date.parse(baseValue);
  if (!Number.isFinite(baseTime)) {
    return '';
  }
  return new Date(baseTime + normalizedTtlHours * 60 * 60 * 1000).toISOString();
}

function isEnvironmentCacheManifestExpired(manifest: any, config: any, nowMs = Date.now()) {
  if (!isPlainObject(manifest)) {
    return false;
  }

  const explicitExpiresAt = String(manifest.expiresAt || '').trim();
  if (explicitExpiresAt) {
    const explicitExpiresTime = Date.parse(explicitExpiresAt);
    if (Number.isFinite(explicitExpiresTime) && explicitExpiresTime <= nowMs) {
      return true;
    }
  }

  const ttlHours = normalizePositiveInteger(config && config.cache && config.cache.ttlHours);
  const freshnessValue = String(manifest.lastValidatedAt || manifest.savedAt || manifest.createdAt || '').trim();
  if (!ttlHours || !freshnessValue) {
    return false;
  }

  const freshnessTime = Date.parse(freshnessValue);
  if (!Number.isFinite(freshnessTime)) {
    return false;
  }

  return (nowMs - freshnessTime) > ttlHours * 60 * 60 * 1000;
}

function resolveEnvironmentCacheVisiblePath(hostPath: string, runtime: SkillTestEnvironmentRuntime | null = null, envKeys: string[] = []) {
  const normalizedHostPath = String(hostPath || '').trim();
  const adapter = runtime && runtime.sandboxToolAdapter ? runtime.sandboxToolAdapter : null;

  if (normalizedHostPath && adapter && typeof adapter.mapHostPathToRemote === 'function') {
    try {
      const remotePath = adapter.mapHostPathToRemote(normalizedHostPath);
      if (remotePath) {
        return normalizePathForJson(remotePath);
      }
    } catch {}
  }

  const env = runtime && runtime.commandEnv && typeof runtime.commandEnv === 'object' ? runtime.commandEnv : {};
  for (const key of envKeys) {
    const value = String(env && env[key] || '').trim();
    if (value) {
      return normalizePathForJson(value);
    }
  }

  return normalizePathForJson(normalizedHostPath);
}

function buildEnvironmentCacheSaveCommand(cachePaths: any[], runtime: SkillTestEnvironmentRuntime | null = null) {
  const outputDir = runtime && runtime.outputDir ? String(runtime.outputDir).trim() : '';
  if (!outputDir) {
    throw new Error('Sandbox output dir is unavailable for cache save');
  }

  const outputVisibleDir = resolveEnvironmentCacheVisiblePath(outputDir, runtime, [
    'CAFF_SKILL_TEST_VISIBLE_OUTPUT_DIR',
    'CAFF_SKILL_TEST_REMOTE_OUTPUT_DIR',
  ]);
  if (!outputVisibleDir) {
    throw new Error('Sandbox-visible output dir is unavailable for cache save');
  }

  const artifactDir = path.posix.join(outputVisibleDir, 'environment-cache');
  const stagingDir = path.posix.join(artifactDir, 'staging');
  const artifactVisiblePath = path.posix.join(artifactDir, 'artifact.tgz');
  const artifactHostPath = path.join(outputDir, 'environment-cache', 'artifact.tgz');
  const copyCommands: string[] = [];

  for (const entry of Array.isArray(cachePaths) ? cachePaths : []) {
    const root = String(entry && entry.root || '').trim();
    const relativePath = normalizeEnvironmentCacheRelativePath(entry && entry.path);
    const rootDir = resolveEnvironmentCacheRootDir(root, runtime);
    if (!root || !relativePath || !rootDir) {
      continue;
    }

    const sourceHostPath = path.join(rootDir, ...relativePath.split('/'));
    const sourceVisiblePath = resolveEnvironmentCacheVisiblePath(sourceHostPath, runtime);
    const targetVisiblePath = path.posix.join(stagingDir, root, relativePath);
    copyCommands.push(
      `if [ -e ${escapeShellToken(sourceVisiblePath)} ] || [ -L ${escapeShellToken(sourceVisiblePath)} ]; then mkdir -p ${escapeShellToken(path.posix.dirname(targetVisiblePath))}; cp -a ${escapeShellToken(sourceVisiblePath)} ${escapeShellToken(targetVisiblePath)}; copied=1; fi`
    );
  }

  if (copyCommands.length === 0) {
    throw new Error('No declared cache paths are available for export');
  }

  return {
    artifactHostPath,
    command: [
      'set -e',
      `artifact_dir=${escapeShellToken(artifactDir)}`,
      `staging_dir=${escapeShellToken(stagingDir)}`,
      `artifact_path=${escapeShellToken(artifactVisiblePath)}`,
      'rm -rf "$staging_dir"',
      'mkdir -p "$artifact_dir"',
      'mkdir -p "$staging_dir"',
      'copied=0',
      ...copyCommands,
      'if [ "$copied" -ne 1 ]; then echo "no declared cache paths are present in the sandbox world" >&2; exit 3; fi',
      'rm -f "$artifact_path"',
      'cd "$staging_dir"',
      'tar -czf "$artifact_path" .',
    ].join('\n'),
  };
}

function runEnvironmentCacheJanitor(config: any, runtime: SkillTestEnvironmentRuntime | null = null, options: any = {}) {
  const entryPaths = resolveEnvironmentCacheEntryPaths({ key: '__janitor__' }, runtime);
  const cacheRootDir = entryPaths.cacheRootDir;
  if (!cacheRootDir || !fs.existsSync(cacheRootDir)) {
    return { removedEntries: 0 };
  }

  const keepKey = String(options && options.keepKey || '').trim();
  const nowMs = Number.isFinite(options && options.nowMs) ? Number(options.nowMs) : Date.now();
  let removedEntries = 0;

  for (const dirent of fs.readdirSync(cacheRootDir, { withFileTypes: true })) {
    if (!dirent || !dirent.isDirectory()) {
      continue;
    }
    if (keepKey && dirent.name === keepKey) {
      continue;
    }

    const entryDir = path.join(cacheRootDir, dirent.name);
    const manifestPath = path.join(entryDir, 'manifest.json');
    const artifactPath = path.join(entryDir, 'artifact.tgz');
    const manifest = readEnvironmentCacheJsonFile(manifestPath);
    const missingCoreFiles = !fs.existsSync(manifestPath) || !fs.existsSync(artifactPath);
    const invalidManifest = fs.existsSync(manifestPath) && !manifest;
    const expired = manifest ? isEnvironmentCacheManifestExpired(manifest, config, nowMs) : false;

    if (!missingCoreFiles && !invalidManifest && !expired) {
      continue;
    }

    try {
      fs.rmSync(entryDir, { recursive: true, force: true });
      removedEntries += 1;
    } catch {}
  }

  return { removedEntries };
}

function buildEnvironmentCacheManifest(cacheMeta: any, config: any, runtime: SkillTestEnvironmentRuntime | null = null, input: any = {}) {
  const savedAt = String(input.savedAt || '').trim() || nowIso();
  const createdAt = String(input.createdAt || '').trim() || savedAt;
  const expiresAt = computeEnvironmentCacheExpiresAt(savedAt, config && config.cache && config.cache.ttlHours);
  const bootstrapCommands = Array.isArray(config && config.bootstrap && config.bootstrap.commands)
    ? config.bootstrap.commands.map((entry: any) => String(entry || '').trim())
    : [];
  const verifyCommands = Array.isArray(config && config.verify && config.verify.commands)
    ? config.verify.commands.map((entry: any) => String(entry || '').trim())
    : [];

  return {
    cacheKey: String(cacheMeta && cacheMeta.key || '').trim(),
    skillId: String(runtime && runtime.skillId || '').trim(),
    planHash: String(cacheMeta && cacheMeta.planHash || '').trim(),
    worldHash: String(cacheMeta && cacheMeta.worldHash || '').trim(),
    createdAt,
    savedAt,
    expiresAt,
    lastValidatedAt: savedAt,
    driver: {
      name: String(runtime && runtime.driver && runtime.driver.name || '').trim(),
      version: String(runtime && runtime.driver && runtime.driver.version || '').trim(),
    },
    platform: {
      os: String(runtime && runtime.platform || process.platform).trim(),
      arch: String(runtime && runtime.arch || process.arch).trim(),
    },
    paths: Array.isArray(cacheMeta && cacheMeta.paths) ? cacheMeta.paths.map((entry: any) => ({
      root: String(entry && entry.root || '').trim(),
      path: String(entry && entry.path || '').trim(),
    })).filter((entry: any) => entry.root && entry.path) : [],
    bootstrapCommandDigest: hashSkillTestValue(stableStringify(bootstrapCommands)),
    verifyCommandDigest: hashSkillTestValue(stableStringify(verifyCommands)),
    artifactSha256: String(input.artifactSha256 || '').trim(),
    artifactBytes: Number.isFinite(input.artifactBytes) ? Number(input.artifactBytes) : null,
  };
}

function buildEnvironmentCacheSummary(cacheMeta: any, manifest: any, entryPaths: any, input: any = {}) {
  const savedAt = String(manifest && manifest.savedAt || input.savedAt || '').trim();
  const lastValidatedAt = String(manifest && manifest.lastValidatedAt || input.lastValidatedAt || '').trim();
  const status = String(input.status || '').trim() || 'saved';
  const reason = String(input.reason || '').trim();
  return {
    cacheKey: String(cacheMeta && cacheMeta.key || '').trim(),
    skillId: String(input.skillId || '').trim(),
    createdAt: String(manifest && manifest.createdAt || '').trim(),
    savedAt,
    expiresAt: String(manifest && manifest.expiresAt || '').trim(),
    lastValidatedAt,
    status,
    reason,
    manifestPath: normalizePathForJson(entryPaths && entryPaths.manifestPath || ''),
    artifactPath: normalizePathForJson(entryPaths && entryPaths.artifactPath || ''),
    artifactSha256: String(manifest && manifest.artifactSha256 || '').trim(),
    artifactBytes: Number.isFinite(manifest && manifest.artifactBytes) ? Number(manifest.artifactBytes) : null,
  };
}

function buildEnvironmentCacheMetadata(config: any, runtime: SkillTestEnvironmentRuntime | null = null, source: any = {}) {
  const cacheConfig = config && isPlainObject(config.cache) ? config.cache : null;
  const cachePaths = Array.isArray(cacheConfig && cacheConfig.paths) ? cacheConfig.paths : [];
  if (!cacheConfig || cacheConfig.enabled !== true) {
    return createEnvironmentCacheResult({
      enabled: false,
      eligible: false,
      status: 'disabled',
      reason: 'environment cache not enabled',
      paths: cachePaths,
    });
  }
  if (cachePaths.length === 0) {
    return createEnvironmentCacheResult({
      enabled: true,
      eligible: false,
      status: 'disabled',
      reason: 'no cache paths configured',
      paths: cachePaths,
    });
  }

  const skillId = String(runtime && runtime.skillId || '').trim();
  const planInput = {
    skillId,
    requirements: Array.isArray(config && config.requirements)
      ? config.requirements.map((entry: any) => ({
          kind: String(entry && entry.kind || '').trim(),
          name: String(entry && entry.name || '').trim(),
          versionHint: String(entry && entry.versionHint || '').trim(),
          required: entry && entry.required !== false,
          installable: entry && entry.installable === true,
          probeCommand: String(entry && entry.probeCommand || '').trim(),
        }))
      : [],
    bootstrap: {
      commands: Array.isArray(config && config.bootstrap && config.bootstrap.commands) ? config.bootstrap.commands.map((entry: any) => String(entry || '').trim()) : [],
      shell: String(config && config.bootstrap && config.bootstrap.shell || '').trim(),
      timeoutSec: normalizePositiveInteger(config && config.bootstrap && config.bootstrap.timeoutSec) || null,
    },
    verify: {
      commands: Array.isArray(config && config.verify && config.verify.commands) ? config.verify.commands.map((entry: any) => String(entry || '').trim()) : [],
      timeoutSec: normalizePositiveInteger(config && config.verify && config.verify.timeoutSec) || null,
    },
    cache: {
      paths: cachePaths.map((entry: any) => ({ root: String(entry && entry.root || '').trim(), path: String(entry && entry.path || '').trim() })),
      maxArtifactBytes: normalizePositiveInteger(cacheConfig.maxArtifactBytes) || null,
      ttlHours: normalizePositiveInteger(cacheConfig.ttlHours) || null,
    },
    source: {
      testingDocHash: String(source && source.testingDocHash || '').trim(),
      testingDocUsed: Boolean(source && source.testingDocUsed),
    },
  };
  const worldInput = {
    isolationMode: String(runtime && runtime.isolation && runtime.isolation.mode || '').trim(),
    egressMode: String(runtime && runtime.isolation && runtime.isolation.egressMode || '').trim(),
    toolRuntime: String(runtime && (runtime.toolRuntime || runtime.execution && runtime.execution.toolRuntime) || '').trim(),
    pathSemantics: String(runtime && runtime.execution && runtime.execution.pathSemantics || '').trim(),
    driverName: String(runtime && runtime.driver && runtime.driver.name || '').trim(),
    driverVersion: String(runtime && runtime.driver && runtime.driver.version || '').trim(),
    platform: String(runtime && runtime.platform || process.platform).trim(),
    arch: String(runtime && runtime.arch || process.arch).trim(),
  };

  const planHash = hashSkillTestValue(stableStringify(planInput));
  const worldHash = hashSkillTestValue(stableStringify(worldInput));
  const key = hashSkillTestValue([skillId || 'skill', planHash, worldHash].join('|'));

  return createEnvironmentCacheResult({
    enabled: true,
    eligible: true,
    key,
    planHash,
    worldHash,
    status: 'miss',
    reason: 'cache entry not checked yet',
    paths: cachePaths,
  });
}

function resolveEnvironmentCacheArchiveTarget(archivePath: string, cachePaths: any[], runtime: SkillTestEnvironmentRuntime | null = null) {
  const normalized = String(archivePath || '').trim().replace(/\\+/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null;
  }

  const normalizedPaths = cachePaths
    .map((entry: any) => ({
      root: String(entry && entry.root || '').trim(),
      path: String(entry && entry.path || '').trim(),
      hostRoot: resolveEnvironmentCacheRootDir(String(entry && entry.root || '').trim(), runtime),
    }))
    .filter((entry: any) => entry.root && entry.path && entry.hostRoot)
    .sort((left: any, right: any) => `${right.root}/${right.path}`.length - `${left.root}/${left.path}`.length);

  for (const entry of normalizedPaths) {
    const prefix = `${entry.root}/${entry.path}`;
    if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) {
      continue;
    }
    const relativePath = normalized.slice(entry.root.length + 1);
    return {
      root: entry.root,
      rootDir: entry.hostRoot,
      relativePath,
      hostPath: path.join(entry.hostRoot, ...relativePath.split('/')),
    };
  }

  return null;
}

async function runEnvironmentCacheSandboxCommand(command: string, cwd: string, runtime: SkillTestEnvironmentRuntime | null = null, timeoutSec = 60) {
  const adapter = runtime && runtime.sandboxToolAdapter ? runtime.sandboxToolAdapter : null;
  if (!adapter || typeof adapter.runCommand !== 'function') {
    throw new Error('Sandbox tool adapter is unavailable for environment cache commands');
  }
  const result = await Promise.resolve(adapter.runCommand(command, {
    cwd,
    timeout: timeoutSec,
    env: runtime && runtime.commandEnv ? runtime.commandEnv : {},
  }));
  if (!result || result.exitCode !== 0) {
    throw new Error(clipSkillTestText(result && result.stderr ? result.stderr : `environment cache command failed: ${command}`, 320));
  }
}

async function restoreEnvironmentCacheArtifactIntoSandbox(artifactPath: string, cachePaths: any[], runtime: SkillTestEnvironmentRuntime | null = null) {
  const adapter = runtime && runtime.sandboxToolAdapter ? runtime.sandboxToolAdapter : null;
  if (!adapter || typeof adapter.writeFile !== 'function' || typeof adapter.mkdir !== 'function') {
    throw new Error('Sandbox tool adapter is unavailable for cache restore');
  }

  let restoredFiles = 0;
  let restoredDirectories = 0;
  let restoredSymlinks = 0;
  let ignoredEntries = 0;
  const extract = tarStream.extract();
  let settled = false;

  const restorePromise = new Promise<void>((resolve, reject) => {
    const fail = (error: any) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    extract.on('entry', (header: any, stream: any, next: any) => {
      const archivePath = String(header && header.name || '').trim();
      const target = resolveEnvironmentCacheArchiveTarget(archivePath, cachePaths, runtime);
      const type = String(header && header.type || 'file').trim().toLowerCase();
      const finish = (error?: any) => {
        if (error) {
          fail(error);
          return;
        }
        next();
      };

      if (!target) {
        ignoredEntries += 1;
        stream.resume();
        stream.on('end', () => finish());
        return;
      }

      if (type === 'directory') {
        stream.resume();
        stream.on('end', () => {
          Promise.resolve(adapter.mkdir(target.hostPath))
            .then(() => {
              restoredDirectories += 1;
              finish();
            })
            .catch(finish);
        });
        return;
      }

      if (type === 'symlink') {
        stream.resume();
        stream.on('end', () => {
          Promise.resolve(adapter.mkdir(path.dirname(target.hostPath)))
            .then(() => runEnvironmentCacheSandboxCommand(
              `ln -sfn ${escapeShellToken(String(header && header.linkname || ''))} ${escapeShellToken(target.relativePath)}`,
              target.rootDir,
              runtime,
              60,
            ))
            .then(() => {
              restoredSymlinks += 1;
              finish();
            })
            .catch(finish);
        });
        return;
      }

      if (type !== 'file' && type !== 'contiguous-file') {
        ignoredEntries += 1;
        stream.resume();
        stream.on('end', () => finish());
        return;
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: any) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('end', () => {
        const content = Buffer.concat(chunks);
        Promise.resolve(adapter.mkdir(path.dirname(target.hostPath)))
          .then(() => adapter.writeFile(target.hostPath, content))
          .then(async () => {
            const mode = Number(header && header.mode);
            if (Number.isFinite(mode) && (mode & 0o111) !== 0) {
              await runEnvironmentCacheSandboxCommand(
                `chmod ${escapeShellToken((mode & 0o777).toString(8))} ${escapeShellToken(target.relativePath)}`,
                target.rootDir,
                runtime,
                60,
              );
            }
          })
          .then(() => {
            restoredFiles += 1;
            finish();
          })
          .catch(finish);
      });
    });

    extract.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    extract.on('error', fail);
  });

  await Promise.all([
    restorePromise,
    streamPipeline(fs.createReadStream(artifactPath), createGunzip(), extract),
  ]);

  return {
    restoredFiles,
    restoredDirectories,
    restoredSymlinks,
    ignoredEntries,
  };
}

function lookupEnvironmentCacheEntry(cacheMeta: any, config: any, runtime: SkillTestEnvironmentRuntime | null = null) {
  runEnvironmentCacheJanitor(config, runtime);
  const entryPaths = resolveEnvironmentCacheEntryPaths(cacheMeta, runtime);
  const manifestPath = entryPaths.manifestPath;
  const artifactPath = entryPaths.artifactPath;
  const summaryPath = entryPaths.summaryPath;

  if (!fs.existsSync(manifestPath) || !fs.existsSync(artifactPath)) {
    return {
      found: false,
      reason: 'cache artifact not found',
      manifestPath,
      artifactPath,
      summaryPath,
      artifactBytes: null,
      manifest: null,
      summary: null,
    };
  }

  const manifest = readEnvironmentCacheJsonFile(manifestPath);
  const summary = readEnvironmentCacheJsonFile(summaryPath);
  if (!isPlainObject(manifest)) {
    return {
      found: false,
      reason: 'cache manifest is invalid',
      manifestPath,
      artifactPath,
      summaryPath,
      artifactBytes: null,
      manifest: null,
      summary,
    };
  }

  if (manifest.cacheKey && String(manifest.cacheKey).trim() !== String(cacheMeta && cacheMeta.key || '').trim()) {
    return {
      found: false,
      reason: 'cache key does not match manifest',
      manifestPath,
      artifactPath,
      summaryPath,
      artifactBytes: null,
      manifest,
      summary,
    };
  }

  const artifactStat = fs.statSync(artifactPath);
  const maxArtifactBytes = normalizePositiveInteger(config && config.cache && config.cache.maxArtifactBytes);
  if (maxArtifactBytes && artifactStat.size > maxArtifactBytes) {
    return {
      found: false,
      reason: `cache artifact exceeds maxArtifactBytes (${artifactStat.size} > ${maxArtifactBytes})`,
      manifestPath,
      artifactPath,
      summaryPath,
      artifactBytes: artifactStat.size,
      manifest,
      summary,
    };
  }

  if (isEnvironmentCacheManifestExpired(manifest, config)) {
    try {
      fs.rmSync(entryPaths.entryDir, { recursive: true, force: true });
    } catch {}
    return {
      found: false,
      reason: 'cache artifact expired',
      manifestPath,
      artifactPath,
      summaryPath,
      artifactBytes: artifactStat.size,
      manifest,
      summary,
    };
  }

  return {
    found: true,
    reason: '',
    manifestPath,
    artifactPath,
    summaryPath,
    artifactBytes: artifactStat.size,
    manifest,
    summary,
  };
}

async function saveEnvironmentCache(cacheMeta: any, config: any, runtime: SkillTestEnvironmentRuntime | null = null, options: any = {}) {
  const adapter = runtime && runtime.sandboxToolAdapter ? runtime.sandboxToolAdapter : null;
  if (!adapter || typeof adapter.readFile !== 'function') {
    return createEnvironmentCacheResult({
      ...cacheMeta,
      status: 'save_failed',
      reason: 'Sandbox tool adapter is unavailable for cache save',
    });
  }

  try {
    runEnvironmentCacheJanitor(config, runtime, { keepKey: String(cacheMeta && cacheMeta.key || '').trim() });
    const savePlan = buildEnvironmentCacheSaveCommand(cacheMeta && cacheMeta.paths, runtime);
    options.onPhase?.('cache-save', '正在保存环境缓存…');
    await runEnvironmentCacheSandboxCommand(savePlan.command, runtime && runtime.projectDir ? runtime.projectDir : runtime && runtime.outputDir ? runtime.outputDir : runtime && runtime.privateDir ? runtime.privateDir : '.', runtime, 120);
    const artifactContent = await Promise.resolve(adapter.readFile(savePlan.artifactHostPath));
    const artifactBuffer = Buffer.isBuffer(artifactContent)
      ? artifactContent
      : Buffer.from(artifactContent == null ? '' : artifactContent);
    const artifactBytes = artifactBuffer.length;
    const maxArtifactBytes = normalizePositiveInteger(config && config.cache && config.cache.maxArtifactBytes);
    if (maxArtifactBytes && artifactBytes > maxArtifactBytes) {
      return createEnvironmentCacheResult({
        ...cacheMeta,
        status: 'save_failed',
        reason: `cache artifact exceeds maxArtifactBytes (${artifactBytes} > ${maxArtifactBytes})`,
        artifactBytes,
      });
    }

    const artifactSha256 = createHash('sha256').update(artifactBuffer).digest('hex');
    const entryPaths = resolveEnvironmentCacheEntryPaths(cacheMeta, runtime);
    const existingManifest = readEnvironmentCacheJsonFile(entryPaths.manifestPath);
    const savedAt = nowIso();
    const manifest = buildEnvironmentCacheManifest(cacheMeta, config, runtime, {
      createdAt: existingManifest && existingManifest.createdAt ? String(existingManifest.createdAt) : savedAt,
      savedAt,
      artifactBytes,
      artifactSha256,
    });
    const summary = buildEnvironmentCacheSummary(cacheMeta, manifest, entryPaths, {
      skillId: String(runtime && runtime.skillId || '').trim(),
      savedAt,
      status: 'saved',
      reason: clipSkillTestText(`saved ${artifactBytes} bytes to cache`, 180),
    });

    fs.mkdirSync(entryPaths.cacheRootDir, { recursive: true });
    fs.rmSync(entryPaths.entryDir, { recursive: true, force: true });
    fs.mkdirSync(entryPaths.entryDir, { recursive: true });
    fs.writeFileSync(entryPaths.artifactPath, artifactBuffer);
    fs.writeFileSync(entryPaths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(entryPaths.summaryPath, JSON.stringify(summary, null, 2), 'utf8');

    return createEnvironmentCacheResult({
      ...cacheMeta,
      status: 'saved',
      reason: String(summary.reason || '').trim(),
      manifestPath: normalizePathForJson(entryPaths.manifestPath),
      summaryPath: normalizePathForJson(entryPaths.summaryPath),
      artifactBytes,
      artifactSha256,
      createdAt: String(manifest.createdAt || '').trim(),
      savedAt: String(manifest.savedAt || '').trim(),
      expiresAt: String(manifest.expiresAt || '').trim(),
      lastValidatedAt: String(manifest.lastValidatedAt || '').trim(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error || 'cache save failed');
    return createEnvironmentCacheResult({
      ...cacheMeta,
      status: 'save_failed',
      reason: clipSkillTestText(errorMessage, 320),
    });
  }
}

function touchEnvironmentCacheEntry(cacheMeta: any, config: any, runtime: SkillTestEnvironmentRuntime | null = null) {
  try {
    const entryPaths = resolveEnvironmentCacheEntryPaths(cacheMeta, runtime);
    const manifest = readEnvironmentCacheJsonFile(entryPaths.manifestPath);
    if (!manifest || !fs.existsSync(entryPaths.artifactPath)) {
      return cacheMeta;
    }

    const artifactBytes = fs.statSync(entryPaths.artifactPath).size;
    const lastValidatedAt = nowIso();
    manifest.lastValidatedAt = lastValidatedAt;
    manifest.expiresAt = computeEnvironmentCacheExpiresAt(lastValidatedAt, config && config.cache && config.cache.ttlHours);
    if (!manifest.savedAt) {
      manifest.savedAt = String(cacheMeta && cacheMeta.savedAt || '').trim() || lastValidatedAt;
    }
    if (!manifest.createdAt) {
      manifest.createdAt = manifest.savedAt;
    }

    const summary = buildEnvironmentCacheSummary(cacheMeta, manifest, entryPaths, {
      skillId: String(runtime && runtime.skillId || '').trim(),
      lastValidatedAt,
      status: String(cacheMeta && cacheMeta.status || '').trim() || 'restored',
      reason: String(cacheMeta && cacheMeta.reason || '').trim(),
    });

    fs.writeFileSync(entryPaths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(entryPaths.summaryPath, JSON.stringify(summary, null, 2), 'utf8');

    return createEnvironmentCacheResult({
      ...cacheMeta,
      manifestPath: normalizePathForJson(entryPaths.manifestPath),
      summaryPath: normalizePathForJson(entryPaths.summaryPath),
      artifactBytes,
      artifactSha256: String(manifest.artifactSha256 || '').trim(),
      createdAt: String(manifest.createdAt || '').trim(),
      savedAt: String(manifest.savedAt || '').trim(),
      expiresAt: String(manifest.expiresAt || '').trim(),
      lastValidatedAt: String(manifest.lastValidatedAt || '').trim(),
    });
  } catch {
    return cacheMeta;
  }
}

async function restoreEnvironmentCache(cacheMeta: any, config: any, runtime: SkillTestEnvironmentRuntime | null = null, options: any = {}) {
  const cacheLookup = lookupEnvironmentCacheEntry(cacheMeta, config, runtime);
  const sharedFields = {
    manifestPath: cacheLookup.manifestPath ? normalizePathForJson(cacheLookup.manifestPath) : '',
    summaryPath: cacheLookup.summaryPath ? normalizePathForJson(cacheLookup.summaryPath) : '',
    artifactBytes: cacheLookup.artifactBytes,
    artifactSha256: cacheLookup.manifest && cacheLookup.manifest.artifactSha256 ? String(cacheLookup.manifest.artifactSha256) : '',
    createdAt: cacheLookup.manifest && cacheLookup.manifest.createdAt ? String(cacheLookup.manifest.createdAt) : '',
    savedAt: cacheLookup.manifest && cacheLookup.manifest.savedAt ? String(cacheLookup.manifest.savedAt) : '',
    expiresAt: cacheLookup.manifest && cacheLookup.manifest.expiresAt ? String(cacheLookup.manifest.expiresAt) : '',
    lastValidatedAt: cacheLookup.manifest && cacheLookup.manifest.lastValidatedAt ? String(cacheLookup.manifest.lastValidatedAt) : '',
  };

  if (!cacheLookup.found) {
    return createEnvironmentCacheResult({
      ...cacheMeta,
      ...sharedFields,
      status: 'miss',
      reason: cacheLookup.reason,
    });
  }

  options.onPhase?.('cache-restore', '正在恢复环境缓存…');
  try {
    const restored = await restoreEnvironmentCacheArtifactIntoSandbox(cacheLookup.artifactPath, cacheMeta.paths, runtime);
    return createEnvironmentCacheResult({
      ...cacheMeta,
      ...sharedFields,
      status: restored.restoredFiles > 0 || restored.restoredDirectories > 0 || restored.restoredSymlinks > 0 ? 'restored' : 'restore_failed',
      reason: restored.restoredFiles > 0 || restored.restoredDirectories > 0 || restored.restoredSymlinks > 0
        ? clipSkillTestText(`restored ${restored.restoredFiles} file(s), ${restored.restoredDirectories} directorie(s), ${restored.restoredSymlinks} symlink(s)`, 180)
        : 'cache artifact did not contain declared paths',
      restoredFiles: restored.restoredFiles,
      restoredDirectories: restored.restoredDirectories,
      restoredSymlinks: restored.restoredSymlinks,
      ignoredEntries: restored.ignoredEntries,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error || 'cache restore failed');
    return createEnvironmentCacheResult({
      ...cacheMeta,
      ...sharedFields,
      status: 'restore_failed',
      reason: clipSkillTestText(errorMessage, 320),
    });
  }
}

function normalizeCapabilityName(value: any) {
  return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function buildRuntimeCapabilitySnapshot(runtime: SkillTestEnvironmentRuntime | null = null) {
  const isolation = runtime && runtime.isolation ? runtime.isolation : null;
  const execution = runtime && runtime.execution ? runtime.execution : null;
  const supported = new Set(['bash', 'filesystem', 'read', 'write', 'edit']);
  if (execution && execution.toolRuntime === 'sandbox') {
    supported.add('sandbox');
  }
  if (execution && execution.pathSemantics === 'sandbox') {
    supported.add('sandbox-paths');
  }
  if (!isolation || isolation.mode !== 'isolated' || isolation.egressMode === 'record' || isolation.egressMode === 'allow') {
    supported.add('network');
  }
  return { supported };
}

function createSkippedEnvironmentResult(reason = '') {
  return {
    status: 'skipped',
    phase: 'skipped',
    requirements: {
      satisfied: [],
      missing: [],
      unsupported: [],
    },
    bootstrap: {
      attempted: false,
      commands: [],
      results: [],
    },
    verify: {
      attempted: false,
      commands: [],
      results: [],
    },
    cache: null,
    advice: null,
    reason: reason || '',
  };
}

function createEnvironmentFailureMessage(environment: any) {
  if (!environment || typeof environment !== 'object') {
    return 'Environment preparation failed';
  }
  const status = String(environment.status || 'env_failed').trim() || 'env_failed';
  const phase = String(environment.phase || '').trim();
  const reason = String(environment.reason || '').trim();
  const prefix = phase ? `${status} at ${phase}` : status;
  return reason ? `${prefix}: ${reason}` : prefix;
}

function sanitizeEnvironmentManifestSegment(value: any, fallback = 'env') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function normalizeEnvironmentBuildInstallSteps(config: any) {
  const commands = Array.isArray(config && config.bootstrap && config.bootstrap.commands)
    ? config.bootstrap.commands.map((entry: any) => String(entry || '').trim()).filter(Boolean)
    : [];
  return commands.map((command: string) => ({ type: 'command', command }));
}

function normalizeEnvironmentBuildVerifyCommands(config: any) {
  return Array.isArray(config && config.verify && config.verify.commands)
    ? config.verify.commands.map((entry: any) => String(entry || '').trim()).filter(Boolean)
    : [];
}

function normalizeEnvironmentBuildRequirements(config: any) {
  return Array.isArray(config && config.requirements)
    ? config.requirements.map((entry: any) => ({
        id: String(entry && entry.id || '').trim(),
        kind: String(entry && entry.kind || 'command').trim() || 'command',
        name: String(entry && entry.name || '').trim(),
        versionHint: String(entry && entry.versionHint || '').trim(),
        required: entry && entry.required !== false,
        installable: entry && entry.installable === true,
        probeCommand: String(entry && entry.probeCommand || '').trim(),
      })).filter((entry: any) => entry.name)
    : [];
}

function resolveEnvironmentBuildProfile(config: any, input: any = {}) {
  const asset = config && isPlainObject(config.asset) ? config.asset : null;
  return String(
    input.envProfile || input.env_profile || input.profile ||
    asset && (asset.envProfile || asset.env_profile || asset.profile) ||
    'default'
  ).trim() || 'default';
}

function resolveEnvironmentBuildImageTag(skillId: string, envProfile: string, manifestHash: string, explicitImage = '') {
  const image = String(explicitImage || '').trim();
  if (image) {
    return image;
  }
  const safeSkillId = sanitizeEnvironmentManifestSegment(skillId, 'skill');
  const safeProfile = sanitizeEnvironmentManifestSegment(envProfile, 'default');
  return `caff-skill-env-${safeSkillId}:${safeProfile}-${String(manifestHash || '').slice(0, 12)}`;
}

function buildEnvironmentBuildManifest(config: any, environmentResult: any, context: any = {}) {
  const buildInput = isPlainObject(context.buildInput) ? context.buildInput : {};
  const skillId = String(context.skillId || '').trim() || 'skill';
  const envProfile = resolveEnvironmentBuildProfile(config, buildInput);
  const generatedAt = String(context.generatedAt || '').trim() || nowIso();
  const testingDocument = context.testingDocument && typeof context.testingDocument === 'object'
    ? context.testingDocument
    : null;
  const testingMdHash = String(
    buildInput.testingMdHash || buildInput.testing_md_hash ||
    context.testingMdHash ||
    testingDocument && testingDocument.contentHash ||
    ''
  ).trim();
  const baseImage = String(
    buildInput.baseImage || buildInput.base_image || buildInput.baseImageRef || buildInput.base_image_ref ||
    context.baseImage ||
    'caff-skill-test-caff:local'
  ).trim() || 'caff-skill-test-caff:local';
  const baseImageDigest = String(buildInput.baseImageDigest || buildInput.base_image_digest || context.baseImageDigest || '').trim();
  const buildCaseId = String(buildInput.buildCaseId || buildInput.build_case_id || context.buildCaseId || context.caseId || '').trim();
  const installSteps = normalizeEnvironmentBuildInstallSteps(config);
  const verifyCommands = normalizeEnvironmentBuildVerifyCommands(config);
  const requirements = normalizeEnvironmentBuildRequirements(config);
  const coreManifest: any = {
    kind: 'skill_test_environment_manifest',
    version: 1,
    skillId,
    envProfile,
    baseImage,
    baseImageDigest,
    testingMdHash,
    buildCaseId,
    runId: String(context.runId || '').trim(),
    generatedAt,
    installSteps,
    verifyCommands,
    requirements,
    source: {
      testingDocPath: normalizePathForJson(context.testingDocPath || testingDocument && testingDocument.path || ''),
      testingDocHash: testingMdHash,
      testingDocUsed: Boolean(context.testingDocUsed),
      environmentConfigSource: String(context.environmentConfigSource || '').trim(),
    },
    verifyEvidence: {
      status: String(environmentResult && environmentResult.status || '').trim(),
      phase: String(environmentResult && environmentResult.phase || '').trim(),
      requirements: environmentResult && environmentResult.requirements ? environmentResult.requirements : null,
      bootstrap: environmentResult && environmentResult.bootstrap ? environmentResult.bootstrap : null,
      verify: environmentResult && environmentResult.verify ? environmentResult.verify : null,
    },
  };
  const manifestHash = hashSkillTestValue(stableStringify(coreManifest));
  const image = resolveEnvironmentBuildImageTag(skillId, envProfile, manifestHash, buildInput.image || buildInput.imageRef || buildInput.image_ref);
  return {
    ...coreManifest,
    manifestHash,
    image,
  };
}

function persistEnvironmentBuildManifest(manifest: any, rootDir = DEFAULT_ENVIRONMENT_MANIFEST_ROOT_DIR) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('environment manifest must be an object');
  }
  const skillId = sanitizeEnvironmentManifestSegment(manifest.skillId, 'skill');
  const envProfile = sanitizeEnvironmentManifestSegment(manifest.envProfile, 'default');
  const manifestHash = sanitizeEnvironmentManifestSegment(manifest.manifestHash, hashSkillTestValue(stableStringify(manifest)).slice(0, 16));
  const manifestDir = path.join(String(rootDir || DEFAULT_ENVIRONMENT_MANIFEST_ROOT_DIR).trim() || DEFAULT_ENVIRONMENT_MANIFEST_ROOT_DIR, skillId, envProfile, manifestHash);
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, 'environment-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    manifestPath: normalizePathForJson(manifestPath),
    manifestDir: normalizePathForJson(manifestDir),
  };
}

async function runEnvironmentCommand(command: string, runtime: SkillTestEnvironmentRuntime | null = null, input: any = {}) {
  const adapter = runtime && runtime.sandboxToolAdapter ? runtime.sandboxToolAdapter : null;
  if (!adapter || typeof adapter.runCommand !== 'function') {
    throw new Error('Environment commands require the sandbox tool adapter inside the case world');
  }

  const timeoutSec = normalizePositiveInteger(input.timeoutSec || input.timeout) || null;
  const result = await Promise.resolve(adapter.runCommand(command, {
    cwd: runtime && runtime.projectDir ? runtime.projectDir : undefined,
    timeout: timeoutSec || undefined,
    env: runtime && runtime.commandEnv ? runtime.commandEnv : {},
  }));

  return {
    command,
    exitCode: Number.isInteger(result && result.exitCode) ? result.exitCode : null,
    stdout: clipSkillTestText(result && result.stdout ? result.stdout : '', 500),
    stderr: clipSkillTestText(result && result.stderr ? result.stderr : '', 500),
  };
}

async function probeEnvironmentRequirements(config: any, runtime: SkillTestEnvironmentRuntime | null = null, hooks: any = {}) {
  const requirements = Array.isArray(config && config.requirements) ? config.requirements : [];
  const capabilitySnapshot = buildRuntimeCapabilitySnapshot(runtime);
  const envValues = runtime && runtime.availableEnv && typeof runtime.availableEnv === 'object' ? runtime.availableEnv : {};
  const sandboxCommandEnv = runtime && runtime.commandEnv && typeof runtime.commandEnv === 'object' ? runtime.commandEnv : {};
  const satisfied: any[] = [];
  const missing: any[] = [];
  const unsupported: any[] = [];

  if (!runtime || runtime.toolRuntime !== 'sandbox' || !runtime.sandboxToolAdapter) {
    throw new Error('Environment probes require the sandbox tool adapter inside the case world');
  }

  for (const requirement of requirements) {
    if (!requirement) {
      continue;
    }
    const entry = {
      id: String(requirement.id || '').trim(),
      kind: String(requirement.kind || 'command').trim(),
      name: String(requirement.name || '').trim(),
      versionHint: String(requirement.versionHint || '').trim(),
      required: requirement.required !== false,
      installable: requirement.installable === true,
      probeCommand: String(requirement.probeCommand || '').trim(),
    };

    if (entry.kind === 'capability') {
      const capability = normalizeCapabilityName(entry.name);
      if (capabilitySnapshot.supported.has(capability)) {
        satisfied.push({ ...entry, reason: 'runtime capability available' });
      } else if (UNSUPPORTED_ENVIRONMENT_CAPABILITIES.has(capability)) {
        unsupported.push({ ...entry, reason: 'runtime does not provide this capability' });
      } else {
        missing.push({ ...entry, reason: 'runtime capability not declared as available' });
      }
      continue;
    }

    if (entry.kind === 'env') {
      if (String(envValues[entry.name] || '').trim()) {
        satisfied.push({
          ...entry,
          reason: sandboxCommandEnv[entry.name] !== undefined
            ? 'environment variable is set for sandbox commands'
            : 'environment variable is available in the runtime baseline',
        });
      } else {
        missing.push({ ...entry, reason: 'environment variable is missing' });
      }
      continue;
    }

    if (entry.kind === 'service' && !entry.probeCommand) {
      unsupported.push({ ...entry, reason: 'service lifecycle management is not supported in the current runtime' });
      continue;
    }

    if (entry.kind === 'package' && !entry.probeCommand) {
      missing.push({ ...entry, reason: 'package availability cannot be probed without probeCommand' });
      continue;
    }

    const probeCommand = entry.probeCommand || `command -v ${escapeShellToken(entry.name)}`;
    const probeResult = await runEnvironmentCommand(probeCommand, runtime, { timeoutSec: 30 });
    hooks.onCommandResult?.('preflight', probeResult);
    if (probeResult.exitCode === 0) {
      satisfied.push({ ...entry, reason: 'probe command succeeded', stdout: probeResult.stdout });
    } else {
      missing.push({ ...entry, reason: 'probe command failed', stdout: probeResult.stdout, stderr: probeResult.stderr });
    }
  }

  return { satisfied, missing, unsupported };
}

async function executeEnvironmentCommands(commands: string[], phase: 'bootstrap' | 'verify', runtime: SkillTestEnvironmentRuntime | null = null, options: any = {}) {
  const results: any[] = [];
  const timeoutSec = normalizePositiveInteger(options.timeoutSec)
    || (phase === 'bootstrap' ? DEFAULT_ENVIRONMENT_BOOTSTRAP_TIMEOUT_SEC : DEFAULT_ENVIRONMENT_VERIFY_TIMEOUT_SEC);

  for (const command of commands) {
    const result = await runEnvironmentCommand(command, runtime, { timeoutSec });
    results.push(result);
    options.onCommandResult?.(phase, result);
    if (result.exitCode !== 0) {
      break;
    }
  }

  return results;
}

async function executeEnvironmentWorkflow(config: any, runtime: SkillTestEnvironmentRuntime | null = null, options: any = {}) {
  if (!config || config.enabled !== true) {
    return createSkippedEnvironmentResult('environment chain disabled');
  }

  const cacheResult = buildEnvironmentCacheMetadata(config, runtime, options.source);

  if (!runtime || runtime.toolRuntime !== 'sandbox' || !runtime.sandboxToolAdapter) {
    const result = createSkippedEnvironmentResult('environment chain requires sandbox tool runtime');
    return {
      ...result,
      status: 'runtime_unsupported',
      phase: 'preflight',
      cache: cacheResult,
      reason: 'environment chain requires sandbox file/command tools to run inside the case world',
    };
  }

  options.onPhase?.('preflight', '正在环境预检…');
  const initialRequirements = await probeEnvironmentRequirements(config, runtime, options);
  const unsupportedRequired = initialRequirements.unsupported.filter((entry: any) => entry.required !== false);
  if (unsupportedRequired.length > 0) {
    const result: any = {
      status: 'runtime_unsupported',
      phase: 'preflight',
      requirements: initialRequirements,
      bootstrap: { attempted: false, commands: [], results: [] },
      verify: { attempted: false, commands: [], results: [] },
      cache: cacheResult,
      advice: null,
      reason: clipSkillTestText(unsupportedRequired.map((entry: any) => `${entry.name}: ${entry.reason || 'unsupported'}`).join('; '), 320),
    };
    result.advice = options.persistAdvice ? buildEnvironmentAdvice(config, result) : null;
    return result;
  }

  let effectiveRequirements = initialRequirements;
  let effectiveCacheResult = cacheResult;
  let missingRequired = effectiveRequirements.missing.filter((entry: any) => entry.required !== false);
  if (missingRequired.length > 0 && effectiveCacheResult.enabled && effectiveCacheResult.eligible) {
    effectiveCacheResult = await restoreEnvironmentCache(effectiveCacheResult, config, runtime, options);
    if (effectiveCacheResult.status === 'restored') {
      effectiveRequirements = await probeEnvironmentRequirements(config, runtime, options);
      missingRequired = effectiveRequirements.missing.filter((entry: any) => entry.required !== false);
    }
  }

  const bootstrapCommands = Array.isArray(config.bootstrap && config.bootstrap.commands) ? config.bootstrap.commands : [];
  if (missingRequired.length > 0 && (!options.allowBootstrap || bootstrapCommands.length === 0)) {
    const result: any = {
      status: 'env_missing',
      phase: 'preflight',
      requirements: effectiveRequirements,
      bootstrap: { attempted: false, commands: bootstrapCommands, results: [] },
      verify: { attempted: false, commands: Array.isArray(config.verify && config.verify.commands) ? config.verify.commands : [], results: [] },
      cache: effectiveCacheResult,
      advice: null,
      reason: clipSkillTestText(missingRequired.map((entry: any) => `${entry.name}: ${entry.reason || 'missing'}`).join('; '), 320),
    };
    result.advice = options.persistAdvice ? buildEnvironmentAdvice(config, result) : null;
    return result;
  }

  let bootstrapResults: any[] = [];
  if (bootstrapCommands.length > 0 && (missingRequired.length > 0 || effectiveRequirements.satisfied.length === 0)) {
    options.onPhase?.('bootstrap', '正在安装环境…');
    bootstrapResults = await executeEnvironmentCommands(bootstrapCommands, 'bootstrap', runtime, {
      timeoutSec: config.bootstrap && config.bootstrap.timeoutSec,
      onCommandResult: options.onCommandResult,
    });
    if (bootstrapResults.some((entry: any) => entry.exitCode !== 0)) {
      const result: any = {
        status: 'env_install_failed',
        phase: 'bootstrap',
        requirements: effectiveRequirements,
        bootstrap: { attempted: true, commands: bootstrapCommands, results: bootstrapResults },
        verify: { attempted: false, commands: Array.isArray(config.verify && config.verify.commands) ? config.verify.commands : [], results: [] },
        cache: effectiveCacheResult,
        advice: null,
        reason: clipSkillTestText(bootstrapResults.find((entry: any) => entry.exitCode !== 0)?.stderr || 'bootstrap command failed', 320),
      };
      result.advice = options.persistAdvice ? buildEnvironmentAdvice(config, result) : null;
      return result;
    }
  }

  const postBootstrapRequirements = bootstrapResults.length > 0
    ? await probeEnvironmentRequirements(config, runtime, options)
    : effectiveRequirements;
  const stillMissingRequired = postBootstrapRequirements.missing.filter((entry: any) => entry.required !== false);

  options.onPhase?.('verify', '正在验证环境…');
  const verifyCommands = Array.isArray(config.verify && config.verify.commands) ? config.verify.commands : [];
  const verifyResults = await executeEnvironmentCommands(verifyCommands, 'verify', runtime, {
    timeoutSec: config.verify && config.verify.timeoutSec,
    onCommandResult: options.onCommandResult,
  });
  const verifyFailed = verifyResults.some((entry: any) => entry.exitCode !== 0);

  if (stillMissingRequired.length > 0 || verifyFailed) {
    const result: any = {
      status: 'env_verify_failed',
      phase: 'verify',
      requirements: postBootstrapRequirements,
      bootstrap: { attempted: bootstrapResults.length > 0, commands: bootstrapCommands, results: bootstrapResults },
      verify: { attempted: verifyCommands.length > 0, commands: verifyCommands, results: verifyResults },
      cache: effectiveCacheResult,
      advice: null,
      reason: clipSkillTestText(
        stillMissingRequired.length > 0
          ? stillMissingRequired.map((entry: any) => `${entry.name}: ${entry.reason || 'missing after bootstrap'}`).join('; ')
          : (verifyResults.find((entry: any) => entry.exitCode !== 0)?.stderr || 'verification command failed'),
        320,
      ),
    };
    result.advice = options.persistAdvice ? buildEnvironmentAdvice(config, result) : null;
    return result;
  }

  if (effectiveCacheResult.enabled && effectiveCacheResult.eligible) {
    if (bootstrapResults.length > 0) {
      effectiveCacheResult = await saveEnvironmentCache(effectiveCacheResult, config, runtime, options);
    } else if (effectiveCacheResult.status === 'restored') {
      effectiveCacheResult = touchEnvironmentCacheEntry(effectiveCacheResult, config, runtime);
    }
  }

  const result: any = {
    status: 'passed',
    phase: 'completed',
    requirements: postBootstrapRequirements,
    bootstrap: { attempted: bootstrapResults.length > 0, commands: bootstrapCommands, results: bootstrapResults },
    verify: { attempted: verifyCommands.length > 0, commands: verifyCommands, results: verifyResults },
    cache: effectiveCacheResult,
    advice: null,
    reason: '',
  };
  result.advice = options.persistAdvice ? buildEnvironmentAdvice(config, result) : null;
  return result;
}


export {
  DEFAULT_ENVIRONMENT_CACHE_ROOT_DIR,
  DEFAULT_ENVIRONMENT_MANIFEST_ROOT_DIR,
  buildEnvironmentBuildManifest,
  createEnvironmentFailureMessage,
  createSkippedEnvironmentResult,
  executeEnvironmentWorkflow,
  normalizeEnvironmentConfigInput,
  persistEnvironmentBuildManifest,
  resolveEnvironmentRunConfig,
};
