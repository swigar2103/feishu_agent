export type HmrsWing =
  | "people_wing"
  | "projects_wing"
  | "templates_wing"
  | "resources_wing"
  | "conversations_wing";

export type HmrsSystemFileName =
  | "hmrs_manifest.json"
  | "refresh_status.json"
  | "recall_budget.json"
  | "permissions.json";

export type HmrsManifest = {
  version: "hmrs_v1";
  userId: string;
  nickname?: string;
  rootFolderName: string;
  rootFolderToken: string;
  createdAt: string;
  updatedAt: string;
  sourceOfTruth: "feishu_user_space";
  wings: HmrsWing[];
};

export type HmrsRefreshStatus = {
  userId: string;
  lastBootstrapAt?: string;
  lastIngestAt?: string;
  lastRefreshAt?: string;
  managedFolderTokens: string[];
  folderSignatures?: Record<string, string>;
  lastError?: string;
};

export type HmrsRecallBudget = {
  maxRoomsPerRound: number;
  maxDocsPerRound: number;
  maxSnippetsPerRound: number;
  maxCharsPerRound: number;
};

export type HmrsPermissions = {
  identityMode: "uat" | "tat";
  scopes: string[];
  writable: boolean;
};
