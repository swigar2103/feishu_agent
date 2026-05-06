import { hmrsMemoryUpdateNode } from "./hmrsMemoryUpdateNode.js";
import type { ReportGraphStateType } from "../state.js";

export async function memoryUpdateNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  return hmrsMemoryUpdateNode(state);
}
