// @ts-check
(function startWikiSkill() {
  const shared = window.CaffShared;
  const panel = shared.createBadcaseWikiPanel({ root: document.getElementById('badcase-wiki-panel'), fetchJson: shared.fetchJson });
  void panel.load();
})();
