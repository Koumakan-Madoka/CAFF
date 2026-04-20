import type {
  SkillTestExecutionEvidence,
  SkillTestExecutionPlane,
  SkillTestIsolationEgressEvidence,
  SkillTestIsolationEvidence,
  SkillTestIsolationIssue,
  SkillTestIsolationPollutionCheck,
  SkillTestIsolationToolPolicyRecorder,
  SkillTestIsolationToolPolicyReject,
  SkillTestSandboxToolAdapter,
  SkillTestSkillRef,
  SkillTestStoreRef,
} from './sandbox-tool-contract';
import { coerceSkillTestSandboxToolAdapter } from './sandbox-tool-contract';

type SkillTestExecutionEvidenceFallback = Partial<SkillTestExecutionEvidence>;
type SkillTestEgressEvidenceFallback = Partial<SkillTestIsolationEgressEvidence>;

type SeedIsolatedConversationStoreInput = {
  agentId?: unknown;
  agentName?: unknown;
  conversationId?: unknown;
  turnId?: unknown;
  promptUserMessage?: unknown;
  nowIso?: () => string;
};

type PromptUserMessageRef = {
  id?: unknown;
  turnId?: unknown;
  senderName?: unknown;
  content?: unknown;
  status?: unknown;
  createdAt?: unknown;
};

type BuildLegacySkillTestIsolationEvidenceInput = {
  runId?: unknown;
  caseId?: unknown;
  trellisMode?: unknown;
  publishGate?: unknown;
  allowedBridgeTools?: unknown;
  rejects?: unknown;
  projectDir?: unknown;
  sandboxDir?: unknown;
  privateDir?: unknown;
  sqlitePath?: unknown;
  skill?: SkillTestSkillRef | null;
  nowIso?: () => string;
};

type BuildSkillTestIsolationUnsafeReasonsInput = {
  publishGate?: boolean;
  execution?: SkillTestExecutionEvidence | null;
  egressMode?: unknown;
  egress?: SkillTestIsolationEgressEvidence | null;
  pollutionCheck?: SkillTestIsolationPollutionCheck | null;
  cleanupError?: unknown;
};

