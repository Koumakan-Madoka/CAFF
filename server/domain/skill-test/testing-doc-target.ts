import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import { createHttpError } from '../../http/http-errors';
import { loadSkillTestingDocumentEnvironmentConfig } from './environment-chain';

export const SKILL_TESTING_DOC_TARGET_PATH = 'TESTING.md';

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePathForJson(value: any) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function buildValidationIssue(code: string, severity: 'error' | 'warning' | 'needs-review', pathValue: string, message: string) {
  return { code, severity, path: pathValue, message };
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

export function hashTestingDocContent(content: any) {
  return createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function isPathInsideOrSameDirectory(candidatePath: string, directoryPath: string) {
  const relativePath = path.relative(directoryPath, candidatePath);
  return relativePath === '' || (Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function normalizeTestingDocTargetError(error: any, fallbackMessage: string) {
  if (error && Number.isInteger(error.statusCode)) {
    return error;
  }
  return createValidationHttpError(
    buildValidationIssue('testing_doc_target_invalid', 'error', 'targetPath', String(error && error.message || fallbackMessage))
  );
}

export function resolveSkillTestingDocTarget(skillRegistry: any, skillId: any, options: any = {}) {
  const normalizedSkillId = String(skillId || '').trim();
  if (!normalizedSkillId) {
    throw createValidationHttpError(
      buildValidationIssue('testing_doc_skill_required', 'error', 'skillId', 'TESTING.md 草稿缺少目标 skill')
    );
  }

  let target: any = null;
  if (skillRegistry && typeof skillRegistry.resolveSkillFile === 'function') {
    try {
      target = skillRegistry.resolveSkillFile(normalizedSkillId, SKILL_TESTING_DOC_TARGET_PATH);
    } catch (error: any) {
      throw normalizeTestingDocTargetError(error, '无法解析目标 skill 的 TESTING.md 路径');
    }
  }

  const skill = skillRegistry && typeof skillRegistry.getSkill === 'function'
    ? skillRegistry.getSkill(normalizedSkillId)
    : null;
  if (!target) {
    if (!skill || !skill.path) {
      throw createHttpError(404, '目标 skill 不存在');
    }
    const skillDir = path.resolve(String(skill.path || '').trim());
    target = {
      skillId: String(skill.id || normalizedSkillId).trim() || normalizedSkillId,
      skillDir,
      relativePath: SKILL_TESTING_DOC_TARGET_PATH,
      fullPath: path.resolve(skillDir, SKILL_TESTING_DOC_TARGET_PATH),
      readOnly: Boolean(skill.readOnly),
      source: skill.source || '',
    };
  }

  const skillDir = path.resolve(String(target.skillDir || skill && skill.path || '').trim());
  const fullPath = path.resolve(String(target.fullPath || path.join(skillDir, SKILL_TESTING_DOC_TARGET_PATH)));
  const relativePath = normalizePathForJson(String(target.relativePath || SKILL_TESTING_DOC_TARGET_PATH));
  if (relativePath !== SKILL_TESTING_DOC_TARGET_PATH || path.basename(fullPath) !== SKILL_TESTING_DOC_TARGET_PATH) {
    throw createValidationHttpError(
      buildValidationIssue('testing_doc_target_invalid', 'error', 'targetPath', 'TESTING.md 写入目标必须固定为 skill 根目录下的 TESTING.md')
    );
  }
  if (!isPathInsideOrSameDirectory(fullPath, skillDir) || path.dirname(fullPath) !== skillDir) {
    throw createValidationHttpError(
      buildValidationIssue('testing_doc_target_invalid', 'error', 'targetPath', 'TESTING.md 路径越过了目标 skill 根目录')
    );
  }

  const projectDir = options && options.projectDir ? path.resolve(String(options.projectDir)) : '';
  const readOnly = Boolean(target.readOnly) && !(projectDir && isPathInsideOrSameDirectory(skillDir, projectDir));

  return {
    skill: skill || (skillRegistry && typeof skillRegistry.getSkill === 'function' ? skillRegistry.getSkill(target.skillId) : null),
    skillId: String(target.skillId || normalizedSkillId).trim() || normalizedSkillId,
    skillDir,
    relativePath: SKILL_TESTING_DOC_TARGET_PATH,
    fullPath,
    readOnly,
    source: target.source || '',
  };
}

export function readTestingDocFileInfo(target: any) {
  const fullPath = String(target && target.fullPath || '').trim();
  if (!fullPath || !fs.existsSync(fullPath)) {
    return {
      exists: false,
      hash: '',
      size: 0,
      modifiedAt: '',
      content: '',
    };
  }

  const lstat = fs.lstatSync(fullPath);
  if (lstat.isSymbolicLink()) {
    throw createValidationHttpError(
      buildValidationIssue('testing_doc_target_invalid', 'error', 'targetPath', 'TESTING.md 不能是符号链接')
    );
  }
  if (!lstat.isFile()) {
    throw createValidationHttpError(
      buildValidationIssue('testing_doc_target_invalid', 'error', 'targetPath', 'TESTING.md 目标必须是文件')
    );
  }

  const skillDirRealPath = fs.realpathSync(String(target.skillDir || path.dirname(fullPath)));
  const fileRealPath = fs.realpathSync(fullPath);
  if (!isPathInsideOrSameDirectory(fileRealPath, skillDirRealPath)) {
    throw createValidationHttpError(
      buildValidationIssue('testing_doc_target_invalid', 'error', 'targetPath', 'TESTING.md 真实路径越过了目标 skill 根目录')
    );
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  return {
    exists: true,
    hash: hashTestingDocContent(content),
    size: Buffer.byteLength(content, 'utf8'),
    modifiedAt: lstat.mtime.toISOString(),
    content,
  };
}

export function assertCanWriteTestingDocTarget(target: any) {
  if (target && target.readOnly) {
    throw createValidationHttpError(
      buildValidationIssue('testing_doc_target_read_only', 'error', 'targetPath', '目标 skill 是只读来源，不能通过聊天工作台写入 TESTING.md')
    );
  }
  const skillDir = String(target && target.skillDir || '').trim();
  if (!skillDir || !fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    throw createValidationHttpError(
      buildValidationIssue('testing_doc_target_invalid', 'error', 'targetPath', '目标 skill 根目录不存在')
    );
  }
  fs.realpathSync(skillDir);
}

export function buildTestingDocContractSummary(skill: any) {
  const doc = loadSkillTestingDocumentEnvironmentConfig(skill);
  const testingDocPath = String(doc && doc.path || (skill && skill.path ? path.join(String(skill.path), SKILL_TESTING_DOC_TARGET_PATH) : '')).trim();
  const exists = Boolean(testingDocPath && fs.existsSync(testingDocPath));
  const content = String(doc && doc.content || '').trim();
  const config = doc && doc.config && isPlainObject(doc.config) ? doc.config as any : {};
  const hasExecutableRequirements = Array.isArray(config.requirements) && config.requirements.length > 0;
  const hasBootstrapCommands = Array.isArray(config.bootstrap && config.bootstrap.commands) && config.bootstrap.commands.length > 0;
  const hasVerificationCommands = Array.isArray(config.verify && config.verify.commands) && config.verify.commands.length > 0;
  const hasPrerequisites = hasExecutableRequirements;
  const hasSetup = hasBootstrapCommands;
  const hasVerification = hasVerificationCommands;
  const hasTeardown = false;
  const candidates = [] as any[];

  if (hasPrerequisites) {
    candidates.push({ environmentContractRef: 'TESTING.md#Prerequisites', section: 'Prerequisites' });
  }
  if (hasBootstrapCommands) {
    candidates.push({ environmentContractRef: 'TESTING.md#Bootstrap', section: 'Bootstrap' });
  }
  if (hasVerificationCommands) {
    candidates.push({ environmentContractRef: 'TESTING.md#Verification', section: 'Verification' });
  }

  const warnings = [] as string[];
  if (exists && doc && !doc.contractBlockFound) {
    warnings.push('缺少 skill-test-environment 合同块；运行时只会把 TESTING.md 全文作为参考上下文，不会自动提取可执行环境步骤');
  }
  if (exists && doc && doc.contractBlockFound && !doc.contractBlockParsed) {
    warnings.push('skill-test-environment 合同块格式无效');
  }
  if (exists && doc && doc.contractBlockParsed && !hasPrerequisites) {
    warnings.push('Machine Contract 缺少 prerequisites / requirements 可执行内容');
  }
  if (exists && doc && doc.contractBlockParsed && !hasSetup) {
    warnings.push('Machine Contract 缺少 bootstrap / setup 可执行内容');
  }
  if (exists && doc && doc.contractBlockParsed && !hasVerification) {
    warnings.push('Machine Contract 缺少 verification 可执行内容');
  }

  return {
    targetPath: SKILL_TESTING_DOC_TARGET_PATH,
    testingDocPath: normalizePathForJson(testingDocPath),
    exists,
    status: !exists ? 'missing' : (doc && doc.used && hasPrerequisites && hasSetup ? 'available' : 'insufficient'),
    source: !exists ? 'missing' : (doc && doc.used ? 'testing_doc_contract' : 'testing_doc_reference_only'),
    contentHash: doc && doc.contentHash ? String(doc.contentHash) : (content ? hashTestingDocContent(content) : ''),
    contractBlockFound: Boolean(doc && doc.contractBlockFound),
    contractBlockParsed: Boolean(doc && doc.contractBlockParsed),
    hasPrerequisites,
    hasSetup,
    hasVerification,
    hasTeardown,
    candidates,
    warnings,
  };
}
