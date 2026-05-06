import type { ResourceSummary } from "../../../schemas/agentContracts.js";
import type { UserRequest } from "../../../schemas/index.js";
import {
  type L1CatalogObject,
  type L2IndexObject,
  type SourceRef,
  L1CatalogObjectSchema,
  L2IndexObjectSchema,
} from "./layerSchemas.js";

function inferMemPalacePlacement(resource: ResourceSummary): {
  wingId: string;
  roomId: string;
  drawerId: string;
} {
  if (resource.resourceType === "contact_summary") {
    return {
      wingId: "people_wing",
      roomId: "self_room",
      drawerId: "profile_drawer",
    };
  }
  if (resource.resourceType === "project_memory") {
    return {
      wingId: "projects_wing",
      roomId: `${(resource.project ?? "default").replace(/[^\p{L}\p{N}]+/gu, "_").toLowerCase()}_room`,
      drawerId: "summary_drawer",
    };
  }
  if (resource.resourceType === "doc_summary" || resource.resourceType === "table_summary") {
    return {
      wingId: "resources_wing",
      roomId: "imported_docs_room",
      drawerId: "docs_drawer",
    };
  }
  return {
    wingId: "conversations_wing",
    roomId: "general_topic_room",
    drawerId: "raw_refs_drawer",
  };
}

function inferSourceRef(resource: ResourceSummary): SourceRef {
  if (resource.link?.includes("/docx/")) {
    return {
      sourceType: "doc",
      url: resource.link,
      docToken: resource.link.split("/").pop(),
    };
  }
  if (resource.resourceType === "table_summary") {
    return {
      sourceType: "table",
      url: resource.link,
    };
  }
  if (resource.resourceType === "message_thread_summary" || resource.resourceType === "contact_summary") {
    return {
      sourceType: "chat",
      url: resource.link,
    };
  }
  return {
    sourceType: "unknown",
    url: resource.link,
  };
}

function normalizeKeywords(resource: ResourceSummary, request: UserRequest): string[] {
  return Array.from(
    new Set(
      [
        ...resource.keywords,
        ...resource.tags,
        request.reportType ?? "",
        request.industry ?? "",
      ].filter((item) => item.trim().length > 0),
    ),
  ).slice(0, 20);
}

export function toL1CatalogObject(resource: ResourceSummary, request: UserRequest): L1CatalogObject {
  const placement = inferMemPalacePlacement(resource);
  return L1CatalogObjectSchema.parse({
    id: `l1_${resource.resourceId}`,
    type: resource.resourceType,
    layer: "L1",
    wingId: placement.wingId,
    roomId: placement.roomId,
    drawerId: placement.drawerId,
    owner: request.userId,
    projectTag: resource.project || request.industry || "default",
    timeRange: { end: resource.updatedAt },
    keywords: normalizeKeywords(resource, request),
    qualityScore: resource.score ?? 0.45,
    sourceRef: inferSourceRef(resource),
    title: resource.title,
    summary: resource.summary,
  });
}

export function toL2IndexObject(resource: ResourceSummary, request: UserRequest): L2IndexObject {
  const structureSummary = `${resource.title} ${resource.summary}`.slice(0, 2400);
  const placement = inferMemPalacePlacement(resource);
  return L2IndexObjectSchema.parse({
    id: `l2_${resource.resourceId}`,
    type: resource.resourceType,
    layer: "L2",
    wingId: placement.wingId,
    roomId: placement.roomId,
    drawerId: placement.drawerId,
    owner: request.userId,
    parentId: `l1_${resource.resourceId}`,
    projectTag: resource.project || request.industry || "default",
    timeRange: { end: resource.updatedAt },
    keywords: normalizeKeywords(resource, request),
    qualityScore: Math.min(1, (resource.score ?? 0.45) + 0.05),
    sourceRef: inferSourceRef(resource),
    title: resource.title,
    structureSummary,
  });
}
