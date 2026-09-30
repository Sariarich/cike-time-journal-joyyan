const SYNC_QUEUE_DB = "right-now-sync-v1";
const SYNC_QUEUE_STORE = "operations";

function createSyncQueue() {
  let databasePromise;
  const open = () => databasePromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(SYNC_QUEUE_DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(SYNC_QUEUE_STORE, { keyPath: "operationId" });
      store.createIndex("byStatus", "status");
      store.createIndex("byCreatedAt", "createdAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本机同步队列"));
  });
  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("同步队列操作失败"));
  });
  const transact = async (mode, action) => {
    const database = await open();
    const transaction = database.transaction(SYNC_QUEUE_STORE, mode);
    const result = await action(transaction.objectStore(SYNC_QUEUE_STORE));
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error("同步队列事务已中止"));
      transaction.onerror = () => reject(transaction.error || new Error("同步队列事务失败"));
    });
    return result;
  };
  const list = async (statuses = ["pending", "failed", "syncing"]) => transact("readonly", async (store) => {
    const records = await requestResult(store.getAll());
    return records.filter((record) => statuses.includes(record.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
  const enqueue = async ({ entityType, entityId, action, payload }) => {
    const operationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const operation = { operationId, entityType, entityId, action, payload, status: "pending", attempts: 0, createdAt: now, updatedAt: now, lastError: "" };
    await transact("readwrite", (store) => requestResult(store.put(operation)));
    return operation;
  };
  const update = async (operationId, changes) => transact("readwrite", async (store) => {
    const operation = await requestResult(store.get(operationId));
    if (!operation) return null;
    const next = { ...operation, ...changes, updatedAt: new Date().toISOString() };
    await requestResult(store.put(next));
    return next;
  });
  const recoverInterrupted = async () => transact("readwrite", async (store) => {
    const all = await requestResult(store.getAll());
    await Promise.all(all.filter((operation) => operation.status === "syncing").map((operation) => requestResult(store.put({ ...operation, status: "pending", updatedAt: new Date().toISOString() }))));
  });
  const pendingCount = async () => (await list()).length;
  return { enqueue, list, update, recoverInterrupted, pendingCount };
}

window.createSyncQueue = createSyncQueue;
