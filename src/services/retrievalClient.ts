import type { RetrievalContext, TaskPlan, UserRequest } from "../schemas/index.js";
import type { ResourcePoolManager } from "../resource_pool/manager.js";
import { RetrievalEngine } from "./retrieval/engine.js";

// 实例化检索引擎（作为单例运行）
const engine = new RetrievalEngine();

/** LangGraph/B4：将 applyResourceUsage 后的池子写回单机引擎（进程内语义） */
export function commitResourcePoolReplacement(nextPool: ResourcePoolManager): void {
  engine.replaceResourcePoolManager(nextPool);
}
/**
 * 暴露给主流程 (Report Pipeline / LangGraph) 的唯一检索入口
 * * @param userRequest 从外部传入的用户标准化请求
 * @returns 组装好的完整上下文 (严格符合 RetrievalContextSchema)
 */
export async function getContextForReport(
  userRequest: UserRequest,
  taskPlan?: TaskPlan | null,
  opts?: { taskIntent?: string | null },
): Promise<RetrievalContext> {
  console.log(`[Retrieval Module] 收到请求 -> User: ${userRequest.userId}, Type: ${userRequest.reportType}`);

  try {
    const context = await engine.getContextForReport(userRequest, taskPlan ?? null, opts);

    console.log(`[Retrieval Module] 组装完毕 -> 匹配 Skill: [${context.matchedSkill.name}], 召回素材数: ${context.projectContext.length}`);

    return context;
  } catch (error) {
    console.error(`[Retrieval Module] 检索失败:`, error);
    throw error; // 报错必须向上抛出，让主干的 graph 能够捕获并处理异常
  }
}