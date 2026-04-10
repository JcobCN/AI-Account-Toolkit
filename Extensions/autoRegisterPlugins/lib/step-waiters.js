(function attachStepWaiterApi(globalScope) {
  function normalizeError(error, fallbackMessage) {
    if (error instanceof Error) {
      return error;
    }
    if (typeof error === 'string' && error) {
      return new Error(error);
    }
    return new Error(fallbackMessage);
  }

  function createStepWaiterRegistry(options = {}) {
    const schedule = options.schedule || setTimeout;
    const cancel = options.cancel || clearTimeout;
    const waiters = new Map();

    function clearOwnedWaiter(step, waiter) {
      if (waiters.get(step) === waiter) {
        waiters.delete(step);
      }
    }

    function waitForStepComplete(step, timeoutMs = 120000) {
      return new Promise((resolve, reject) => {
        const existing = waiters.get(step);
        if (existing) {
          existing.reject(new Error(`Step ${step} waiter was replaced by a newer execution.`));
        }

        let settled = false;
        const waiter = {
          resolve: (payload) => {
            if (settled) {
              return;
            }
            settled = true;
            cancel(waiter.timer);
            clearOwnedWaiter(step, waiter);
            resolve(payload);
          },
          reject: (error) => {
            if (settled) {
              return;
            }
            settled = true;
            cancel(waiter.timer);
            clearOwnedWaiter(step, waiter);
            reject(normalizeError(error, `Step ${step} failed.`));
          },
          timer: null,
        };

        waiter.timer = schedule(() => {
          waiter.reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s.`));
        }, timeoutMs);

        waiters.set(step, waiter);
      });
    }

    function notifyStepComplete(step, payload) {
      const waiter = waiters.get(step);
      if (waiter) {
        waiter.resolve(payload);
      }
    }

    function notifyStepError(step, error) {
      const waiter = waiters.get(step);
      if (waiter) {
        waiter.reject(error);
      }
    }

    function rejectAll(error) {
      const pending = Array.from(waiters.values());
      waiters.clear();
      for (const waiter of pending) {
        waiter.reject(error);
      }
    }

    return {
      waitForStepComplete,
      notifyStepComplete,
      notifyStepError,
      rejectAll,
    };
  }

  const api = { createStepWaiterRegistry };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  Object.assign(globalScope, api);
})(typeof globalThis !== 'undefined' ? globalThis : self);
