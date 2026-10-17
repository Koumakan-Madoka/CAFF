// Shared memory-only input preparation. The trusted reader MUST enforce its
// own independent input authorization; this module never opens a source path.
// A complete input does not confer file consistency or strict replay eligibility.
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import { containsSecretSentinel, replaceControlledVariables } from './secrets';
import { validateSessionV2, PI_VERSION_PIN } from './session-validator';

const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
// No output plan may retain a pooled backing that also held rejected materials.
function ownedUtf8(text: string) {
  const bytes = Buffer.alloc(Buffer.byteLength(text, 'utf8'));
  bytes.write(text, 'utf8');
  return bytes;
}
function sanitizeRunConfig(raw: any) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const pick = (value: any) => String(value || '').trim();
  return {
    provider: pick(source.provider), model: pick(source.model), modelProfileId: pick(source.modelProfileId),
    modelProfileName: pick(source.modelProfileName), promptVersion: pick(source.promptVersion),
    skillIds: Array.isArray(source.skillIds) ? source.skillIds.map(String) : [],
    conversationSkillIds: Array.isArray(source.conversationSkillIds) ? source.conversationSkillIds : [],
  };
}
const CONFIG_SNAPSHOT_REQUIRED_KEYS = [
  ['piVersion', (value: any) => typeof value === 'string' && value.trim().length > 0],
  ['agentPromptVersion', (value: any) => typeof value === 'string' && value.trim().length > 0],
  ['toolBridgeEnabled', (value: any) => typeof value === 'boolean'],
  ['deliveryMode', (value: any) => value === 'fresh' || value === 'resume'],
  ['agentName', (value: any) => typeof value === 'string'],
];
function isValidConfigSnapshot(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
    && CONFIG_SNAPSHOT_REQUIRED_KEYS.every(([key, check]: any) => check(value[key]));
}

