/**
 * Mount an Express router without evaluating its module during process startup.
 * Failed imports are not cached so a transient filesystem error can be retried.
 */
export function lazyRouter(load) {
  let pending = null;
  return async function loadRouter(req, res, next) {
    try {
      pending ||= Promise.resolve().then(load).then((module) => module.default || module);
      const router = await pending;
      return router(req, res, next);
    } catch (error) {
      pending = null;
      return next(error);
    }
  };
}

export function lazyRouterFactory(load) {
  let pending = null;
  return async function loadRouter(req, res, next) {
    try {
      pending ||= Promise.resolve().then(load);
      const router = await pending;
      return router(req, res, next);
    } catch (error) {
      pending = null;
      return next(error);
    }
  };
}
