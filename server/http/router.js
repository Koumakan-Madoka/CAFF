function createRouter(controllers = []) {
  const handlers = (Array.isArray(controllers) ? controllers : [])
    .map((controller) => {
      if (typeof controller === 'function') {
        return controller;
      }

      if (controller && typeof controller.handle === 'function') {
        return controller.handle.bind(controller);
      }

      return null;
    })
    .filter(Boolean);

  async function route(context) {
    for (const handler of handlers) {
      if (await handler(context)) {
        return true;
      }
    }

    return false;
  }

  return {
    route,
  };
}

module.exports = {
  createRouter,
};
