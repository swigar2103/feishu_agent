import type { HmrsRepositories } from "../interfaces.js";
import { FileCatalogRepository } from "./fileCatalogRepository.js";
import { FileIndexRepository } from "./fileIndexRepository.js";
import { FileRelationRepository } from "./fileRelationRepository.js";
import { FileWritebackRepository } from "./fileWritebackRepository.js";

export function createFileHmrsRepositories(): HmrsRepositories {
  return {
    catalog: new FileCatalogRepository(),
    index: new FileIndexRepository(),
    relation: new FileRelationRepository(),
    writeback: new FileWritebackRepository(),
  };
}
