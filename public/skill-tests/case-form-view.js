// @ts-check

(function registerSkillTestCaseFormView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});

  skillTests.createCaseFormViewHelpers = function createCaseFormViewHelpers(deps = {}) {
    const fetchJson = typeof deps.fetchJson === 'function'
      ? deps.fetchJson
      : async () => {
        throw new Error('Missing fetchJson');
      };
    const showToast = typeof deps.showToast === 'function'
      ? deps.showToast
      : () => {};
    const renderIssuePanel = typeof deps.renderIssuePanel === 'function'
      ? deps.renderIssuePanel
      : () => {};
    const extractIssuesFromError = typeof deps.extractIssuesFromError === 'function'
      ? deps.extractIssuesFromError
      : () => [];
    const buildIssueToastMessage = typeof deps.buildIssueToastMessage === 'function'
      ? deps.buildIssueToastMessage
      : () => '';
    const getSelectedSkillId = typeof deps.getSelectedSkillId === 'function'
      ? deps.getSelectedSkillId
      : () => '';
    const getSelectedCaseId = typeof deps.getSelectedCaseId === 'function'
      ? deps.getSelectedCaseId
      : () => '';
    const getActiveDetailTab = typeof deps.getActiveDetailTab === 'function'
      ? deps.getActiveDetailTab
      : () => 'overview';
    const findSelectedCase = typeof deps.findSelectedCase === 'function'
      ? deps.findSelectedCase
      : () => null;
    const getCasePrompt = typeof deps.getCasePrompt === 'function'
      ? deps.getCasePrompt
      : () => '';
    const parseStructuredArray = typeof deps.parseStructuredArray === 'function'
      ? deps.parseStructuredArray
      : () => [];
    const parseStructuredExpectedTools = typeof deps.parseStructuredExpectedTools === 'function'
      ? deps.parseStructuredExpectedTools
      : () => [];
    const parseStructuredObject = typeof deps.parseStructuredObject === 'function'
      ? deps.parseStructuredObject
      : () => ({});
    const mergeIssues = typeof deps.mergeIssues === 'function'
      ? deps.mergeIssues
      : (...issueLists) => issueLists.flat().filter(Boolean);
    const buildLocalValidationIssue = typeof deps.buildLocalValidationIssue === 'function'
      ? deps.buildLocalValidationIssue
      : (code, path, message, severity = 'error') => ({ code, path, message, severity });
    const buildLocalValidationError = typeof deps.buildLocalValidationError === 'function'
      ? deps.buildLocalValidationError
      : (message, issues) => ({ message, issues });
    const normalizeIssueList = typeof deps.normalizeIssueList === 'function'
      ? deps.normalizeIssueList
      : (issues) => Array.isArray(issues) ? issues : [];
    const buildIssueSummary = typeof deps.buildIssueSummary === 'function'
      ? deps.buildIssueSummary
      : (issues) => `${normalizeIssueList(issues).length} 条`;
    const shouldIncludeExpectedSteps = typeof deps.shouldIncludeExpectedSteps === 'function'
      ? deps.shouldIncludeExpectedSteps
      : () => false;
    const loadTestCases = typeof deps.loadTestCases === 'function'
      ? deps.loadTestCases
      : async () => {};
    const loadSummary = typeof deps.loadSummary === 'function'
      ? deps.loadSummary
      : async () => {};
    const selectCase = typeof deps.selectCase === 'function'
      ? deps.selectCase
      : () => {};

    function buildCaseUpdateBody(dom, selectedCase) {
      const expectedStepsText = dom.detailStepsJson ? dom.detailStepsJson.value.trim() : '';
      const expectedSteps = parseStructuredArray(expectedStepsText);

      const expectedToolsText = dom.detailToolsJson ? dom.detailToolsJson.value.trim() : '';
      const expectedTools = parseStructuredExpectedTools(expectedToolsText);

      const expectedSequenceText = dom.detailSequenceJson ? dom.detailSequenceJson.value.trim() : '';
      const expectedSequence = parseStructuredArray(expectedSequenceText);

      const evaluationRubricText = dom.detailRubricJson ? dom.detailRubricJson.value.trim() : '';
      const evaluationRubric = parseStructuredObject(evaluationRubricText);

      const environmentConfigText = dom.detailEnvironmentJson ? dom.detailEnvironmentJson.value.trim() : '';
      const environmentConfig = parseStructuredObject(environmentConfigText);

      const localIssues = mergeIssues(
        expectedStepsText && !expectedSteps
          ? [buildLocalValidationIssue('expected_steps_required', 'expectedSteps', 'Expected Steps JSON 需要是数组')]
          : [],
        expectedToolsText && !expectedTools
          ? [buildLocalValidationIssue('expected_tools_invalid', 'expectedTools', 'Expected Tools JSON 需要是数组')]
          : [],
        expectedSequenceText && !expectedSequence
          ? [buildLocalValidationIssue('expected_sequence_invalid', 'expectedSequence', '关键顺序 JSON 需要是数组')]
          : [],
        evaluationRubricText && !evaluationRubric
          ? [buildLocalValidationIssue('evaluation_rubric_invalid', 'evaluationRubric', '评估 Rubric JSON 需要是对象')]
          : [],
        environmentConfigText && !environmentConfig
          ? [buildLocalValidationIssue('environment_config_invalid', 'environmentConfig', 'Environment Config JSON 需要是对象')]
          : []
      );

      if (localIssues.length > 0) {
        throw buildLocalValidationError('保存前校验失败', localIssues);
      }

      const prompt = dom.detailPrompt ? dom.detailPrompt.value.trim() : getCasePrompt(selectedCase);
      const body = {
        userPrompt: prompt,
        triggerPrompt: prompt,
        expectedGoal: dom.detailGoal ? dom.detailGoal.value.trim() : selectedCase.expectedGoal,
        expectedBehavior: dom.detailBehavior ? dom.detailBehavior.value.trim() : selectedCase.expectedBehavior,
        expectedTools: expectedTools || [],
        expectedSequence: expectedSequence || [],
        evaluationRubric: evaluationRubric || {},
        environmentConfig: environmentConfig || {},
        note: dom.detailNote ? dom.detailNote.value.trim() : selectedCase.note,
        loadingMode: selectedCase.loadingMode,
        caseStatus: selectedCase.caseStatus,
      };
      if (shouldIncludeExpectedSteps(selectedCase.loadingMode, expectedSteps)) {
        body.expectedSteps = expectedSteps || [];
      }
      return body;
    }

    async function saveCurrentCase(dom) {
      const skillId = getSelectedSkillId();
      const caseId = getSelectedCaseId();
      const selectedCase = findSelectedCase();
      if (!skillId || !caseId || !selectedCase) {
        return [];
      }

      const body = buildCaseUpdateBody(dom, selectedCase);
      const result = await fetchJson(
        `/api/skills/${encodeURIComponent(skillId)}/test-cases/${encodeURIComponent(caseId)}`,
        { method: 'PATCH', body }
      );
      const saveIssues = normalizeIssueList(result && result.issues);
      const saveMessage = saveIssues.length > 0
        ? `草稿已保存（${buildIssueSummary(saveIssues)}）`
        : '草稿已保存';
      showToast(saveMessage);
      await Promise.all([loadTestCases(), loadSummary()]);
      selectCase(caseId, { detailTab: 'details' });
      renderIssuePanel(dom.detailIssues, saveIssues, '保存返回校验提示');
      return saveIssues;
    }

    async function toggleCaseStatus(testCase) {
      const skillId = getSelectedSkillId();
      if (!skillId || !testCase || !testCase.id) {
        return;
      }
      const action = testCase.caseStatus === 'ready' ? 'mark-draft' : 'mark-ready';
      const nextLabel = action === 'mark-ready' ? 'Ready' : 'Draft';
      await fetchJson(
        `/api/skills/${encodeURIComponent(skillId)}/test-cases/${encodeURIComponent(testCase.id)}/${action}`,
        { method: 'POST' }
      );
      showToast(`已切换为 ${nextLabel}`);
      await Promise.all([loadTestCases(), loadSummary()]);
      selectCase(testCase.id, { detailTab: getActiveDetailTab() });
    }

    function bindDetailFormActions(dom) {
      if (dom.detailSaveButton) {
        dom.detailSaveButton.addEventListener('click', async () => {
          try {
            dom.detailSaveButton.disabled = true;
            await saveCurrentCase(dom);
          } catch (err) {
            const issues = extractIssuesFromError(err);
            renderIssuePanel(dom.detailIssues, issues, '保存失败校验提示');
            const issueMessage = buildIssueToastMessage('保存失败，', issues);
            showToast(issueMessage || ('保存失败: ' + (err.message || err)));
          } finally {
            dom.detailSaveButton.disabled = false;
          }
        });
      }

      if (dom.detailToggleStatusButton) {
        dom.detailToggleStatusButton.addEventListener('click', async () => {
          const selectedCase = findSelectedCase();
          if (!selectedCase) {
            return;
          }
          try {
            dom.detailToggleStatusButton.disabled = true;
            await toggleCaseStatus(selectedCase);
          } catch (err) {
            const issues = extractIssuesFromError(err);
            renderIssuePanel(dom.detailIssues, issues, '切换状态失败校验提示');
            const issueMessage = buildIssueToastMessage('切换状态失败，', issues);
            showToast(issueMessage || ('切换状态失败: ' + (err.message || err)));
          } finally {
            dom.detailToggleStatusButton.disabled = false;
          }
        });
      }
    }

    return {
      bindDetailFormActions,
      saveCurrentCase,
      toggleCaseStatus,
    };
  };
})();
