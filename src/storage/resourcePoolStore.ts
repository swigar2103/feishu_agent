import fs from "node:fs";
import path from "node:path";
import { ResourceSummarySchema, type ResourceSummary } from "../schemas/agentContracts.js";
import { getWritableDataDir } from "./writableDataDir.js";

function resourcePoolFilePath(): string {
  return path.join(getWritableDataDir(), "resource-pool.json");
}

type ResourcePoolSnapshot = {
  updatedAt: string;
  resources: ResourceSummary[];
};

function readSnapshot(): ResourcePoolSnapshot {
  const file = resourcePoolFilePath();
  if (!fs.existsSync(file)) {
    return { updatedAt: new Date(0).toISOString(), resources: [] };
  }

  const raw = fs.readFileSync(file, "utf-8");
  const json = JSON.parse(raw) as ResourcePoolSnapshot;
  return {
    updatedAt: json.updatedAt ?? new Date(0).toISOString(),
    resources: Array.isArray(json.resources)
      ? json.resources.map((item) => ResourceSummarySchema.parse(item))
      : [],
  };
}

function writeSnapshot(snapshot: ResourcePoolSnapshot): void {
  const file = resourcePoolFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf-8");
}

export class ResourcePoolStore {
  loadAll(): ResourceSummary[] {
    return readSnapshot().resources;
  }

  saveAll(resources: ResourceSummary[]): void {
    writeSnapshot({
      updatedAt: new Date().toISOString(),
      resources: resources.map((item) => ResourceSummarySchema.parse(item)),
    });
  }

  upsert(resources: ResourceSummary[]): void {
    const snapshot = readSnapshot();
    const map = new Map(snapshot.resources.map((item) => [item.resourceId, item]));
    for (const resource of resources) {
      map.set(resource.resourceId, ResourceSummarySchema.parse(resource));
    }
    writeSnapshot({
      updatedAt: new Date().toISOString(),
      resources: Array.from(map.values()),
    });
  }
}
