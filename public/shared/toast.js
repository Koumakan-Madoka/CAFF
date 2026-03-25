(function registerToastController() {
  const shared = window.CaffShared || (window.CaffShared = {});

  shared.createToastController = function createToastController(element, delayMs = 2600) {
    let timerId = null;

    return {
      hide() {
        if (!element) {
          return;
        }

        window.clearTimeout(timerId);
        element.classList.add('hidden');
      },
      show(message) {
        if (!element) {
          return;
        }

        window.clearTimeout(timerId);
        element.textContent = message;
        element.classList.remove('hidden');
        timerId = window.setTimeout(() => {
          element.classList.add('hidden');
        }, delayMs);
      },
    };
  };
})();
