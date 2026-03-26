export type RouteHandler<Context = unknown> = (context: Context) => boolean | Promise<boolean>;

export type Controller<Context = unknown> = {
  handle: RouteHandler<Context>;
};

function isRouteHandler<Context>(value: unknown): value is RouteHandler<Context> {
  return typeof value === 'function';
}

export function createRouter<Context = unknown>(
  controllers: Array<RouteHandler<Context> | Controller<Context> | null | undefined> = []
) {
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
    .filter(isRouteHandler);

  async function route(context: Context) {
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
