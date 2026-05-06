import { ResourcePoolChangeSchema, type ResourcePoolChange } from "../../schemas/agentContracts.js";
import type { UserRequest } from "../../schemas/index.js";

export function buildResourcePoolChange(input: {
  request: UserRequest;
  usedResourceIds: string[];
  missingFields: string[];
}): ResourcePoolChange {
  const addedResourceIds = input.request.extraContext.map(
    (_, idx) => `extra_ctx_${idx + 1}_${input.request.sessionId}`,
  );

  const change = ResourcePoolChangeSchema.parse({
    addedResourceIds,
    updatedResourceIds: input.usedResourceIds.slice(0, 5),
    reason:
      input.missingFields.length > 0
        ? "HMRS 模式：记录缺失字段与候选使用痕迹"
        : "HMRS 模式：记录高价值资源关系",
  });

  return change;
}
