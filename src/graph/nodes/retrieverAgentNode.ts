import { hmrsExpansionNode } from "./hmrsExpansionNode.js";
import type { ReportGraphStateType } from "../state.js";

export async function retrieverAgentNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  return hmrsExpansionNode(state);
}
