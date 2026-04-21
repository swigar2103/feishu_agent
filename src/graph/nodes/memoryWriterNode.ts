import { buildUpdatedMemory } from "../../services/memory/extractor.js";
import { getMemoryStore } from "../../services/memory/store.js";
import type { ReportGraphStateType } from "../state.js";

/**
 * memoryWriterNode（Phase 3）：
 *   把本次运行的偏好信号写回 data/memory/<userId>.json
 *   设计为"静默守护"节点：
 *     - 缺少上游必要字段时只打 debugTrace，不阻塞主流程（正文已经在 format_output 里产出了）
 *     - 写盘失败也只记录到 debugTrace，不抛
 *   这样即使 Memory 层有任何问题，也绝不影响用户拿到的报告
 */
export async function memoryWriterNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  const trace: string[] = [];

  if (!state.userRequest || !state.taskPlan || !state.retrievalContext || !state.writerOutput) {
    trace.push("[memory_writer] skip: 缺少 userRequest/taskPlan/retrievalContext/writerOutput");
    return { debugTrace: trace };
  }

  try {
    const store = getMemoryStore();
    const old = store.load(state.userRequest.userId);
    const next = buildUpdatedMemory({
      old,
      userRequest: state.userRequest,
      taskPlan: state.taskPlan,
      retrievalContext: state.retrievalContext,
      writerOutput: state.writerOutput,
      analystOutput: state.analystOutput,
    });
    const saved = store.save(next);

    trace.push(
      `[memory_writer] user=${saved.userId} usageCount=${saved.usageCount} tone=${saved.preferredTone ?? "-"} structure=${saved.preferredStructure?.length ?? 0} terms=${saved.commonTerms?.length ?? 0}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trace.push(`[memory_writer] 失败(非阻塞): ${msg}`);
  }

  return { debugTrace: trace };
}
