import type { HmrsWing } from "./model/memPalaceTree.js";

export function buildUserHmrsRootName(input: { userId: string; nickname?: string }): string {
  const safeNick = (input.nickname ?? "")
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  if (safeNick) return `${safeNick}_${input.userId}_mempalace`;
  return `${input.userId}_mempalace`;
}

export function buildBaseWingNames(): HmrsWing[] {
  return [
    "people_wing",
    "projects_wing",
    "templates_wing",
    "resources_wing",
    "conversations_wing",
  ];
}

export function buildRequiredFolders(): string[] {
  return [
    "_system",
    "people_wing/self_room/style_drawer",
    "people_wing/self_room/writing_thought_drawer",
    "people_wing/self_room/exemplar_drawer",
    "people_wing/self_room/profile_drawer",
    "projects_wing",
    "templates_wing/weekly_report_room/structure_drawer",
    "templates_wing/weekly_report_room/visual_slots_drawer",
    "templates_wing/weekly_report_room/examples_drawer",
    "templates_wing/meeting_summary_room/structure_drawer",
    "templates_wing/meeting_summary_room/examples_drawer",
    "templates_wing/proposal_room/structure_drawer",
    "templates_wing/proposal_room/examples_drawer",
    "resources_wing/imported_docs_room",
    "resources_wing/imported_files_room",
    "resources_wing/imported_chats_room",
    "resources_wing/imported_slides_room",
    "conversations_wing",
  ];
}
