import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';

import { ROOT_DIR } from '../../app/config';
import { isPathWithin } from '../conversation/turn/session-export';
import {
  DEFAULT_ENVIRONMENT_MANIFEST_ROOT_DIR,
  buildEnvironmentBuildManifest,
  persistEnvironmentBuildManifest,
  readSkillTestingDocument,
} from './environment-chain';

const DEFAULT_SKILL_TEST_BRIDGE_TOKEN_TTL_SECONDS = 600;
const DEFAULT_SKILL_TEST_EXECUTION_BRIDGE_TOKEN_TTL_SECONDS = 3600;

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

function hasOwn(value: any, key: string) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
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

function normalizePathForJson(value: any) {
  return String(value || '').trim().replace(/\\/g, '/');
}

export function resolveSkillTestBridgeTokenTtlSeconds(testCase: any, runOptions: any = {}, defaults: any = {}) {
  const explicitRunTtlSec = normalizePositiveInteger(
    runOptions && (runOptions.skillTestBridgeTokenTtlSec || runOptions.bridgeTokenTtlSec || runOptions.tokenTtlSec)
  );
  if (explicitRunTtlSec && explicitRunTtlSec > 0) {
    return explicitRunTtlSec;
  }

  const baseTtlSec = normalizePositiveInteger(defaults && defaults.defaultTtlSec) || DEFAULT_SKILL_TEST_BRIDGE_TOKEN_TTL_SECONDS;
  const executionOverrideTtlSec = normalizePositiveInteger(defaults && defaults.executionTtlSec);
  const loadingMode = String(testCase && testCase.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
  const testType = String(testCase && testCase.testType || '').trim().toLowerCase();

  if (loadingMode === 'full' && testType === 'execution') {
    return executionOverrideTtlSec || Math.max(baseTtlSec, DEFAULT_SKILL_TEST_EXECUTION_BRIDGE_TOKEN_TTL_SECONDS);
  }

  return baseTtlSec;
}

export function getEnvironmentAssetRef(config: any) {
  const asset = config && isPlainObject(config.asset) ? config.asset : null;
  if (!asset || asset.enabled === false) {
    return null;
  }
  return {
    enabled: asset.enabled !== false,
    envProfile: String(asset.envProfile || asset.env_profile || asset.profile || 'default').trim() || 'default',
    image: String(asset.image || asset.imageRef || asset.image_ref || '').trim(),
    imageDigest: String(asset.imageDigest || asset.image_digest || '').trim(),
    baseImage: String(asset.baseImage || asset.base_image || asset.baseImageRef || asset.base_image_ref || '').trim(),
    baseImageDigest: String(asset.baseImageDigest || asset.base_image_digest || '').trim(),
    testingMdHash: String(asset.testingMdHash || asset.testing_md_hash || '').trim(),
    manifestHash: String(asset.manifestHash || asset.manifest_hash || '').trim(),
    manifestPath: String(asset.manifestPath || asset.manifest_path || '').trim(),
    buildCaseId: String(asset.buildCaseId || asset.build_case_id || '').trim(),
    buildRunId: String(asset.buildRunId || asset.build_run_id || '').trim(),
    source: String(asset.source || asset.assetSource || '').trim(),
    assetId: String(asset.assetId || asset.id || '').trim(),
  };
}

export function hasEnvironmentAssetDeclaration(config: any) {
  return Boolean(config) && isPlainObject(config) && hasOwn(config, 'asset') && isPlainObject(config.asset);
}

export function resolveEnvironmentAssetProfile(config: any) {
  const asset = config && isPlainObject(config.asset) ? config.asset : null;
  return String(asset && (asset.envProfile || asset.env_profile || asset.profile) || 'default').trim() || 'default';
}

export function buildEnvironmentAssetCheckResult(asset: any, status: string, reason = '', skill: any = null) {
  const testingDocument = readSkillTestingDocument(skill);
  return {
    status,
    phase: 'asset-check',
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
    reason,
    asset: {
      envProfile: String(asset && asset.envProfile || 'default').trim() || 'default',
      image: String(asset && asset.image || '').trim(),
      imageDigest: String(asset && asset.imageDigest || '').trim(),
      baseImage: String(asset && asset.baseImage || '').trim(),
      baseImageDigest: String(asset && asset.baseImageDigest || '').trim(),
      testingMdHash: String(asset && asset.testingMdHash || '').trim(),
      currentTestingMdHash: String(testingDocument && testingDocument.contentHash || '').trim(),
      manifestHash: String(asset && asset.manifestHash || '').trim(),
      manifestPath: String(asset && asset.manifestPath || '').trim(),
      buildCaseId: String(asset && asset.buildCaseId || '').trim(),
      buildRunId: String(asset && asset.buildRunId || '').trim(),
      source: String(asset && asset.source || '').trim(),
      assetId: String(asset && asset.assetId || '').trim(),
    },
    source: {
      testingDocPath: testingDocument && testingDocument.path ? normalizePathForJson(testingDocument.path) : '',
      testingDocUsed: false,
      testingDocHash: testingDocument && testingDocument.contentHash ? String(testingDocument.contentHash) : '',
    },
  };
}

export function resolveEnvironmentAssetCheck(config: any, skill: any = null) {
  const asset = getEnvironmentAssetRef(config);
  if (!asset) {
    return null;
  }

  if (!asset.image) {
    return buildEnvironmentAssetCheckResult(asset, 'env_not_built', 'environment asset has no image; run an environment-build case first', skill);
  }

  const testingDocument = readSkillTestingDocument(skill);
  const currentTestingHash = testingDocument && testingDocument.contentHash ? String(testingDocument.contentHash) : '';
  if (asset.testingMdHash && currentTestingHash && asset.testingMdHash !== currentTestingHash) {
    return buildEnvironmentAssetCheckResult(
      asset,
      'env_stale',
      `TESTING.md hash changed: expected ${asset.testingMdHash}, current ${currentTestingHash}`,
      skill
    );
  }

  return buildEnvironmentAssetCheckResult(asset, 'passed', 'environment asset is bound to a reusable image', skill);
}

export function normalizeEnvironmentBuildInput(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      enabled: false,
      buildImage: false,
      image: '',
      envProfile: '',
      baseImage: '',
      baseImageDigest: '',
      wslDistro: '',
    };
  }

  const enabled = input.enabled !== false;
  const buildImage = input.buildImage === true || input.build_image === true;
  return {
    enabled,
    buildImage,
    image: String(input.image || input.imageTag || input.tag || '').trim(),
    envProfile: String(input.envProfile || input.env_profile || input.profile || '').trim(),
    baseImage: String(input.baseImage || input.base_image || input.baseImageRef || input.base_image_ref || '').trim(),
    baseImageDigest: String(input.baseImageDigest || input.base_image_digest || '').trim(),
    wslDistro: String(input.wslDistro || input.wsl_distro || '').trim(),
  };
}

