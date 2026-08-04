// @ts-check

(function registerManagementListPrimitives() {
  const shared = window.CaffShared || (window.CaffShared = {});

  /**
   * @param {{ id: string; active?: boolean; compact?: boolean }} options
   */
  shared.createManagementListItem = function createManagementListItem(options) {
    const row = document.createElement('li');
    row.className = 'management-list-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agent-list-item management-list-button';
    button.dataset.id = String(options && options.id ? options.id : '');

    if (options && options.compact) {
      button.classList.add('compact');
    }

    if (options && options.active) {
      button.classList.add('active');
      button.setAttribute('aria-current', 'true');
    }

    row.appendChild(button);
    return { row, button };
  };

  shared.createManagementListEmptyState = function createManagementListEmptyState(message) {
    const row = document.createElement('li');
    row.className = 'empty-state management-list-empty';
    row.textContent = String(message || '暂无内容');
    return row;
  };
})();
