// @ts-check

(function registerSkillTestEnvironmentView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});

  skillTests.createEnvironmentViewHelpers = function createEnvironmentViewHelpers(deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value ?? '');
    const clipText = typeof deps.clipText === 'function'
      ? deps.clipText
      : (value) => String(value ?? '');
    const isEnvironmentConfigEnabled = typeof deps.isEnvironmentConfigEnabled === 'function'
      ? deps.isEnvironmentConfigEnabled
      : () => false;
    const getEnvironmentStatusMeta = typeof deps.getEnvironmentStatusMeta === 'function'
      ? deps.getEnvironmentStatusMeta
      : () => null;
    const getEnvironmentCacheStatusMeta = typeof deps.getEnvironmentCacheStatusMeta === 'function'
      ? deps.getEnvironmentCacheStatusMeta
      : () => null;
    const getEnvironmentBuildStatusMeta = typeof deps.getEnvironmentBuildStatusMeta === 'function'
      ? deps.getEnvironmentBuildStatusMeta
      : () => null;
    const readEnvironmentBuildResultFromEvaluation = typeof deps.readEnvironmentBuildResultFromEvaluation === 'function'
      ? deps.readEnvironmentBuildResultFromEvaluation
      : () => null;
    const getEnvironmentBuildResultSummary = typeof deps.getEnvironmentBuildResultSummary === 'function'
      ? deps.getEnvironmentBuildResultSummary
      : () => '';

    function getEnvironmentBuildRunOutcomeSummary(run) {
      const buildResult = readEnvironmentBuildResultFromEvaluation(run && run.evaluation);
      return getEnvironmentBuildResultSummary(buildResult);
    }

    function formatEnvironmentRequirementLabel(entry) {
      if (!entry || typeof entry !== 'object') {
        return '';
      }
      const name = String(entry.name || '').trim() || 'unknown';
      const kind = String(entry.kind || '').trim();
      const versionHint = String(entry.versionHint || '').trim();
      return [kind ? `[${kind}]` : '', name, versionHint ? `(${versionHint})` : ''].filter(Boolean).join(' ');
    }

    function getEnvironmentRunOutcomeSummary(run) {
      if (!run || !run.evaluation || typeof run.evaluation !== 'object' || !run.evaluation.environment || typeof run.evaluation.environment !== 'object') {
        return '';
      }
      const environment = run.evaluation.environment;
      const meta = getEnvironmentStatusMeta(environment.status || run.environmentStatus || '');
      if (!meta) {
        return '';
      }
      const reason = clipText(String(environment.reason || run.errorMessage || '').trim(), 96);
      return reason ? `${meta.label}：${reason}` : meta.label;
    }

    function formatEnvironmentConfigSummary(config, latestRun = null) {
      if (!isEnvironmentConfigEnabled(config)) {
        return '未配置环境链；默认直接运行 skill。';
      }
      const requirements = Array.isArray(config.requirements) ? config.requirements : [];
      const bootstrapCommands = Array.isArray(config.bootstrap && config.bootstrap.commands) ? config.bootstrap.commands : [];
      const verifyCommands = Array.isArray(config.verify && config.verify.commands) ? config.verify.commands : [];
      const docsTarget = config.docs && config.docs.target ? String(config.docs.target).trim() : 'TESTING.md';
      const cachePaths = Array.isArray(config.cache && config.cache.paths) ? config.cache.paths : [];
      const cacheEnabled = Boolean(config.cache && typeof config.cache === 'object' && config.cache.enabled === true);
      const parts = [
        '已启用环境链',
        requirements.length > 0 ? `${requirements.length} 项依赖` : '无显式依赖',
        bootstrapCommands.length > 0 ? `${bootstrapCommands.length} 条 bootstrap` : '无 bootstrap',
        verifyCommands.length > 0 ? `${verifyCommands.length} 条 verify` : '无 verify',
        cacheEnabled ? (cachePaths.length > 0 ? `${cachePaths.length} 条 cache 路径` : '未声明 cache 路径') : 'cache 未启用',
        `建议文档 ${docsTarget || 'TESTING.md'}`,
      ];
      const latestSummary = getEnvironmentRunOutcomeSummary(latestRun);
      return latestSummary ? `${parts.join('；')}。最近一次：${latestSummary}` : `${parts.join('；')}。`;
    }

    function getEnvironmentConfigSearchText(config) {
      if (!isEnvironmentConfigEnabled(config)) {
        return '';
      }
      const requirements = Array.isArray(config.requirements) ? config.requirements.map((entry) => formatEnvironmentRequirementLabel(entry)) : [];
      const bootstrapCommands = Array.isArray(config.bootstrap && config.bootstrap.commands) ? config.bootstrap.commands : [];
      const verifyCommands = Array.isArray(config.verify && config.verify.commands) ? config.verify.commands : [];
      const docsTarget = config.docs && config.docs.target ? String(config.docs.target).trim() : '';
      const cachePaths = Array.isArray(config.cache && config.cache.paths)
        ? config.cache.paths.map((entry) => `${entry && entry.root ? String(entry.root).trim() : ''}:${entry && entry.path ? String(entry.path).trim() : ''}`)
        : [];
      return ['environment', 'bootstrap', 'verify', 'cache', docsTarget, ...requirements, ...bootstrapCommands, ...verifyCommands, ...cachePaths].filter(Boolean).join(' ');
    }

    function buildEnvironmentRequirementListHtml(title, entries) {
      const normalized = Array.isArray(entries) ? entries.filter(Boolean) : [];
      if (normalized.length === 0) {
        return `<div class="agent-meta">${escapeHtml(title)}：无</div>`;
      }
      const items = normalized.map((entry) => {
        const label = formatEnvironmentRequirementLabel(entry);
        const reason = String(entry && entry.reason || '').trim();
        return `<li>${escapeHtml(label || 'unknown')}${reason ? `：${escapeHtml(reason)}` : ''}</li>`;
      }).join('');
      return `<div class="run-detail-subsection"><div class="agent-meta">${escapeHtml(title)}</div><ul class="run-detail-list">${items}</ul></div>`;
    }

    function buildEnvironmentCommandSectionHtml(title, payload) {
      const commands = Array.isArray(payload && payload.commands) ? payload.commands : [];
      const results = Array.isArray(payload && payload.results) ? payload.results : [];
      const attempted = Boolean(payload && payload.attempted);
      let html = '<div class="run-detail-subsection">';
      html += `<div class="agent-meta">${escapeHtml(title)}${attempted ? '' : '（未执行）'}</div>`;
      if (commands.length === 0) {
        html += '<div class="agent-meta">无命令</div>';
        html += '</div>';
        return html;
      }
      commands.forEach((command, index) => {
        const result = results[index] && typeof results[index] === 'object' ? results[index] : null;
        const exitCode = result && result.exitCode != null ? Number(result.exitCode) : null;
        const statusTag = exitCode == null
          ? '<span class="tag tag-pending">未执行</span>'
          : exitCode === 0
            ? '<span class="tag tag-success">成功</span>'
            : `<span class="tag tag-error">失败 (${escapeHtml(String(exitCode))})</span>`;
        html += '<div class="run-detail-card">';
        html += `<div class="run-detail-tag-row">${statusTag} <span class="tag">${escapeHtml(title)}</span></div>`;
        html += `<pre class="run-detail-pre">${escapeHtml(String(command || ''))}</pre>`;
        if (result && String(result.stdout || '').trim()) {
          html += `<div class="agent-meta">stdout</div><pre class="run-detail-pre">${escapeHtml(String(result.stdout || ''))}</pre>`;
        }
        if (result && String(result.stderr || '').trim()) {
          html += `<div class="agent-meta">stderr</div><pre class="run-detail-pre">${escapeHtml(String(result.stderr || ''))}</pre>`;
        }
        html += '</div>';
      });
      html += '</div>';
      return html;
    }

    function buildEnvironmentCacheDetailsHtml(payload) {
      if (!payload || typeof payload !== 'object') {
        return '';
      }
      const cacheStatusMeta = getEnvironmentCacheStatusMeta(payload.status);
      const cachePaths = Array.isArray(payload.paths) ? payload.paths.filter(Boolean) : [];
      const key = String(payload.key || '').trim();
      const reason = String(payload.reason || '').trim();
      const manifestPath = String(payload.manifestPath || '').trim();
      const summaryPath = String(payload.summaryPath || '').trim();
      const artifactBytes = Number.isFinite(payload.artifactBytes) ? Number(payload.artifactBytes) : null;
      const artifactSha256 = String(payload.artifactSha256 || '').trim();
      const restoredFiles = Number.isFinite(payload.restoredFiles) ? Number(payload.restoredFiles) : 0;
      const restoredDirectories = Number.isFinite(payload.restoredDirectories) ? Number(payload.restoredDirectories) : 0;
      const restoredSymlinks = Number.isFinite(payload.restoredSymlinks) ? Number(payload.restoredSymlinks) : 0;
      const ignoredEntries = Number.isFinite(payload.ignoredEntries) ? Number(payload.ignoredEntries) : 0;
      const createdAt = String(payload.createdAt || '').trim();
      const savedAt = String(payload.savedAt || '').trim();
      const expiresAt = String(payload.expiresAt || '').trim();
      const lastValidatedAt = String(payload.lastValidatedAt || '').trim();

      if (!cacheStatusMeta && !key && cachePaths.length === 0 && !reason && !manifestPath && !summaryPath) {
        return '';
      }

      let html = '<div class="run-detail-subsection">';
      html += '<div class="agent-meta">Environment Cache</div>';
      if (cacheStatusMeta) {
        html += `<div class="run-detail-tag-row"><span class="tag ${cacheStatusMeta.className}">${escapeHtml(cacheStatusMeta.label)}</span>`;
        if (artifactBytes != null) {
          html += ` <span class="tag">${escapeHtml(String(artifactBytes))} bytes</span>`;
        }
        html += '</div>';
      }
      if (reason) {
        html += `<div class="agent-meta">${escapeHtml(reason)}</div>`;
      }
      if (key) {
        html += `<div class="agent-meta">cacheKey：${escapeHtml(key)}</div>`;
      }
      if (manifestPath) {
        html += `<div class="agent-meta">manifest：${escapeHtml(manifestPath)}</div>`;
      }
      if (summaryPath) {
        html += `<div class="agent-meta">summary：${escapeHtml(summaryPath)}</div>`;
      }
      if (artifactSha256) {
        html += `<div class="agent-meta">sha256：${escapeHtml(artifactSha256)}</div>`;
      }
      if (createdAt) {
        html += `<div class="agent-meta">创建：${escapeHtml(createdAt)}</div>`;
      }
      if (savedAt) {
        html += `<div class="agent-meta">最近保存：${escapeHtml(savedAt)}</div>`;
      }
      if (lastValidatedAt) {
        html += `<div class="agent-meta">最近验证：${escapeHtml(lastValidatedAt)}</div>`;
      }
      if (expiresAt) {
        html += `<div class="agent-meta">过期时间：${escapeHtml(expiresAt)}</div>`;
      }
      if (cachePaths.length > 0) {
        html += `<div class="agent-meta">路径：${escapeHtml(cachePaths.map((entry) => `${entry.root || '?'}:${entry.path || '?'}`).join(', '))}</div>`;
      }
      if (restoredFiles || restoredDirectories || restoredSymlinks || ignoredEntries) {
        html += `<div class="agent-meta">恢复文件 ${escapeHtml(String(restoredFiles))}，目录 ${escapeHtml(String(restoredDirectories))}，软链 ${escapeHtml(String(restoredSymlinks))}，忽略 ${escapeHtml(String(ignoredEntries))}</div>`;
      }
      html += '</div>';
      return html;
    }

    function buildEnvironmentBuildDetailsHtml(buildResult) {
      if (!buildResult || typeof buildResult !== 'object') {
        return '';
      }
      const statusMeta = getEnvironmentBuildStatusMeta(buildResult.status);
      const asset = buildResult.asset && typeof buildResult.asset === 'object' ? buildResult.asset : {};
      const envProfile = String(buildResult.envProfile || buildResult.env_profile || asset.envProfile || asset.env_profile || '').trim();
      const image = String(buildResult.image || asset.image || '').trim();
      const suggestedImage = String(buildResult.suggestedImage || buildResult.suggested_image || '').trim();
      const imageDigest = String(buildResult.imageDigest || buildResult.image_digest || asset.imageDigest || asset.image_digest || '').trim();
      const manifestPath = String(buildResult.manifestPath || buildResult.manifest_path || asset.manifestPath || asset.manifest_path || '').trim();
      const manifestHash = String(buildResult.manifestHash || buildResult.manifest_hash || asset.manifestHash || asset.manifest_hash || '').trim();
      const baseImage = String(buildResult.baseImage || buildResult.base_image || '').trim();
      const baseImageDigest = String(buildResult.baseImageDigest || buildResult.base_image_digest || asset.baseImageDigest || asset.base_image_digest || '').trim();
      const testingMdHash = String(buildResult.testingMdHash || buildResult.testing_md_hash || asset.testingMdHash || asset.testing_md_hash || '').trim();
      const buildCommand = String(buildResult.buildCommand || buildResult.build_command || '').trim();
      const error = String(buildResult.error || '').trim();
      const logs = String(buildResult.logs || '').trim();
      const summary = getEnvironmentBuildResultSummary(buildResult);

      if (!statusMeta && !summary && !error && !manifestPath && !manifestHash && !image && !suggestedImage && !envProfile) {
        return '';
      }

      let html = '<div class="run-detail-section">';
      html += '<div class="section-label">环境资产构建</div>';
      if (statusMeta) {
        html += `<span class="tag ${statusMeta.className}">${escapeHtml(statusMeta.label)}</span>`;
      }
      if (envProfile) {
        html += ` <span class="tag">profile ${escapeHtml(envProfile)}</span>`;
      }
      if (summary) {
        html += `<div class="agent-meta">${escapeHtml(summary)}</div>`;
      }
      if (error) {
        html += `<div class="run-detail-diag">${escapeHtml(error)}</div>`;
      }
      if (manifestPath) {
        html += `<div class="agent-meta">manifest：${escapeHtml(manifestPath)}</div>`;
      }
      if (manifestHash) {
        html += `<div class="agent-meta">manifestHash：${escapeHtml(manifestHash)}</div>`;
      }
      if (image) {
        html += `<div class="agent-meta">image：${escapeHtml(image)}</div>`;
      } else if (suggestedImage) {
        html += `<div class="agent-meta">建议 image：${escapeHtml(suggestedImage)}</div>`;
      }
      if (imageDigest) {
        html += `<div class="agent-meta">imageDigest：${escapeHtml(imageDigest)}</div>`;
      }
      if (baseImage) {
        html += `<div class="agent-meta">baseImage：${escapeHtml(baseImage)}</div>`;
      }
      if (baseImageDigest) {
        html += `<div class="agent-meta">baseImageDigest：${escapeHtml(baseImageDigest)}</div>`;
      }
      if (testingMdHash) {
        html += `<div class="agent-meta">TESTING.md hash：${escapeHtml(testingMdHash)}</div>`;
      }
      if (buildCommand) {
        html += `<div class="agent-meta">build 命令</div><pre class="run-detail-pre">${escapeHtml(buildCommand)}</pre>`;
      }
      if (logs) {
        html += '<details class="run-detail-collapse">';
        html += '<summary class="agent-meta">查看 image build 日志</summary>';
        html += `<pre class="run-detail-pre">${escapeHtml(logs)}</pre>`;
        html += '</details>';
      }
      html += '</div>';
      return html;
    }

    return {
      getEnvironmentBuildRunOutcomeSummary,
      formatEnvironmentRequirementLabel,
      getEnvironmentRunOutcomeSummary,
      formatEnvironmentConfigSummary,
      getEnvironmentConfigSearchText,
      buildEnvironmentRequirementListHtml,
      buildEnvironmentCommandSectionHtml,
      buildEnvironmentCacheDetailsHtml,
      buildEnvironmentBuildDetailsHtml,
    };
  };
})();