export function parseBuiltEnvironmentImageFromOutput(output: string) {
  const normalized = String(output || '');
  const imageMatch = normalized.match(/^[ \t]*image:[ \t]*(.+)$/im);
  const manifestMatch = normalized.match(/^[ \t]*manifest hash:[ \t]*(.+)$/im);
  return {
    image: imageMatch ? String(imageMatch[1] || '').trim() : '',
    manifestHash: manifestMatch ? String(manifestMatch[1] || '').trim() : '',
  };
}

export async function buildEnvironmentImageFromManifest(manifestPath: string, buildInput: any = {}) {
  const resolvedManifestPath = path.resolve(String(manifestPath || '').trim());
  const manifestRootDir = path.resolve(String(buildInput && buildInput.manifestRootDir || DEFAULT_ENVIRONMENT_MANIFEST_ROOT_DIR).trim());
  if (!resolvedManifestPath || !isPathWithin(manifestRootDir, resolvedManifestPath)) {
    throw new Error('environment manifest path is outside the allowed manifest root');
  }

  const scriptPath = path.resolve(ROOT_DIR, 'scripts', 'opensandbox', 'build-runtime-image.js');
  const args = [scriptPath, '--environment-manifest', resolvedManifestPath];
  const image = String(buildInput && buildInput.image || '').trim();
  const wslDistro = String(buildInput && buildInput.wslDistro || '').trim();
  if (image) {
    args.push('--tag', image);
  }
  if (wslDistro) {
    args.push('--wsl-distro', wslDistro);
  }

  const output = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, args, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const normalizedStdout = String(stdout || '');
      const normalizedStderr = String(stderr || '');
      if (error) {
        const message = String(normalizedStderr || normalizedStdout || error.message || 'environment image build failed').trim();
        const wrappedError: any = new Error(message);
        wrappedError.cause = error;
        wrappedError.stdout = normalizedStdout;
        wrappedError.stderr = normalizedStderr;
        reject(wrappedError);
        return;
      }
      resolve({ stdout: normalizedStdout, stderr: normalizedStderr });
    });
  });

  const combinedOutput = `${output.stdout}\n${output.stderr}`;
  const parsed = parseBuiltEnvironmentImageFromOutput(combinedOutput);
  return {
    image: parsed.image || image,
    manifestHash: parsed.manifestHash || '',
    logs: combinedOutput.trim(),
  };
}

