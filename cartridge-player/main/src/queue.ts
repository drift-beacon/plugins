/**
 * The one queue every change goes through: player reports, interface requests and presence writes run one
 * at a time, so a removal always sees the session its insert started and no write overwrites another's (main is the
 * only writer of storage). Route handlers and channel requests run concurrently otherwise.
 */

export interface Queue {
  /** Runs `task` after every task queued before it. A failed task doesn't hold up the ones after it. */
  run<T>(task: () => T | Promise<T>): Promise<T>;
  /** Tasks queued or running: a backlog means something upstream is slow. */
  readonly size: number;
}

export function createQueue(): Queue {
  let last: Promise<unknown> = Promise.resolve();
  let size = 0;
  return {
    run<T>(task: () => T | Promise<T>): Promise<T> {
      size += 1;
      const run = last.then(task).finally(() => {
        size -= 1;
      });
      last = run.catch(() => {});
      return run;
    },
    get size() {
      return size;
    },
  };
}
