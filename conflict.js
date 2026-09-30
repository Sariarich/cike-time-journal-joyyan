function createConflictService({ state, saveLocal }) {
  state.syncConflicts ||= [];

  const keyFor = ({ entityType, entityId }) => `${entityType}:${entityId}`;
  const textFor = (entityType, value = {}) => {
    if (entityType === "summary") return value.content || "";
    if (entityType === "thought") return `${value.title || ""}\n${value.content || ""}`;
    if (entityType === "reading-note") return value.text || value.body || "";
    return "";
  };
  const cloudTime = (value = {}) => value.updated_at || value.updatedAt || value.savedAt || "";
  const localTime = (value = {}) => value.updatedAt || value.savedAt || "";
  const isLongText = (entityType) => ["summary", "thought", "reading-note"].includes(entityType);
  const isDifferent = (entityType, local, cloud) => textFor(entityType, local) !== textFor(entityType, cloud);

  const compare = ({ entityType, entityId, local, cloud, localChanged = false }) => {
    if (!local) return { outcome: "cloud", value: cloud };
    if (!cloud) return { outcome: "local", value: local };
    if (isLongText(entityType) && localChanged && isDifferent(entityType, local, cloud)) {
      const record = {
        key: keyFor({ entityType, entityId }), entityType, entityId,
        local: structuredClone(local), cloud: structuredClone(cloud),
        status: "unresolved", detectedAt: new Date().toISOString()
      };
      const index = state.syncConflicts.findIndex((item) => item.key === record.key && item.status === "unresolved");
      if (index < 0) state.syncConflicts.unshift(record);
      else state.syncConflicts[index] = record;
      saveLocal();
      return { outcome: "conflict", record };
    }
    if (!isLongText(entityType) && localChanged) {
      return cloudTime(cloud) > localTime(local) ? { outcome: "cloud", value: cloud } : { outcome: "local", value: local };
    }
    return { outcome: "cloud", value: cloud };
  };

  const unresolved = () => state.syncConflicts.filter((item) => item.status === "unresolved");
  const hasUnresolved = (entityType, entityId) => unresolved().some((item) => item.entityType === entityType && item.entityId === entityId);
  const resolve = (key, decision, mergedText = "") => {
    const record = state.syncConflicts.find((item) => item.key === key && item.status === "unresolved");
    if (!record) return null;
    const value = decision === "local" ? structuredClone(record.local) : structuredClone(record.cloud);
    if (decision === "merged") {
      if (record.entityType === "summary") value.content = mergedText;
      if (record.entityType === "thought") value.content = mergedText;
      if (record.entityType === "reading-note") value.text = mergedText;
    }
    record.status = "resolved";
    record.resolution = decision;
    record.resolvedAt = new Date().toISOString();
    saveLocal();
    return { record, value };
  };

  return { compare, unresolved, hasUnresolved, resolve, textFor, cloudTime };
}

window.createConflictService = createConflictService;