export function summarizeEnvironmentBuildOutput(buildResult: any) {
  if (!buildResult || typeof buildResult !== 'object') {
    return '';
  }
  const parts = [];
  if (buildResult.manifestPath) {
    parts.push(`manifest: ${buildResult.manifestPath}`);
  }
  if (buildResult.image) {
    parts.push(`image: ${buildResult.image}`);
  }
  if (buildResult.status) {
    parts.push(`status: ${buildResult.status}`);
  }
  return parts.join('\n');
}

function normalizeSkillEnvironmentAssetRow(row: any) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const sourceMetadata = isPlainObject(safeJsonParse(row.source_metadata_json))
    ? safeJsonParse(row.source_metadata_json)
    : {};
  return {
    id: String(row.id || '').trim(),
    skillId: String(row.skill_id || '').trim(),
    envProfile: String(row.env_profile || 'default').trim() || 'default',
    status: String(row.status || '').trim() || 'manifest_ready',
    asset: {
      enabled: true,
      envProfile: String(row.env_profile || 'default').trim() || 'default',
      image: String(row.image || '').trim(),
      imageDigest: String(row.image_digest || '').trim(),
      baseImage: String(row.base_image || '').trim(),
      baseImageDigest: String(row.base_image_digest || '').trim(),
      testingMdHash: String(row.testing_md_hash || '').trim(),
      manifestHash: String(row.manifest_hash || '').trim(),
      manifestPath: String(row.manifest_path || '').trim(),
      buildCaseId: String(row.build_case_id || '').trim(),
      buildRunId: String(row.build_run_id || '').trim(),
      source: 'skill_profile_default',
      assetId: String(row.id || '').trim(),
    },
    sourceMetadata,
    createdAt: String(row.created_at || '').trim(),
    updatedAt: String(row.updated_at || '').trim(),
  };
}

