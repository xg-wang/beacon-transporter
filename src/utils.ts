declare global {
  interface Window {
    __DEBUG_BEACON_TRANSPORTER?: boolean;
  }
}

export function createHeaders(
  headers: Record<string, string> = {},
  headerName: string | undefined,
  attempt: number,
  errorCode?: number
): Record<string, string> {
  if (!headerName || attempt < 1) return headers;
  headers[headerName] = JSON.stringify({ attempt, errorCode });
  return headers;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function debug(data: () => string): void {
  if (typeof window !== 'undefined' && window.__DEBUG_BEACON_TRANSPORTER) {
    console.debug('[beacon-transporter] ', data());
  }
}

export function logError(data: () => string): void {
  if (typeof window !== 'undefined' && window.__DEBUG_BEACON_TRANSPORTER) {
    console.error('[beacon-transporter] ', data());
  }
}

interface ScheduleTaskConfig {
  fallbackTimeout?: number;
  timeRemaining: number;
  timeout: number;
}

/**
 * Schedule task to minimize main thread impact
 */
export function scheduleTask<T = void>(
  runTask: () => T,
  config: ScheduleTaskConfig = {
    timeRemaining: 5,
    timeout: 10000,
  }
): void {
  if (typeof requestIdleCallback === 'undefined') {
    setTimeout(runTask, config.fallbackTimeout || 10);
  } else {
    const runIdleScheduler = (): void => {
      requestIdleCallback(
        (deadline) => {
          if (
            deadline.timeRemaining() > config.timeRemaining ||
            deadline.didTimeout
          ) {
            runTask();
          } else {
            runIdleScheduler();
          }
        },
        { timeout: config.timeout }
      );
    };
    runIdleScheduler();
  }
}

export interface ThrottleControl<Param> {
  throttledFn: (param: Param) => void;
  resetThrottle: () => void;
}

/**
 * Create throttle control for executing function that is throttled,
 * and support resetting the throttling time
 */
export function throttle<Param>(
  fn: (param: Param) => void,
  timeFrame: number
): ThrottleControl<Param> {
  let lastTime = 0;
  const throttledFn = (param: Param): void => {
    const now = Date.now();
    if (now - lastTime > timeFrame) {
      debug(() => '[throttle] Run fn() at ' + String(now));
      fn(param);
      lastTime = now;
    }
  };
  const resetThrottle = (): void => {
    lastTime = 0;
  };
  return {
    throttledFn,
    resetThrottle,
  };
}
