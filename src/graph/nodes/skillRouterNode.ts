import { routeSkill } from "../../services/agent/skillRouter.js";
import type { ReportGraphStateType } from "../state.js";

export async function skillRouterNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.intentResult) {
    throw new Error("skill_router 缺少 intentResult");
  }

  const skillMatch = routeSkill(state.intentResult);
  return {
    skillMatch,
    debugTrace: [
      `[skill_router] skill=${skillMatch.selectedSkill.skillId} source=${skillMatch.source} workflow=${skillMatch.workflowMeta?.workflowSourceId ?? "-"}`,
    ],
  };
}