export function createSkillTestEnvironmentAssetStore(options: any = {}) {
  const db = options && options.db ? options.db : null;
  const ensureSchema = options && typeof options.ensureSchema === 'function' ? options.ensureSchema : () => {};

  function listSkillEnvironmentAssets(skillId: string) {
    ensureSchema();
    const rows = db.prepare(`
      SELECT *
      FROM skill_test_environment_assets
      WHERE skill_id = @skillId
      ORDER BY env_profile ASC
    `).all({ skillId });
    return rows.map(normalizeSkillEnvironmentAssetRow).filter(Boolean);
  }

  function getSkillEnvironmentAsset(skillId: string, envProfile: string) {
    ensureSchema();
    const normalizedProfile = String(envProfile || 'default').trim() || 'default';
    const row = db.prepare(`
      SELECT *
      FROM skill_test_environment_assets
      WHERE skill_id = @skillId
        AND env_profile = @envProfile
    `).get({ skillId, envProfile: normalizedProfile });
    return normalizeSkillEnvironmentAssetRow(row);
  }

  function upsertSkillEnvironmentAsset(skillId: string, buildResult: any = {}) {
    ensureSchema();
    const asset = buildResult && isPlainObject(buildResult.asset) ? buildResult.asset : null;
    if (!asset) {
      return null;
    }

    const envProfile = String(asset.envProfile || buildResult.envProfile || 'default').trim() || 'default';
    const manifestHash = String(asset.manifestHash || buildResult.manifestHash || '').trim();
    if (!envProfile || !manifestHash) {
      return null;
    }

    const status = String(buildResult.status || '').trim() || 'manifest_ready';
    if (status === 'image_build_failed') {
      return null;
    }

    const existing = getSkillEnvironmentAsset(skillId, envProfile);
    const nextHasImage = String(asset.image || '').trim().length > 0;
    if (!nextHasImage && existing && existing.asset && String(existing.asset.image || '').trim()) {
      return existing;
    }

    const recordId = existing && existing.id ? existing.id : randomUUID();
    const createdAt = existing && existing.createdAt ? existing.createdAt : nowIso();
    const updatedAt = nowIso();
    const sourceMetadata = {
      source: 'environment_build_case',
      status,
      buildCaseId: String(asset.buildCaseId || buildResult.buildCaseId || '').trim(),
      buildRunId: String(asset.buildRunId || buildResult.runId || '').trim(),
      envProfile,
      registeredAt: updatedAt,
    };

    db.prepare(`
      INSERT INTO skill_test_environment_assets (
        id,
        skill_id,
        env_profile,
        status,
        image,
        image_digest,
        base_image,
        base_image_digest,
        testing_md_hash,
        manifest_hash,
        manifest_path,
        build_case_id,
        build_run_id,
        source_metadata_json,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @skillId,
        @envProfile,
        @status,
        @image,
        @imageDigest,
        @baseImage,
        @baseImageDigest,
        @testingMdHash,
        @manifestHash,
        @manifestPath,
        @buildCaseId,
        @buildRunId,
        @sourceMetadataJson,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(skill_id, env_profile) DO UPDATE SET
        status = excluded.status,
        image = excluded.image,
        image_digest = excluded.image_digest,
        base_image = excluded.base_image,
        base_image_digest = excluded.base_image_digest,
        testing_md_hash = excluded.testing_md_hash,
        manifest_hash = excluded.manifest_hash,
        manifest_path = excluded.manifest_path,
        build_case_id = excluded.build_case_id,
        build_run_id = excluded.build_run_id,
        source_metadata_json = excluded.source_metadata_json,
        updated_at = excluded.updated_at
    `).run({
      id: recordId,
      skillId,
      envProfile,
      status,
      image: String(asset.image || '').trim(),
      imageDigest: String(asset.imageDigest || buildResult.imageDigest || '').trim(),
      baseImage: String(buildResult.baseImage || asset.baseImage || '').trim(),
      baseImageDigest: String(asset.baseImageDigest || buildResult.baseImageDigest || '').trim(),
      testingMdHash: String(asset.testingMdHash || buildResult.testingMdHash || '').trim(),
      manifestHash,
      manifestPath: String(asset.manifestPath || buildResult.manifestPath || '').trim(),
      buildCaseId: String(asset.buildCaseId || buildResult.buildCaseId || '').trim(),
      buildRunId: String(asset.buildRunId || buildResult.runId || '').trim(),
      sourceMetadataJson: JSON.stringify(sourceMetadata),
      createdAt,
      updatedAt,
    });

    return getSkillEnvironmentAsset(skillId, envProfile);
  }

  function applySharedEnvironmentAssetDefault(skillId: string, resolvedEnvironment: any) {
    if (!resolvedEnvironment || !resolvedEnvironment.enabled || !resolvedEnvironment.config || !isPlainObject(resolvedEnvironment.config)) {
      return { resolvedEnvironment, sharedAsset: null };
    }

    const config = resolvedEnvironment.config;
    const declaredAsset = hasEnvironmentAssetDeclaration(config) && isPlainObject(config.asset) ? config.asset : null;
    if (declaredAsset && declaredAsset.enabled === false) {
      return { resolvedEnvironment, sharedAsset: null };
    }

    const currentAsset = getEnvironmentAssetRef(config);
    if (currentAsset && currentAsset.image) {
      return { resolvedEnvironment, sharedAsset: null };
    }

    const envProfile = currentAsset && currentAsset.envProfile
      ? currentAsset.envProfile
      : resolveEnvironmentAssetProfile(config);
    const sharedAsset = getSkillEnvironmentAsset(skillId, envProfile);
    if (!sharedAsset || !sharedAsset.asset) {
      return { resolvedEnvironment, sharedAsset: null };
    }

    const mergedAsset = {
      ...sharedAsset.asset,
      enabled: true,
      envProfile,
    };
    const nextConfig = {
      ...config,
      asset: mergedAsset,
    };
    return {
      resolvedEnvironment: {
        ...resolvedEnvironment,
        config: nextConfig,
      },
      sharedAsset,
    };
  }

  return {
    listSkillEnvironmentAssets,
    getSkillEnvironmentAsset,
    upsertSkillEnvironmentAsset,
    applySharedEnvironmentAssetDefault,
  };
}

