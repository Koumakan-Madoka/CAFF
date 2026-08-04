// @ts-check

(function registerConnectionStatusModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createConnectionStatus = function createConnectionStatus() {
    /** @type {'connecting' | 'open' | 'failed'} */
    let transport = 'connecting';

    /**
     * @param {{ busy: boolean, runtimeLabel: string, connectingLabel: string }} input
     * @returns {{ status: 'connecting' | 'ok' | 'busy' | 'failed', label: string }}
     */
    function resolveDot({ busy, runtimeLabel, connectingLabel }) {
      if (transport === 'failed') {
        return { status: 'failed', label: '事件通道已断开，正在自动重连…' };
      }

      if (transport === 'connecting') {
        return { status: 'connecting', label: connectingLabel };
      }

      return { status: busy ? 'busy' : 'ok', label: runtimeLabel };
    }

    return {
      markOpen() {
        transport = 'open';
      },
      markFailed() {
        transport = 'failed';
      },
      resolveDot,
    };
  };
})();
