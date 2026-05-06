import type {
  HmrsRelation,
  L1CatalogObject,
  L2IndexObject,
  L3DetailPointerObject,
} from "../model/layerSchemas.js";

export type LayerQuery = {
  owner: string;
  keyword?: string;
  projectTag?: string;
  limit?: number;
  ids?: string[];
};

export type HmrsWritebackPayload = {
  owner: string;
  l1Patches?: L1CatalogObject[];
  l2Patches?: L2IndexObject[];
  l3Patches?: L3DetailPointerObject[];
};

export interface HmrsCatalogRepository {
  query(query: LayerQuery): Promise<L1CatalogObject[]>;
  upsert(items: L1CatalogObject[]): Promise<void>;
}

export interface HmrsIndexRepository {
  query(query: LayerQuery): Promise<L2IndexObject[]>;
  upsert(items: L2IndexObject[]): Promise<void>;
}

export interface HmrsRelationRepository {
  listByFromIds(fromIds: string[]): Promise<HmrsRelation[]>;
  upsert(relations: HmrsRelation[]): Promise<void>;
}

export interface HmrsWritebackRepository {
  write(payload: HmrsWritebackPayload): Promise<void>;
}

export type HmrsRepositories = {
  catalog: HmrsCatalogRepository;
  index: HmrsIndexRepository;
  relation: HmrsRelationRepository;
  writeback: HmrsWritebackRepository;
};
