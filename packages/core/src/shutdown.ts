/**
 * @non-paper graceful-shutdown hook (Wave 4 DX).
 *
 * The paper has no process lifecycle; this module adds an OPTIONAL,
 * additive seam: `installShutdown(save)` checkpoints once per signal.
 *
 * - Registers one shared handler for `SIGINT` and `SIGTERM`;
 * - each signal best-effort invokes `save()` (sync throws and async
 *   rejections are swallowed — teardown must never crash);
 * - returns an uninstall closure (idempotent) removing both listeners.
 *
 * The hook never calls `process.exit` itself: callers decide whether to
 * exit after the checkpoint. Zero dependencies, Node >= 20, ESM.
 */

/// <reference types="node" />

/**
 * @non-paper install a checkpoint-on-signal hook. Returns an idempotent
 * uninstall function.
 */
export function installShutdown(save: () => Promise<void>): () => void {
  let installed = true;
  const handler = (): void => {
    try {
      const pending = save();
      pending.catch(() => {});
    } catch {
      // Best-effort checkpoint: sync throws are swallowed like rejections.
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    if (installed === false) {
      return;
    }
    installed = false;
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
  };
}
