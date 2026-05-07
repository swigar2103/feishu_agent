import { Annotation } from "@langchain/langgraph";
import type {
  AnalysisResult,
  BlueprintPlan,
  CandidateResourceList,
  ComplianceReviewResult,
  DetailedContext,
  Draft,
  ExecutionPlan,
  FinalDeliverable,
  IntentResult,
  MemoryUpdate,
  ResourcePoolChange,
  ResourceSummary,
  SkillMatch,
  StyleReviewResult,
  TaskRequest,
} from "../schemas/agentContracts.js";
import type {
  RetrievalContext,
  TaskPlan,
  UserRequest,
  WriterInput,
  WriterOutput,
} from "../schemas/index.js";

export const ReportGraphState = Annotation.Root({
  userRequest: Annotation<UserRequest | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  taskRequest: Annotation<TaskRequest | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  resourcePool: Annotation<ResourceSummary[]>({
    reducer: (_, right) => right,
    default: () => [],
  }),
  candidateResources: Annotation<CandidateResourceList | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  intentResult: Annotation<IntentResult | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  skillMatch: Annotation<SkillMatch | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  executionPlan: Annotation<ExecutionPlan | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  detailedContext: Annotation<DetailedContext | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  analysisResult: Annotation<AnalysisResult | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  draft: Annotation<Draft | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  styleReviewResult: Annotation<StyleReviewResult | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  complianceReviewResult: Annotation<ComplianceReviewResult | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  finalDeliverable: Annotation<FinalDeliverable | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  memoryUpdate: Annotation<MemoryUpdate | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  resourcePoolChange: Annotation<ResourcePoolChange | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  styleRewriteHints: Annotation<string[]>({
    reducer: (_, right) => right,
    default: () => [],
  }),
  callbackRoute: Annotation<
    "to_writer" | "to_compliance" | "to_planner" | "to_analyst" | "to_publish" | null
  >({
    reducer: (_, right) => right,
    default: () => null,
  }),
  styleReviewLoopCount: Annotation<number>({
    reducer: (_, right) => right,
    default: () => 0,
  }),
  complianceLoopCount: Annotation<number>({
    reducer: (_, right) => right,
    default: () => 0,
  }),
  retrievalContext: Annotation<RetrievalContext | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  taskPlan: Annotation<TaskPlan | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  blueprintPlan: Annotation<BlueprintPlan | null>({
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
  taskIntent: Annotation<string | null>({
    reducer: (_, right) => right,
    default: () => null,
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
});

export type ReportGraphStateType = typeof ReportGraphState.State;
