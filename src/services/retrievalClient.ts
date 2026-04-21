import type { RetrievalContext, UserRequest } from "../schemas/index.js";
import { RetrievalEngine } from "./retrieval/engine.js";

// 实例化检索引擎（作为单例运行）
const engine = new RetrievalEngine();

export function getRetrievalDiagnostic(): ReturnType<RetrievalEngine["getFeishuDiagnostic"]> {
  return engine.getFeishuDiagnostic();
}

/** 给非 Retrieval 模块（如飞书通知节点）复用同一个鉴权 client；mock 模式返回 null */
export function getFeishuClient(): ReturnType<RetrievalEngine["getFeishuClient"]> {
  return engine.getFeishuClient();
}

/**
 * 暴露给主流程 (Report Pipeline / LangGraph) 的唯一检索入口
 * * @param userRequest 从外部传入的用户标准化请求
 * @returns 组装好的完整上下文 (严格符合 RetrievalContextSchema)
 */
export async function getContextForReport(
  userRequest: UserRequest
): Promise<RetrievalContext> {
  console.log(`[Retrieval Module] 收到请求 -> User: ${userRequest.userId}, Type: ${userRequest.reportType}`);

  try {
    // 调用核心引擎获取上下文
    const context = await engine.getContextForReport(userRequest);

    console.log(`[Retrieval Module] 组装完毕 -> 匹配 Skill: [${context.matchedSkill.name}], 召回素材数: ${context.projectContext.length}`);

    return context;
  } catch (error) {
    console.error(`[Retrieval Module] 检索失败:`, error);
    throw error; // 报错必须向上抛出，让主干的 graph 能够捕获并处理异常
  }
}