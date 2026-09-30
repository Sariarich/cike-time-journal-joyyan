function createSyncEngine({ queue, execute, onStateChange }) {
  let running = false;
  const run = async () => {
    if (running || !navigator.onLine) return;
    running = true;
    try {
      for (const operation of await queue.list(["pending", "failed"])) {
        await queue.update(operation.operationId, { status: "syncing", lastError: "" });
        try {
          await execute(operation);
          await queue.update(operation.operationId, { status: "succeeded", lastError: "" });
        } catch (error) {
          await queue.update(operation.operationId, { status: "failed", attempts: operation.attempts + 1, lastError: error?.message || "同步失败" });
          break;
        }
        await onStateChange?.();
      }
    } finally {
      running = false;
      await onStateChange?.();
    }
  };
  return { run };
}

window.createSyncEngine = createSyncEngine;
