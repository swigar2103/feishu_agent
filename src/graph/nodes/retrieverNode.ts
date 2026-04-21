import { RetrievalContextSchema } from "../../schemas/index.js";
import { getMemoryStore } from "../../services/memory/store.js";
import { getContextForReport } from "../../services/retrievalClient.js";
import type { ReportGraphStateType } from "../state.js";

export async function retrieverNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.userRequest) {
    throw new Error("retriever_node 缺少 userRequest");
  }

  const retrievalContext = RetrievalContextSchema.parse(
    await getContextForReport(state.userRequest),
  );

  // Phase 3.2：除了 retrievalContext 里的 UserMemoryView，再单独加载一份完整 UserMemory
  // （含 usageCount / lastUsedAt / recentTones 等元数据），供响应透出 + 调试观察。
  const injectedMemorySnapshot = getMemoryStore().load(state.userRequest.userId);

  return {
    retrievalContext,
    injectedMemorySnapshot,
    debugTrace: [
      `[retriever_node] loaded contexts=${retrievalContext.projectContext.length}`,
      `[retriever_node] matched skill=${retrievalContext.matchedSkill.skillId}`,
      `[retriever_node] user_memory usageCount=${injectedMemorySnapshot.usageCount} tone=${injectedMemorySnapshot.preferredTone ?? "-"} terms=${injectedMemorySnapshot.commonTerms?.length ?? 0} structure=${injectedMemorySnapshot.preferredStructure?.length ?? 0}`,
    ],
  };
}
