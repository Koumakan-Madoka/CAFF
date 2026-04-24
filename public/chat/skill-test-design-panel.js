// @ts-check

(function registerSkillTestDesignPanelModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  var SKILL_TEST_DESIGN_TYPE = 'skill_test_design';

  var PHASE_LABELS = {
    collecting_context: '收集上下文',
    planning_matrix: '形成测试矩阵',
    awaiting_confirmation: '等待确认',
    generating_drafts: '生成草稿',
    exported: '已导出',
  };

  var PRIORITY_LABELS = {
    P0: 'P0 必须有',
    P1: 'P1 应该有',
    P2: 'P2 可选',
  };

  function isSkillTestDesignConversation(conversation) {
    return Boolean(conversation && String(conversation.type || '').trim() === SKILL_TEST_DESIGN_TYPE);
  }

  function getDesignState(conversation) {
    var metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object'
      ? conversation.metadata
      : {};
    return metadata.skillTestDesign && typeof metadata.skillTestDesign === 'object'
      ? metadata.skillTestDesign
      : null;
  }

  function phaseLabel(phase) {
    return PHASE_LABELS[String(phase || '').trim()] || phase || '-';
  }

  function priorityLabel(priority) {
    return PRIORITY_LABELS[String(priority || '').trim()] || priority || '-';
  }

  function environmentSourceLabel(source) {
    var normalized = String(source || '').trim();
    if (normalized === 'skill_contract') return 'skill 契约';
    if (normalized === 'user_supplied') return '用户补充';
    if (normalized === 'missing') return '缺失';
    return normalized || '缺失';
  }

  function testingDocSourceKindLabel(sourceKind) {
    var normalized = String(sourceKind || '').trim();
    if (normalized === 'skill_md') return 'SKILL.md';
    if (normalized === 'stable_spec') return '稳定 spec';
    if (normalized === 'user_supplied') return '用户补充';
    if (normalized === 'missing') return '缺失';
    return normalized || '缺失';
  }

  function environmentContractStatusLabel(status) {
    var normalized = String(status || '').trim();
    if (normalized === 'available') return '已可引用';
    if (normalized === 'insufficient') return '内容不足';
    if (normalized === 'missing') return '缺失';
    return normalized || '未检测';
  }

  function hasChainMetadata(row) {
    return Boolean(
      String(row && row.scenarioKind || '').trim() === 'chain_step' ||
      String(row && row.chainId || '').trim() ||
      String(row && row.chainName || '').trim() ||
      row && row.sequenceIndex ||
      (Array.isArray(row && row.dependsOnRowIds) && row.dependsOnRowIds.length > 0) ||
      (Array.isArray(row && row.inheritance) && row.inheritance.length > 0)
    );
  }

  function chainLabel(row) {
    if (!hasChainMetadata(row)) return '-';
    var chainName = String(row && (row.chainName || row.chainId) || '').trim() || 'chain';
    var sequenceIndex = row && row.sequenceIndex ? String(row.sequenceIndex).trim() : '?';
    return chainName + ' #' + sequenceIndex;
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
  }

  function normalizeArtifactPath(value) {
    return String(value || '')
      .trim()
      .replace(/^`+|`+$/g, '')
      .replace(/^['"]+|['"]+$/g, '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
  }

  function buildSkillTestsUrl(skillId, caseId, matrixId) {
    var params = new URLSearchParams();
    params.set('tab', 'panel-skill-tests');
    if (skillId) params.set('skillId', String(skillId));
    if (caseId) params.set('caseId', String(caseId));
    if (matrixId) params.set('matrixId', String(matrixId));
    return '/eval-cases.html?' + params.toString();
  }

  function extractMatrixCandidateFromContent(content) {
    var matrix = null;
    var jsonBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)```/g;
    var match;
    while ((match = jsonBlockRegex.exec(content)) !== null) {
      try {
        var parsed = JSON.parse(match[1]);
        if (parsed && parsed.kind === 'skill_test_matrix') {
          matrix = parsed;
          break;
        }
      } catch (error) {
        void error;
      }
    }

    if (!matrix) {
      var jsonObjectRegex = /\{[\s\S]*"kind"\s*:\s*"skill_test_matrix"[\s\S]*\}/g;
      while ((match = jsonObjectRegex.exec(content)) !== null) {
        try {
          var parsedObject = JSON.parse(match[0]);
          if (parsedObject && parsedObject.kind === 'skill_test_matrix') {
            matrix = parsedObject;
            break;
          }
        } catch (error) {
          void error;
        }
      }
    }

    if (matrix) {
      return { matrix: matrix, matrixPath: '' };
    }

    var artifactMatch = String(content || '').match(/^\s*MATRIX_ARTIFACT\s*:\s*([^\r\n]+)\s*$/im);
    var matrixPath = normalizeArtifactPath(artifactMatch && artifactMatch[1]);
    if (matrixPath) {
      return { matrix: null, matrixPath: matrixPath };
    }

    return null;
  }

  function findLatestMatrixCandidate(conversation) {
    var messages = Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
    for (var index = messages.length - 1; index >= 0; index--) {
      var message = messages[index];
      if (!message || message.role !== 'assistant') {
        continue;
      }
      var candidate = extractMatrixCandidateFromContent(String(message.content || ''));
      if (candidate && (candidate.matrix || candidate.matrixPath)) {
        return {
          messageId: String(message.id || '').trim(),
          matrix: candidate.matrix,
          matrixPath: candidate.matrixPath,
        };
      }
    }
    return null;
  }

  function candidateKey(conversationId, candidate) {
    var normalizedConversationId = String(conversationId || '').trim();
    var messageId = candidate && candidate.messageId ? String(candidate.messageId).trim() : '';
    if (!normalizedConversationId || !messageId) {
      return '';
    }
    return normalizedConversationId + ':' + messageId;
  }

  function findLatestConversationMessageId(conversation) {
    var messages = Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
    for (var index = messages.length - 1; index >= 0; index--) {
      var message = messages[index];
      if (message && message.id && (message.role === 'user' || message.role === 'assistant')) {
        return String(message.id || '').trim();
      }
    }
    return '';
  }

  chat.createSkillTestDesignPanelRenderer = function createSkillTestDesignPanelRenderer({ state }) {
    var shared = window.CaffShared || {};
    var toastEl = /** @type {HTMLElement | null} */ (document.getElementById('toast'));
    var toast = typeof shared.createToastController === 'function' ? shared.createToastController(toastEl) : { show: function () {} };
    var card = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-card'));
    var statusEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-status'));
    var skillNameEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-skill-name'));
    var phaseEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-phase'));
    var caseSummaryEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-case-summary'));
    var matrixSection = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-matrix-section'));
    var matrixStatusEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-matrix-status'));
    var matrixRowsEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-matrix-rows'));
    var testingDocSection = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-testing-doc-section'));
    var testingDocStatusEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-testing-doc-status'));
    var testingDocDraftEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-testing-doc-draft'));
    var testingDocActionsEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-testing-doc-actions'));
    var previewTestingDocButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('skill-test-preview-testing-doc-button'));
    var applyTestingDocButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('skill-test-apply-testing-doc-button'));
    var actionsEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-actions'));
    var importButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('skill-test-import-matrix-button'));
    var confirmButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('skill-test-confirm-matrix-button'));
    var exportButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('skill-test-export-drafts-button'));
    var exportResultEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-export-result'));
    var exportSummaryEl = /** @type {HTMLElement | null} */ (document.getElementById('skill-test-design-export-summary'));

    var summaryFetchTimer = null;
    var autoImportInFlightKey = '';
    var autoImportFailedKey = '';
    var primaryActionInFlight = false;
    var testingDocActionInFlight = false;
    var lastDesignSummary = null;

    function syncConversationState(nextConversation) {
      if (!nextConversation || !nextConversation.id) {
        return;
      }
      state.currentConversation = nextConversation;
      var index = state.conversations.findIndex(function (item) {
        return item && item.id === nextConversation.id;
      });
      if (index >= 0) {
        state.conversations[index] = nextConversation;
      }
    }

    function showToast(message) {
      toast.show(message);
    }

    function fetchSkillTestDesignSummary(conversationId) {
      if (summaryFetchTimer) {
        clearTimeout(summaryFetchTimer);
      }
      summaryFetchTimer = setTimeout(function () {
        summaryFetchTimer = null;
        fetch('/api/conversations/' + encodeURIComponent(conversationId) + '/skill-test-design', {
          credentials: 'include',
        })
          .then(function (res) {
            if (!res.ok) throw new Error('Failed to fetch design summary');
            return res.json();
          })
          .then(function (data) {
            if (!data || !data.state) return;
            if (data.conversation) {
              syncConversationState(data.conversation);
            }
            lastDesignSummary = data.state;
            var summary = data.state.existingCaseSummary || {};
            if (caseSummaryEl) {
              caseSummaryEl.textContent =
                '总计 ' + (summary.totalCases || 0) +
                ' / 草稿 ' + (summary.draftCases || 0) +
                ' / 就绪 ' + (summary.readyCases || 0) +
                ' / 归档 ' + (summary.archivedCases || 0);
            }
            renderTestingDocSection(getDesignState(state.currentConversation) || {}, lastDesignSummary);
          })
          .catch(function () {
            // Ignore summary fetch errors.
          });
      }, 300);
    }

    function postDesignAction(conversationId, action, body) {
      return fetch('/api/conversations/' + encodeURIComponent(conversationId) + '/skill-test-design/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body || {}),
      })
        .then(function (res) {
          if (!res.ok) {
            return res.json().then(function (err) {
              throw new Error(err && (err.error || err.message) || '请求失败');
            });
          }
          return res.json();
        });
    }

    function renderMatrixRows(rows) {
      if (!matrixRowsEl) return;
      matrixRowsEl.innerHTML = '';

      if (!Array.isArray(rows) || rows.length === 0) {
        matrixRowsEl.innerHTML = '<p class="muted">矩阵为空</p>';
        return;
      }

      var table = document.createElement('table');
      table.className = 'skill-test-matrix-table';

      var thead = document.createElement('thead');
      thead.innerHTML = '<tr>' +
        '<th>场景</th>' +
        '<th>优先级</th>' +
        '<th>类型</th>' +
        '<th>模式</th>' +
        '<th>环境</th>' +
        '<th>链</th>' +
        '<th>导出</th>' +
        '</tr>';
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      var hasChainRows = false;
      var missingEnvironmentRows = 0;
      for (var index = 0; index < rows.length; index++) {
        var row = rows[index] || {};
        var environmentSource = String(row.environmentSource || '').trim() || (row.environmentContractRef ? 'skill_contract' : 'missing');
        var environmentLabel = environmentSourceLabel(environmentSource);
        var environmentTitle = environmentLabel + (row.environmentContractRef ? ' · ' + row.environmentContractRef : '');
        var chainText = chainLabel(row);
        if (chainText !== '-') hasChainRows = true;
        if (environmentSource === 'missing') missingEnvironmentRows += 1;
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td title="' + escapeHtml(row.scenario || '') + '">' + escapeHtml((row.scenario || '').substring(0, 60)) + '</td>' +
          '<td>' + escapeHtml(priorityLabel(row.priority)) + '</td>' +
          '<td>' + escapeHtml(row.testType || '-') + '</td>' +
          '<td>' + escapeHtml(row.loadingMode || '-') + '</td>' +
          '<td title="' + escapeHtml(environmentTitle) + '">' + escapeHtml(environmentLabel) + '</td>' +
          '<td title="' + escapeHtml(chainText) + '">' + escapeHtml(chainText) + '</td>' +
          '<td>' + (row.includeInMvp !== false ? '✓' : '✗') + '</td>';
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      matrixRowsEl.appendChild(table);

      if (hasChainRows) {
        var chainNote = document.createElement('p');
        chainNote.className = 'muted';
        chainNote.textContent = '链式分组仅用于规划 / 导出 metadata；Phase 1 运行仍按独立 case 执行，不会自动共享环境或产物。';
        matrixRowsEl.appendChild(chainNote);
      }

      if (missingEnvironmentRows > 0) {
        var environmentNote = document.createElement('p');
        environmentNote.className = 'muted';
        environmentNote.textContent = missingEnvironmentRows + ' 行环境契约缺失；trigger-only 可继续保留缺口 metadata，execution / 真实环境依赖会在确认或导出时被拦截。';
        matrixRowsEl.appendChild(environmentNote);
      }
    }

    function handleImportMatrix(options) {
      var conversation = state.currentConversation;
      var silent = Boolean(options && options.silent);
      var candidate = options && options.candidate ? options.candidate : findLatestMatrixCandidate(conversation);
      var key = options && options.key ? options.key : candidateKey(conversation && conversation.id, candidate);

      if (!isSkillTestDesignConversation(conversation)) {
        return Promise.resolve(null);
      }
      if (!candidate || (!candidate.matrix && !candidate.matrixPath)) {
        if (!silent) {
          showToast('没有找到可同步的测试矩阵');
        }
        return Promise.resolve(null);
      }

      if (key) {
        autoImportInFlightKey = key;
      }

      return postDesignAction(conversation.id, 'import-matrix', {
        messageId: candidate.messageId,
        matrix: candidate.matrix || undefined,
        matrixPath: candidate.matrixPath || undefined,
      })
        .then(function (data) {
          autoImportInFlightKey = '';
          autoImportFailedKey = '';
          if (data && data.conversation) {
            syncConversationState(data.conversation);
          }
          render();
          if (!silent) {
            showToast('已同步最新测试矩阵');
          }
          return data;
        })
        .catch(function (error) {
          autoImportInFlightKey = '';
          autoImportFailedKey = key || '';
          render();
          showToast(error && error.message ? error.message : '同步测试矩阵失败');
          throw error;
        });
    }

    function handlePrimaryAction() {
      var conversation = state.currentConversation;
      if (!isSkillTestDesignConversation(conversation)) return;

      var designState = getDesignState(conversation) || {};
      var matrix = designState.matrix && typeof designState.matrix === 'object' ? designState.matrix : null;
      var confirmation = designState.confirmation && typeof designState.confirmation === 'object' ? designState.confirmation : null;
      var matrixId = matrix && matrix.matrixId ? String(matrix.matrixId).trim() : '';
      var isConfirmed = Boolean(
        matrixId && confirmation && String(confirmation.matrixId || '').trim() === matrixId
      );

      if (!matrixId) {
        showToast('还没有可导出的测试矩阵');
        return;
      }

      primaryActionInFlight = true;
      render();

      postDesignAction(conversation.id, 'export-drafts', {
        matrixId: matrixId,
        confirmMatrix: !isConfirmed,
        confirmationMessageId: String(matrix.sourceMessageId || '').trim(),
        exportedBy: 'user',
      })
        .then(function (data) {
          if (data && data.conversation) {
            syncConversationState(data.conversation);
          }
          if (data && data.state) {
            lastDesignSummary = data.state;
          }
          render();
          var message = '已导出 ' + (data && data.exportedCount || 0) + ' 条测试草稿';
          if (data && Array.isArray(data.duplicateWarnings) && data.duplicateWarnings.length > 0) {
            message += '（' + data.duplicateWarnings.length + ' 条可能与现有用例重复）';
          }
          if (data && Array.isArray(data.skippedRows) && data.skippedRows.length > 0) {
            message += '，另有 ' + data.skippedRows.length + ' 行因当前 Phase 1 限制被跳过（仍保留在矩阵中，后续 Phase 可重新导出）';
          }
          showToast(message);
        })
        .catch(function (error) {
          showToast(error && error.message ? error.message : '导出失败');
        })
        .finally(function () {
          primaryActionInFlight = false;
          render();
        });
    }

    function renderTestingDocSection(designState, designSummary) {
      if (!testingDocSection || !testingDocStatusEl || !testingDocDraftEl || !testingDocActionsEl) {
        return;
      }

      var environmentContract = designSummary && designSummary.environmentContract && typeof designSummary.environmentContract === 'object'
        ? designSummary.environmentContract
        : designState && designState.environmentContract && typeof designState.environmentContract === 'object'
          ? designState.environmentContract
          : null;
      var draft = designSummary && designSummary.testingDocDraft && typeof designSummary.testingDocDraft === 'object'
        ? designSummary.testingDocDraft
        : designState && designState.testingDocDraft && typeof designState.testingDocDraft === 'object'
          ? designState.testingDocDraft
          : null;
      var matrix = designState && designState.matrix && typeof designState.matrix === 'object' ? designState.matrix : null;
      var rows = Array.isArray(matrix && matrix.rows) ? matrix.rows : [];
      var blockedRows = rows.filter(function (row) {
        var source = String(row && row.environmentSource || '').trim() || (row && row.environmentContractRef ? 'skill_contract' : 'missing');
        return source === 'missing' && (String(row && row.testType || '').trim() === 'execution');
      });
      var shouldShowSection = Boolean(environmentContract || draft || blockedRows.length > 0 || rows.length > 0);
      testingDocSection.classList.toggle('hidden', !shouldShowSection);
      if (!shouldShowSection) {
        return;
      }

      var statusText = environmentContract
        ? environmentContractStatusLabel(environmentContract.status)
        : '未检测';
      if (environmentContract && Array.isArray(environmentContract.candidates) && environmentContract.candidates.length > 0) {
        statusText += ' · ' + environmentContract.candidates.map(function (entry) {
          return String(entry && entry.environmentContractRef || '').trim();
        }).filter(Boolean).join(' / ');
      }
      if (blockedRows.length > 0) {
        statusText += ' · ' + blockedRows.length + ' 个 execution 行仍缺环境契约';
      }
      testingDocStatusEl.textContent = statusText;

      var html = '';
      if (environmentContract && Array.isArray(environmentContract.warnings) && environmentContract.warnings.length > 0) {
        html += '<p class="muted">' + escapeHtml(environmentContract.warnings.join('；')) + '</p>';
      }
      if (draft) {
        html += '<div class="muted">当前草稿：' + escapeHtml(String(draft.status || 'proposed')) + '</div>';
        if (draft.file && draft.file.existsAtPreview) {
          html += '<p class="muted">将覆盖现有 `TESTING.md`；确认写入前请再次检查完整预览。</p>';
        }
        if (draft.readiness && Array.isArray(draft.readiness.warnings) && draft.readiness.warnings.length > 0) {
          html += '<p class="muted">' + escapeHtml(draft.readiness.warnings.join('；')) + '</p>';
        }
        if (Array.isArray(draft.sections) && draft.sections.length > 0) {
          html += '<table class="skill-test-matrix-table"><thead><tr><th>段落</th><th>来源</th><th>状态</th></tr></thead><tbody>';
          draft.sections.forEach(function (section) {
            var heading = String(section && section.heading || '-').trim() || '-';
            var sourceKind = testingDocSourceKindLabel(section && section.sourceKind);
            var hasOpenQuestions = Array.isArray(section && section.openQuestions) && section.openQuestions.length > 0;
            html += '<tr>' +
              '<td title="' + escapeHtml(String(section && section.content || '')) + '">' + escapeHtml(heading) + '</td>' +
              '<td>' + escapeHtml(sourceKind) + '</td>' +
              '<td>' + (hasOpenQuestions ? '待确认' : '已整理') + '</td>' +
              '</tr>';
          });
          html += '</tbody></table>';
        }
      } else if (environmentContract && environmentContract.status !== 'available') {
        html += '<p class="muted">当前缺少可复用的 `TESTING.md` 契约；缺少 `TESTING.md` 时系统会自动准备预览草稿。在写入并重新确认矩阵前，execution 仍会保持 fail-closed。</p>';
      } else {
        html += '<p class="muted">当前 `TESTING.md` 契约已可引用；如果环境变化，再重新起草并确认覆盖。</p>';
      }
      testingDocDraftEl.innerHTML = html;

      var canPreview = !testingDocActionInFlight;
      var canApply = !testingDocActionInFlight && draft && draft.draftId && ['proposed', 'needs_user_input', 'confirmed'].indexOf(String(draft.status || '')) !== -1;
      testingDocActionsEl.classList.toggle('hidden', !canPreview && !canApply);
      if (previewTestingDocButton) {
        previewTestingDocButton.classList.toggle('hidden', !canPreview);
        previewTestingDocButton.disabled = testingDocActionInFlight;
        previewTestingDocButton.textContent = testingDocActionInFlight ? '处理中...' : (draft ? '重新起草 TESTING.md' : '起草 TESTING.md');
      }
      if (applyTestingDocButton) {
        applyTestingDocButton.classList.toggle('hidden', !canApply);
        applyTestingDocButton.disabled = testingDocActionInFlight;
        applyTestingDocButton.textContent = testingDocActionInFlight ? '处理中...' : '确认写入 TESTING.md';
      }
    }

    function handlePreviewTestingDoc() {
      var conversation = state.currentConversation;
      if (!isSkillTestDesignConversation(conversation)) return;
      var messageId = findLatestConversationMessageId(conversation);
      if (!messageId) {
        showToast('先在聊天里补充环境信息，再起草 TESTING.md');
        return;
      }
      testingDocActionInFlight = true;
      render();
      postDesignAction(conversation.id, 'preview-testing-doc-draft', {
        messageId: messageId,
        requestedBy: 'user',
      })
        .then(function (data) {
          if (data && data.conversation) {
            syncConversationState(data.conversation);
          }
          if (data && data.state) {
            lastDesignSummary = data.state;
          }
          showToast('已生成 TESTING.md 草稿预览');
          render();
        })
        .catch(function (error) {
          showToast(error && error.message ? error.message : '起草 TESTING.md 失败');
        })
        .finally(function () {
          testingDocActionInFlight = false;
          render();
        });
    }

    function handleApplyTestingDoc() {
      var conversation = state.currentConversation;
      if (!isSkillTestDesignConversation(conversation)) return;
      var designState = getDesignState(conversation) || {};
      var designSummary = lastDesignSummary && lastDesignSummary.conversationId === conversation.id ? lastDesignSummary : null;
      var draft = designSummary && designSummary.testingDocDraft ? designSummary.testingDocDraft : designState.testingDocDraft;
      if (!draft || !draft.draftId) {
        showToast('当前没有可写入的 TESTING.md 草稿');
        return;
      }
      var confirmOverwrite = Boolean(draft.file && draft.file.existsAtPreview);
      if (confirmOverwrite && window.confirm && !window.confirm('目标 skill 已存在 TESTING.md。当前预览内容会覆盖现有文件，确认继续吗？')) {
        return;
      }
      testingDocActionInFlight = true;
      render();
      postDesignAction(conversation.id, 'apply-testing-doc-draft', {
        draftId: String(draft.draftId || '').trim(),
        confirmOverwrite: confirmOverwrite,
        appliedBy: 'user',
      })
        .then(function (data) {
          if (data && data.conversation) {
            syncConversationState(data.conversation);
          }
          if (data && data.state) {
            lastDesignSummary = data.state;
          }
          showToast(data && data.requiresMatrixReconfirmation
            ? '已写入 TESTING.md，请重新生成或重新确认受影响矩阵行'
            : '已写入 TESTING.md');
          render();
        })
        .catch(function (error) {
          showToast(error && error.message ? error.message : '写入 TESTING.md 失败');
        })
        .finally(function () {
          testingDocActionInFlight = false;
          render();
        });
    }

    function render() {
      if (!card) {
        return;
      }

      var conversation = state.currentConversation;
      var isDesignRoom = isSkillTestDesignConversation(conversation);
      card.classList.toggle('hidden', !isDesignRoom);

      if (!isDesignRoom || !conversation) {
        return;
      }

      var designState = getDesignState(conversation) || {};
      var designSummary = lastDesignSummary && lastDesignSummary.conversationId === conversation.id ? lastDesignSummary : null;
      var skillName = String(designState.skillName || designState.skillId || '-').trim();
      var phase = String(designState.phase || 'collecting_context').trim();
      var matrix = designState.matrix && typeof designState.matrix === 'object' ? designState.matrix : null;
      var confirmation = designState.confirmation && typeof designState.confirmation === 'object' ? designState.confirmation : null;
      var exportInfo = designState.export && typeof designState.export === 'object' ? designState.export : null;
      var importedMessageId = matrix && matrix.sourceMessageId ? String(matrix.sourceMessageId || '').trim() : '';
      var latestCandidate = findLatestMatrixCandidate(conversation);
      var latestCandidateKey = candidateKey(conversation.id, latestCandidate);
      var hasFreshCandidate = Boolean(
        latestCandidateKey && latestCandidate && latestCandidate.messageId && latestCandidate.messageId !== importedMessageId
      );
      var autoImportPending = Boolean(latestCandidateKey && latestCandidateKey === autoImportInFlightKey);
      var autoImportFailed = Boolean(latestCandidateKey && latestCandidateKey === autoImportFailedKey);

      if (hasFreshCandidate && !autoImportPending && !autoImportFailed) {
        autoImportInFlightKey = latestCandidateKey;
        autoImportPending = true;
        setTimeout(function () {
          handleImportMatrix({
            candidate: latestCandidate,
            silent: true,
            key: latestCandidateKey,
          }).catch(function () {
            // Failure toast already shown in handleImportMatrix.
          });
        }, 0);
      }

      skillNameEl.textContent = skillName;
      phaseEl.textContent = phaseLabel(phase);
      fetchSkillTestDesignSummary(conversation.id);

      var displayMatrix = matrix && matrix.matrixId
        ? matrix
        : latestCandidate && latestCandidate.matrix
          ? latestCandidate.matrix
          : null;

      renderTestingDocSection(designState, designSummary);

      if (displayMatrix && displayMatrix.rows) {
        matrixSection.classList.remove('hidden');
        renderMatrixRows(displayMatrix.rows || []);
      } else {
        matrixSection.classList.add('hidden');
      }

      var isConfirmed = Boolean(
        matrix && matrix.matrixId && confirmation && String(confirmation.matrixId || '').trim() === String(matrix.matrixId || '').trim()
      );
      var alreadyExported = Boolean(
        matrix && matrix.matrixId && exportInfo && String(exportInfo.matrixId || '').trim() === String(matrix.matrixId || '').trim() && phase === 'exported'
      );
      var matrixStatus = '未导入';
      var hasCandidatePointer = Boolean(latestCandidate && (latestCandidate.matrix || latestCandidate.matrixPath));

      if (matrix && matrix.matrixId) {
        matrixStatus = isConfirmed
          ? '已确认 (matrixId: ' + matrix.matrixId + ')'
          : '已同步，待确认 (matrixId: ' + matrix.matrixId + ')';
      } else if (displayMatrix || hasCandidatePointer) {
        matrixStatus = autoImportFailed ? '检测到矩阵，但自动同步失败，可重试' : '检测到矩阵，正在自动同步';
      }

      if (matrix && matrix.matrixId && hasFreshCandidate) {
        if (autoImportPending) {
          matrixStatus += '；正在同步最新矩阵';
        } else if (autoImportFailed) {
          matrixStatus += '；最新矩阵同步失败，可重试';
        }
      }

      if (matrixStatusEl) {
        matrixStatusEl.textContent = matrixStatus;
      }
      if (statusEl) {
        statusEl.textContent = autoImportPending
          ? '检测到新的测试矩阵，正在自动同步。同步完成后可直接一键确认并导出。'
          : 'Skill Test 默认运行在隔离沙盒里；这里只需要确认目标 skill 的额外依赖与 TESTING.md 契约。缺少 TESTING.md 时会自动生成预览草稿；检测到有效测试矩阵后会自动同步。';
      }

      var canRetryImport = Boolean(latestCandidateKey && autoImportFailed);
      var canPrimaryAction = Boolean(matrix && matrix.matrixId && !alreadyExported && !autoImportPending);

      actionsEl.classList.toggle('hidden', !canRetryImport && !canPrimaryAction);

      if (importButton) {
        importButton.textContent = autoImportPending ? '同步中...' : '重试同步矩阵';
        importButton.disabled = autoImportPending;
        importButton.classList.toggle('hidden', !canRetryImport);
      }

      if (confirmButton) {
        confirmButton.classList.add('hidden');
      }

      if (exportButton) {
        exportButton.textContent = isConfirmed ? '导出草稿' : '确认并导出草稿';
        exportButton.disabled = primaryActionInFlight || autoImportPending;
        exportButton.classList.toggle('hidden', !canPrimaryAction);
      }

      if (exportInfo && exportInfo.exportedCaseIds) {
        var exportedCaseIds = Array.isArray(exportInfo.exportedCaseIds) ? exportInfo.exportedCaseIds : [];
        var exportedCount = Number(exportInfo.exportedCount || exportedCaseIds.length || 0);
        var duplicateWarningCount = Number(exportInfo.duplicateWarningCount || 0);
        var skippedRowCount = Number(exportInfo.skippedRowCount || (Array.isArray(exportInfo.skippedRows) ? exportInfo.skippedRows.length : 0) || 0);
        var summaryText = '已导出 ' + exportedCount + ' 条草稿';
        if (duplicateWarningCount > 0) summaryText += '，' + duplicateWarningCount + ' 条可能重复';
        if (skippedRowCount > 0) summaryText += '，' + skippedRowCount + ' 行因当前 Phase 1 限制跳过（仍保留在矩阵中，后续 Phase 可重新导出）';
        exportResultEl.classList.remove('hidden');
        exportSummaryEl.textContent = summaryText + '。';
        if (exportedCaseIds.length > 0) {
          var link = document.createElement('a');
          link.href = buildSkillTestsUrl(designState.skillId, exportedCaseIds[0], matrix && matrix.matrixId);
          link.textContent = '打开 Skill Tests 查看草稿';
          link.target = '_blank';
          link.rel = 'noopener';
          exportSummaryEl.appendChild(document.createTextNode(' '));
          exportSummaryEl.appendChild(link);
        }
      } else {
        exportResultEl.classList.add('hidden');
      }
    }

    if (importButton) {
      importButton.addEventListener('click', function () {
        handleImportMatrix({ silent: false }).catch(function () {
          // Failure toast already handled.
        });
      });
    }

    if (previewTestingDocButton) {
      previewTestingDocButton.addEventListener('click', handlePreviewTestingDoc);
    }

    if (applyTestingDocButton) {
      applyTestingDocButton.addEventListener('click', handleApplyTestingDoc);
    }

    if (confirmButton) {
      confirmButton.addEventListener('click', handlePrimaryAction);
    }

    if (exportButton) {
      exportButton.addEventListener('click', handlePrimaryAction);
    }

    return {
      render: render,
    };
  };

  chat.isSkillTestDesignConversation = isSkillTestDesignConversation;
})();
