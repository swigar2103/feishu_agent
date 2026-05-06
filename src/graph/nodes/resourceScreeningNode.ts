import { hmrsSummaryNode } from "./hmrsSummaryNode.js";
import type { ReportGraphStateType } from "../state.js";

export async function resourceScreeningNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  return hmrsSummaryNode(state);
}
