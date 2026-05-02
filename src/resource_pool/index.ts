export { ResourcePoolManager } from "./manager.js";

export {

  ContactSummarySchema,

  DocumentSummarySchema,

  PersonaSummarySchema,

  PoolTextQuerySchema,

  ProjectSummarySchema,

  ResourcePoolSnapshotSchema,

} from "./types.js";

export type {

  ContactSummary,

  DocumentSummary,

  PersonaSummary,

  PoolTextQuery,

  ProjectSummary,

  ResourcePoolSnapshot,

} from "./types.js";



export {

  ResourceCandidateRefSchema,

  ResourceScreeningResultSchema,

  ResourceKindSchema,

  ResourceScreeningTraceSchema,

} from "./candidate_types.js";

export type {

  ResourceCandidateRef,

  ResourceScreeningResult,

  ResourceKind,

} from "./candidate_types.js";



export { runResourceScreening, dedupeRefs } from "./screening.js";



export {

  HydratedTaskContextPackSchema,

  HydratedDocumentChunkSchema,

  HydratedContactDetailSchema,

  HydratedProjectDetailSchema,

  HydratedPersonaBriefSchema,

} from "./context_pack.js";

export type { HydratedTaskContextPack } from "./context_pack.js";



export { hydrateTaskContext } from "./hydrator.js";

export { taskContextPackToProjectSlices } from "./context_bridge.js";



export {

  applyResourceUsage,

  usageEvidenceFromScreeningCandidates,

  UsageEvidenceSchema,

} from "./enricher.js";

export type { UsageEvidence } from "./enricher.js";



export type { ResourceDataAdapter } from "./feishu/adapterTypes.js";

export { MockResourceDataAdapter } from "./feishu/mockResourceAdapter.js";

