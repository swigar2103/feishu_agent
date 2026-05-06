import type { ResourceSummary } from "../../schemas/agentContracts.js";
import type { UserRequest } from "../../schemas/index.js";
import { ResourcePoolStore } from "../../storage/resourcePoolStore.js";
import { toolGateway } from "../toolGateway/gateway.js";

export class ResourcePoolManager {
  private readonly store: ResourcePoolStore;

  constructor() {
    this.store = new ResourcePoolStore();
  }

  async buildResourcePool(request: UserRequest): Promise<ResourceSummary[]> {
    const persistedPool = this.store.loadAll();
    const basePool: ResourceSummary[] = persistedPool;

    const contactResources: ResourceSummary[] = [];
    for (const [idx, contact] of request.imContacts.entries()) {
      const remoteProfile = await toolGateway.getUserInfo(contact.id).catch(() => null);
      contactResources.push({
        resourceId: `contact_${idx + 1}_${contact.id}`,
        resourceType: "contact_summary",
        title: `${remoteProfile?.name ?? contact.name} 联系人信息`,
        summary: `姓名=${remoteProfile?.name ?? contact.name} 角色=${remoteProfile?.role ?? contact.role ?? "未知"} id=${contact.id}`,
        project: request.industry ?? "通用项目",
        tags: ["contact", remoteProfile?.role ?? contact.role ?? "unknown"],
        keywords: [remoteProfile?.name ?? contact.name, remoteProfile?.role ?? contact.role ?? "联系人"],
      });
    }

    const historyResources: ResourceSummary[] = request.historyDocs.map((doc, idx) => ({
      resourceId: `history_${idx + 1}`,
      resourceType: "project_memory",
      title: `历史材料 ${idx + 1}`,
      summary: doc,
      project: request.industry ?? "通用项目",
      tags: ["history"],
      keywords: doc.split(/[，。,\s]/).filter(Boolean).slice(0, 8),
    }));

    return [...basePool, ...contactResources, ...historyResources];
  }
}