export async function finalizeEnvironmentBuildCase(options: any = {}) {
  const runtimeSkill = options.runtimeSkill;
  const resolvedEnvironment = options.resolvedEnvironment || {};
  const environmentResult = options.environmentResult || {};
  const testCase = options.testCase || {};
  const taskId = String(options.taskId || '').trim();
  const environmentManifestRootDir = typeof options.environmentManifestRootDir === 'string' && options.environmentManifestRootDir.trim()
    ? String(options.environmentManifestRootDir).trim()
    : DEFAULT_ENVIRONMENT_MANIFEST_ROOT_DIR;
  const environmentImageBuilder = typeof options.environmentImageBuilder === 'function'
    ? options.environmentImageBuilder
    : buildEnvironmentImageFromManifest;
  const updateTestCaseSourceMetadata = typeof options.updateTestCaseSourceMetadata === 'function'
    ? options.updateTestCaseSourceMetadata
    : null;
  const upsertSkillEnvironmentAsset = typeof options.upsertSkillEnvironmentAsset === 'function'
    ? options.upsertSkillEnvironmentAsset
    : null;
  const runStore = options.runStore && typeof options.runStore.appendTaskEvent === 'function'
    ? options.runStore
    : null;
  const emitProgress = typeof options.emitProgress === 'function' ? options.emitProgress : () => {};
  const nowIsoImpl = typeof options.nowIso === 'function' ? options.nowIso : nowIso;
  const environmentBuildInput = normalizeEnvironmentBuildInput(options.environmentBuildInput);
  const testingDocument = readSkillTestingDocument(runtimeSkill);

  const buildInput = {
    ...environmentBuildInput,
    ...(environmentBuildInput.image ? { image: environmentBuildInput.image } : {}),
    ...(environmentBuildInput.envProfile ? { envProfile: environmentBuildInput.envProfile } : {}),
    ...(environmentBuildInput.baseImage ? { baseImage: environmentBuildInput.baseImage } : {}),
    ...(environmentBuildInput.baseImageDigest ? { baseImageDigest: environmentBuildInput.baseImageDigest } : {}),
  };
  const manifest = buildEnvironmentBuildManifest(resolvedEnvironment.config, environmentResult, {
    buildInput,
    skillId: testCase.skillId,
    caseId: testCase.id,
    runId: taskId,
    generatedAt: nowIsoImpl(),
    testingDocument,
    testingMdHash: String(resolvedEnvironment.source && resolvedEnvironment.source.testingDocHash || testingDocument && testingDocument.contentHash || '').trim(),
    testingDocPath: String(resolvedEnvironment.source && resolvedEnvironment.source.testingDocPath || testingDocument && testingDocument.path || '').trim(),
    testingDocUsed: Boolean(resolvedEnvironment.source && resolvedEnvironment.source.testingDocUsed),
    environmentConfigSource: resolvedEnvironment.source && resolvedEnvironment.source.testingDocUsed ? 'TESTING.md#skill-test-environment' : 'case.environmentConfig',
    baseImage: environmentBuildInput.baseImage || process.env.CAFF_SKILL_TEST_ENV_BASE_IMAGE || process.env.CAFF_SKILL_TEST_OPENSANDBOX_IMAGE || 'caff-skill-test-caff:local',
    baseImageDigest: environmentBuildInput.baseImageDigest || '',
  });
  const persisted = persistEnvironmentBuildManifest(manifest, environmentManifestRootDir);
  let imageBuild: any = null;
  let buildStatus = 'manifest_ready';
  let buildError = '';

  if (environmentBuildInput.buildImage) {
    emitProgress('image-build', '正在从 manifest 构建干净环境镜像…');
    try {
      imageBuild = await Promise.resolve(environmentImageBuilder(persisted.manifestPath, {
        ...environmentBuildInput,
        image: environmentBuildInput.image || manifest.image,
        manifest,
        manifestRootDir: environmentManifestRootDir,
      }));
      buildStatus = 'image_built';
    } catch (error: any) {
      buildStatus = 'image_build_failed';
      buildError = String(error && error.message || error || 'environment image build failed').trim();
    }
  }

  const builtImage = String(imageBuild && (imageBuild.image || imageBuild.tag) || '').trim();
  const builtImageDigest = String(imageBuild && (imageBuild.imageDigest || imageBuild.image_digest) || '').trim();
  const builtBaseImageDigest = String(imageBuild && (imageBuild.baseImageDigest || imageBuild.base_image_digest) || manifest.baseImageDigest || '').trim();
  const asset = {
    enabled: true,
    envProfile: String(manifest.envProfile || '').trim() || 'default',
    image: builtImage,
    imageDigest: builtImageDigest,
    baseImage: String(manifest.baseImage || '').trim(),
    baseImageDigest: builtBaseImageDigest,
    testingMdHash: String(manifest.testingMdHash || '').trim(),
    manifestHash: String(manifest.manifestHash || '').trim(),
    manifestPath: persisted.manifestPath,
    buildCaseId: testCase.id,
    buildRunId: taskId,
    source: 'environment_build_case',
  };
  const buildResult: any = {
    status: buildStatus,
    manifestPath: persisted.manifestPath,
    manifestHash: String(manifest.manifestHash || '').trim(),
    suggestedImage: String(manifest.image || '').trim(),
    image: builtImage,
    imageDigest: builtImageDigest,
    baseImage: String(manifest.baseImage || '').trim(),
    baseImageDigest: builtBaseImageDigest,
    testingMdHash: String(manifest.testingMdHash || '').trim(),
    envProfile: asset.envProfile,
    buildCaseId: testCase.id,
    runId: taskId,
    generatedAt: String(manifest.generatedAt || '').trim(),
    buildCommand: `node scripts/opensandbox/build-runtime-image.js --environment-manifest ${persisted.manifestPath}`,
    asset,
    ...(imageBuild && imageBuild.logs ? { logs: String(imageBuild.logs).slice(0, 4000) } : {}),
    ...(buildError ? { error: buildError } : {}),
  };

  if (runStore) {
    runStore.appendTaskEvent(taskId, 'skill_test_environment_manifest', {
      manifestPath: persisted.manifestPath,
      manifestHash: buildResult.manifestHash,
      status: buildStatus,
      image: builtImage,
      suggestedImage: buildResult.suggestedImage,
      createdAt: nowIsoImpl(),
    });
  }

  const registeredSharedAsset = upsertSkillEnvironmentAsset ? upsertSkillEnvironmentAsset(testCase.skillId, buildResult) : null;
  if (registeredSharedAsset) {
    buildResult.sharedAsset = {
      assetId: registeredSharedAsset.id,
      envProfile: registeredSharedAsset.envProfile,
      status: registeredSharedAsset.status,
      image: registeredSharedAsset.asset && registeredSharedAsset.asset.image
        ? registeredSharedAsset.asset.image
        : '',
    };
  }

  if (updateTestCaseSourceMetadata) {
    updateTestCaseSourceMetadata(testCase.id, (metadata: any) => ({
      ...metadata,
      environmentBuild: buildResult,
    }));
  }

  return buildResult;
}