function defaultNowIso(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown, fallback = ''): string {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function clipText(value: unknown, maxLength = 200): string {
  const text = normalizeText(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
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

function normalizePathForJson(value: unknown): string {
  return normalizeText(value).replace(/\\/g, '/');
}

function normalizeToolName(value: unknown): string {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'participants') {
    return 'list-participants';
  }
  return normalized;
}

function normalizeAllowedBridgeTools(value: unknown): string[] {
  const seen = new Set<string>();
  const tools: string[] = [];

  for (const entry of Array.isArray(value) ? value : []) {
    const normalized = normalizeToolName(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    tools.push(normalized);
  }

  return tools;
}

function normalizeExecutionPlane(value: unknown, fallback: SkillTestExecutionPlane = 'host'): SkillTestExecutionPlane {
  const normalized = normalizeText(value, fallback).toLowerCase();
  return normalized === 'sandbox' ? 'sandbox' : 'host';
}

function normalizePathSemantics(value: unknown, fallback: SkillTestExecutionPlane = 'host'): SkillTestExecutionPlane {
  const normalized = normalizeText(value, fallback).toLowerCase();
  return normalized === 'sandbox' ? 'sandbox' : 'host';
}

export function resolveSkillTestSandboxToolAdapter(value: unknown): SkillTestSandboxToolAdapter | null {
  const directAdapter = coerceSkillTestSandboxToolAdapter(value);
  if (directAdapter) {
    return directAdapter;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  return coerceSkillTestSandboxToolAdapter(value.toolAdapter);
}

export function normalizeSkillTestExecutionEvidence(
  input: unknown,
  fallback: SkillTestExecutionEvidenceFallback = {},
): SkillTestExecutionEvidence {
  const value = isPlainObject(input) ? input : {};
  const loopRuntime = normalizeExecutionPlane(
    value.loopRuntime ?? fallback.loopRuntime ?? value.runtime ?? value.mode ?? fallback.runtime ?? 'host',
  );
  const toolRuntime = normalizeExecutionPlane(
    value.toolRuntime,
    normalizeExecutionPlane(fallback.toolRuntime, loopRuntime === 'sandbox' ? 'sandbox' : 'host'),
  );
  const pathSemantics = normalizePathSemantics(
    value.pathSemantics ?? value.pathView,
    normalizePathSemantics(fallback.pathSemantics, loopRuntime === 'sandbox' ? 'sandbox' : 'host'),
  );
  const runtime = normalizeExecutionPlane(
    value.runtime ?? value.mode,
    normalizeExecutionPlane(fallback.runtime, loopRuntime),
  );
  const preparedOnly = normalizeBoolean(value.preparedOnly, fallback.preparedOnly ?? false);
  const reason = clipText(
    value.reason
      ?? fallback.reason
      ?? (
        loopRuntime === 'sandbox'
          ? 'Agent loop and tool execution both run inside the isolation adapter'
          : toolRuntime === 'sandbox'
            ? 'Agent loop runs on the host while file and command tools are delegated into the sandbox case world'
            : 'Isolation prepared case resources, then execution continued on the host runtime'
      ),
    240,
  );

  return {
    runtime,
    loopRuntime,
    toolRuntime,
    pathSemantics,
    preparedOnly,
    reason,
  };
}

export function normalizeSkillTestEgressEvidence(
  input: unknown,
  fallback: SkillTestEgressEvidenceFallback = {},
): SkillTestIsolationEgressEvidence {
  const value = isPlainObject(input) ? input : {};
  const mode = normalizeText(value.mode ?? fallback.mode, 'deny').toLowerCase() || 'deny';
  const enforced = normalizeBoolean(value.enforced, fallback.enforced ?? false);
  const fallbackScope = enforced ? 'sandbox' : 'record-only';
  const scope = clipText(normalizeText(value.scope ?? fallback.scope, fallbackScope).toLowerCase() || fallbackScope, 80);
  const reason = clipText(
    value.reason
      ?? fallback.reason
      ?? (
        enforced
          ? 'Network policy is enforced by the isolation adapter'
          : 'Requested egress policy is recorded in evidence but not actively enforced by the current adapter'
      ),
    240,
  );

  return {
    mode,
    enforced,
    scope,
    reason,
  };
}

export function createSkillTestIsolationPolicyRejectRecorder(
  sharedRejects: SkillTestIsolationToolPolicyReject[] = [],
  options: { nowIso?: () => string } = {},
): SkillTestIsolationToolPolicyRecorder {
  const rejectList = Array.isArray(sharedRejects) ? sharedRejects : [];
  const getNowIso = typeof options.nowIso === 'function' ? options.nowIso : defaultNowIso;

  return {
    rejects: rejectList,
    allowedTools: [],
    record(toolName: string, reason: string, details: Record<string, unknown> = {}) {
      rejectList.push({
        toolName: normalizeToolName(toolName),
        reason: clipText(reason, 240),
        details: isPlainObject(details) ? details : {},
        createdAt: getNowIso(),
      });
    },
  };
}

export function seedIsolatedConversationStore(
  store: SkillTestStoreRef,
  input: SeedIsolatedConversationStoreInput = {},
): void {
  const getNowIso = typeof input.nowIso === 'function' ? input.nowIso : defaultNowIso;
  const agentId = normalizeText(input.agentId, 'skill-test-agent');
  const agentName = normalizeText(input.agentName, 'Skill Test Agent');
  const conversationId = normalizeText(input.conversationId, `skill-test-${agentId}`);
  const promptUserMessage = isPlainObject(input.promptUserMessage)
    ? input.promptUserMessage as PromptUserMessageRef
    : null;

  if (!store.getAgent(agentId)) {
    store.saveAgent({
      id: agentId,
      name: agentName,
      personaPrompt: 'Skill test isolated agent.',
    });
  }

  if (!store.getConversation(conversationId)) {
    store.createConversation({
      id: conversationId,
      title: `Skill Test ${conversationId}`,
      participants: [agentId],
    });
  }

  if (promptUserMessage?.id && !store.getMessage(String(promptUserMessage.id).trim())) {
    store.createMessage({
      id: normalizeText(promptUserMessage.id),
      conversationId,
      turnId: normalizeText(promptUserMessage.turnId ?? input.turnId, 'skill-test-turn'),
      role: 'user',
      senderName: normalizeText(promptUserMessage.senderName, 'TestUser'),
      content: promptUserMessage.content ?? '',
      status: normalizeText(promptUserMessage.status, 'completed'),
      createdAt: normalizeText(promptUserMessage.createdAt, getNowIso()),
    });
  }
}

export function buildLegacySkillTestIsolationEvidence(
  input: BuildLegacySkillTestIsolationEvidenceInput = {},
): SkillTestIsolationEvidence {
  const getNowIso = typeof input.nowIso === 'function' ? input.nowIso : defaultNowIso;
  const timestamp = getNowIso();

  return {
    mode: 'legacy-local',
    notIsolated: true,
    publishGate: normalizeBoolean(input.publishGate, false),
    driver: {
      name: 'legacy-local',
      version: '',
    },
    sandboxId: '',
    runId: normalizeText(input.runId),
    caseId: normalizeText(input.caseId),
    trellisMode: normalizeText(input.trellisMode, 'none'),
    egressMode: 'host',
    toolPolicy: {
      allowedTools: normalizeAllowedBridgeTools(input.allowedBridgeTools),
      rejects: Array.isArray(input.rejects) ? input.rejects.slice() : [],
    },
    execution: {
      runtime: 'host',
      loopRuntime: 'host',
      toolRuntime: 'host',
      pathSemantics: 'host',
      preparedOnly: false,
      reason: 'Legacy-local mode executes directly on the host runtime',
    },
    egress: {
      mode: 'host',
      enforced: false,
      scope: 'host',
      reason: 'Legacy-local mode does not apply a sandbox network policy',
    },
    resources: {
      projectDir: normalizePathForJson(input.projectDir),
      sandboxDir: normalizePathForJson(input.sandboxDir),
      privateDir: normalizePathForJson(input.privateDir),
      sqlitePath: normalizePathForJson(input.sqlitePath),
      skillPath: input.skill?.path ? normalizePathForJson(input.skill.path) : '',
    },
    pollutionCheck: {
      checked: false,
      ok: false,
      changeCount: 0,
      changes: [],
    },
    cleanup: {
      ok: true,
      error: '',
    },
    unsafe: false,
    unsafeReasons: ['not_isolated'],
    createdAt: timestamp,
    finishedAt: timestamp,
  };
}

export function buildSkillTestIsolationUnsafeReasons(
  input: BuildSkillTestIsolationUnsafeReasonsInput = {},
): string[] {
  const unsafeReasons: string[] = [];

  if (input.pollutionCheck?.ok === false) {
    unsafeReasons.push('pollution_check_failed');
  }
  if (input.publishGate && input.execution?.toolRuntime !== 'sandbox') {
    unsafeReasons.push('tool_runtime_not_sandboxed');
  }
  if (input.publishGate && input.execution?.pathSemantics !== 'sandbox') {
    unsafeReasons.push('path_semantics_not_sandboxed');
  }
  if (input.publishGate && normalizeText(input.egressMode).toLowerCase() === 'deny' && input.egress?.enforced !== true) {
    unsafeReasons.push('egress_not_enforced');
  }
  if (normalizeText(input.cleanupError)) {
    unsafeReasons.push('cleanup_failed');
  }

  return unsafeReasons;
}

export function buildSkillTestIsolationIssues(input: unknown): SkillTestIsolationIssue[] {
  if (!isPlainObject(input)) {
    return [];
  }

  const isolationEvidence = input as Partial<SkillTestIsolationEvidence>;
  const issues: SkillTestIsolationIssue[] = [];

  if (isolationEvidence.notIsolated) {
    issues.push({
      code: 'skill_test_not_isolated',
      severity: 'warning',
      path: 'isolation',
      message: 'Run used legacy-local mode and cannot serve as isolated publish-gate evidence',
    });
  }

  if (Array.isArray(isolationEvidence.toolPolicy?.rejects) && isolationEvidence.toolPolicy.rejects.length > 0) {
    issues.push({
      code: 'skill_test_policy_rejects_present',
      severity: 'warning',
      path: 'isolation.toolPolicy.rejects',
      message: `Tool policy rejected ${isolationEvidence.toolPolicy.rejects.length} request(s) during the run`,
    });
  }

  if (isolationEvidence.mode === 'isolated' && isolationEvidence.execution?.toolRuntime !== 'sandbox') {
    issues.push({
      code: 'skill_test_tools_not_sandboxed',
      severity: isolationEvidence.publishGate ? 'error' : 'warning',
      path: 'isolation.execution.toolRuntime',
      message: 'Run kept file or command tool execution on the host instead of delegating it into the sandbox case world',
    });
  }

  if (isolationEvidence.mode === 'isolated' && isolationEvidence.execution?.pathSemantics !== 'sandbox') {
    issues.push({
      code: 'skill_test_path_semantics_not_sandboxed',
      severity: isolationEvidence.publishGate ? 'error' : 'warning',
      path: 'isolation.execution.pathSemantics',
      message: 'Run still exposed host-visible cwd or path semantics instead of a sandbox path view',
    });
  }

  if (isolationEvidence.mode === 'isolated' && isolationEvidence.egress?.mode === 'deny' && isolationEvidence.egress.enforced !== true) {
    issues.push({
      code: 'skill_test_egress_not_enforced',
      severity: isolationEvidence.publishGate ? 'error' : 'warning',
      path: 'isolation.egress',
      message: clipText(isolationEvidence.egress.reason || 'Run requested deny egress mode without an enforced network policy', 240),
    });
  }

  if (isolationEvidence.pollutionCheck?.checked && isolationEvidence.pollutionCheck.ok === false) {
    issues.push({
      code: 'skill_test_pollution_detected',
      severity: 'error',
      path: 'isolation.pollutionCheck',
      message: 'Live project or shared state changed during an isolated skill test run',
    });
  }

  if (isolationEvidence.cleanup?.ok === false) {
    issues.push({
      code: 'skill_test_cleanup_failed',
      severity: 'error',
      path: 'isolation.cleanup',
      message: clipText(isolationEvidence.cleanup.error || 'Isolated skill test cleanup failed', 240),
    });
  }

  return issues;
}

export function getSkillTestIsolationFailureMessage(input: unknown): string {
  if (!isPlainObject(input)) {
    return 'Skill test isolation failed';
  }

  const isolationEvidence = input as Partial<SkillTestIsolationEvidence>;
  const unsafeReasons = Array.isArray(isolationEvidence.unsafeReasons) ? isolationEvidence.unsafeReasons : [];
  const toolsNotSandboxed = unsafeReasons.includes('tool_runtime_not_sandboxed');
  const pathSemanticsNotSandboxed = unsafeReasons.includes('path_semantics_not_sandboxed');

  if (toolsNotSandboxed && pathSemanticsNotSandboxed) {
    return 'Skill test publish-gate requires sandbox-routed tools and sandbox path semantics, but the current run still exposed host execution semantics';
  }

  if (toolsNotSandboxed) {
    return 'Skill test publish-gate requires sandbox-routed file and command tools, but the current run kept tool execution on the host';
  }

  if (pathSemanticsNotSandboxed) {
    return 'Skill test publish-gate requires sandbox path semantics, but the current run still exposed host cwd or file paths';
  }

  if (unsafeReasons.includes('execution_not_sandboxed')) {
    return 'Skill test publish-gate requires sandbox execution, but the run executed on the host runtime';
  }

  if (unsafeReasons.includes('egress_not_enforced')) {
    return 'Skill test publish-gate requires enforced deny-egress policy, but the current adapter only recorded the request';
  }

  if (isolationEvidence.pollutionCheck?.ok === false) {
    return 'Skill test isolation detected live-state pollution';
  }

  if (isolationEvidence.cleanup?.ok === false) {
    return `Skill test isolation cleanup failed: ${clipText(isolationEvidence.cleanup.error || 'unknown error', 200)}`;
  }

  return 'Skill test isolation failed';
}
