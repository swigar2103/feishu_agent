import { Annotation } from "@langchain/langgraph";
import type {
  AnalystOutput,
  RetrievalContext,
  ReviewReport,
  TaskIntent,
  TaskPlan,
  UserMemory,
  UserRequest,
  WriterInput,
  WriterOutput,
} from "../schemas/index.js";

export const ReportGraphState = Annotation.Root({
  userRequest: Annotation<UserRequest | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  retrievalContext: Annotation<RetrievalContext | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  // Phase 3.2：本次生成时，retriever 注入给 Writer 的完整 UserMemory 快照（含 usageCount 等元数据）。
  // 写入时刻是 retrieverNode，memoryWriterNode 不会覆盖；用于响应里透出"这次用的记忆是啥"。
  injectedMemorySnapshot: Annotation<UserMemory | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  taskPlan: Annotation<TaskPlan | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  analystOutput: Annotation<AnalystOutput | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  writerInput: Annotation<WriterInput | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  writerOutput: Annotation<WriterOutput | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  reviewReport: Annotation<ReviewReport | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  taskIntent: Annotation<TaskIntent | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  revisionCount: Annotation<number>({
    reducer: (_, right) => right,
    default: () => 0,
  }),
  followUpQuestions: Annotation<string[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  reviewNotes: Annotation<string[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  debugTrace: Annotation<string[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  // Phase 5：飞书云文档回写结果。失败时保持 null，feishu_notify 会据此判断是否在卡片里放按钮
  feishuDocId: Annotation<string | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  feishuDocUrl: Annotation<string | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
});

export type ReportGraphStateType = typeof ReportGraphState.State;