export function prepareReplayInput(input: any, deliveryMode: any, authorizedRoot: any, readSession: (inputPath: string) => any) {
  if (deliveryMode !== 'fresh' && deliveryMode !== 'resume') throw new Error('replay_input_invalid');
  const replayInput: any = {
    deliveryMode, complete: true, incompleteReasons: [] as string[], verifiedDimensions: [] as string[],
    unverifiedDimensions: [] as string[], controlledReplacements: [] as any[], promptBlobHash: '', normalizedPromptHash: '',
    sessionBlobHash: '', sessionLineCount: 0, runConfig: sanitizeRunConfig(input.runConfig),
    harness: { serverVersion: '', skillSnapshots: [] as any[] },
  };
  const plans: any[] = [];
  const markIncomplete = (reason: string) => {
    replayInput.complete = false;
    if (!replayInput.incompleteReasons.includes(reason)) replayInput.incompleteReasons.push(reason);
  };
  // Runtime images are not archived by this channel; retain only count.
  replayInput.invocationImageCount = Array.isArray(input.images) ? input.images.length : 0;
  if (input.images !== undefined && !Array.isArray(input.images)) {
    replayInput.invocationImageCount = null; markIncomplete('invocation_images_invalid');
  } else if (replayInput.invocationImageCount > 0) markIncomplete('invocation_images_not_archived');

  const replaced = replaceControlledVariables(String(input.prompt || ''), input.controlledValues);
  replayInput.controlledReplacements = replaced.replacements;
  const promptBuffer = ownedUtf8(replaced.text);
  if (containsSecretSentinel(promptBuffer)) markIncomplete('prompt_contains_secret');
  else {
    const promptHash = hash(promptBuffer);
    plans.push({ hash: promptHash, content: promptBuffer });
    replayInput.promptBlobHash = promptHash; replayInput.normalizedPromptHash = promptHash;
  }

  if (deliveryMode === 'resume') {
    const sessionPath = String(input.sessionPath || '').trim();
    if (!sessionPath) markIncomplete('session_missing');
    else {
      const access = readSession(sessionPath);
      if (!access.ok) markIncomplete(access.reason);
      else {
        let sessionText: string | undefined;
        // Never replace malformed UTF-8 with U+FFFD and archive invented bytes.
        // Preserve decoded BOM for the existing validator's whitespace rules.
        try { sessionText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(access.content); }
        catch { markIncomplete('session_utf8_invalid'); }
        if (sessionText !== undefined) {
          const sessionReplaced = replaceControlledVariables(sessionText, input.controlledValues);
          replayInput.controlledReplacements = replayInput.controlledReplacements.concat(sessionReplaced.replacements);
          const sessionBuffer = ownedUtf8(sessionReplaced.text);
          const validation = validateSessionV2(sessionReplaced.text, { authorizedRoot });
          replayInput.sessionLineCount = validation.lineCount;
          replayInput.verifiedDimensions = validation.verifiedDimensions;
          replayInput.unverifiedDimensions = validation.unverifiedDimensions;
          if (!validation.ok) markIncomplete(validation.reason);
          if (containsSecretSentinel(sessionBuffer)) markIncomplete('session_contains_secret');
          if (validation.ok && !replayInput.incompleteReasons.includes('session_contains_secret')) {
            const sessionHash = hash(sessionBuffer);
            plans.push({ hash: sessionHash, content: sessionBuffer }); replayInput.sessionBlobHash = sessionHash;
          }
          for (const dimension of validation.unverifiedDimensions) markIncomplete(dimension);
        }
      }
    }
  }
  if (!replayInput.runConfig.model) markIncomplete('model_config_missing');
  if (!replayInput.runConfig.provider || !replayInput.runConfig.promptVersion) markIncomplete('run_config_incomplete');
  const harnessInput = input.harness && typeof input.harness === 'object' ? input.harness : {};
  replayInput.harness.serverVersion = String(harnessInput.serverVersion || '').trim();
  if (!replayInput.harness.serverVersion) markIncomplete('harness_config_unverified');
  const configSnapshot = harnessInput.configSnapshot;
  if (isValidConfigSnapshot(configSnapshot)) {
    const configBuffer = ownedUtf8(JSON.stringify(configSnapshot));
    if (containsSecretSentinel(configBuffer)) markIncomplete('harness_config_contains_secret');
    else {
      const configHash = hash(configBuffer); plans.push({ hash: configHash, content: configBuffer });
      replayInput.harness.configSnapshotHash = configHash;
    }
    const declaredPiVersion = String(configSnapshot.piVersion || '').trim().replace(/^pi:/, '');
    if (declaredPiVersion !== PI_VERSION_PIN) markIncomplete('harness_version_unverified');
    if (String(configSnapshot.deliveryMode) !== deliveryMode) markIncomplete('harness_delivery_mode_mismatch');
  } else markIncomplete('harness_tool_config_unverified');
  const snapshots = Array.isArray(harnessInput.skillSnapshots) ? harnessInput.skillSnapshots : [];
  const snapshotsById = new Map<string, any>();
  for (const snap of snapshots) {
    const id = String(snap && snap.id || '').trim();
    if (id && !snapshotsById.has(id)) snapshotsById.set(id, snap);
  }
  const declaredSkillIds = new Set<string>([
    ...replayInput.runConfig.skillIds, ...replayInput.runConfig.conversationSkillIds,
  ].map((id: any) => String(id || '').trim()).filter(Boolean));
  for (const id of declaredSkillIds) {
    const snap = snapshotsById.get(id);
    if (!snap || !String(snap.sha256 || '').trim() || typeof snap.content !== 'string') markIncomplete(`skill_snapshot_missing:${id}`);
  }
  const archivedSkillIds = new Set<string>();
  for (const [id, snap] of snapshotsById) {
    const declaredSha = String(snap.sha256 || '').trim().toLowerCase();
    if (!declaredSha || typeof snap.content !== 'string') continue;
    const contentBuffer = ownedUtf8(snap.content), actualSha = hash(contentBuffer);
    if (actualSha !== declaredSha) { markIncomplete(`skill_snapshot_hash_mismatch:${id}`); continue; }
    if (containsSecretSentinel(contentBuffer)) { markIncomplete(`skill_contains_secret:${id}`); continue; }
    plans.push({ hash: actualSha, content: contentBuffer });
    replayInput.harness.skillSnapshots.push({ id, source: String(snap.source || '').trim(), sha256: actualSha, blobHash: actualSha });
    archivedSkillIds.add(id);
  }
  for (const id of declaredSkillIds) {
    if (!archivedSkillIds.has(id) && !replayInput.incompleteReasons.some((reason: string) => (
      reason === `skill_snapshot_missing:${id}` || reason === `skill_snapshot_hash_mismatch:${id}` || reason === `skill_contains_secret:${id}`
    ))) markIncomplete(`skill_snapshot_not_archived:${id}`);
  }
  return { replayInput, plans };
}
