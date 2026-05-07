import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../../shared/logger.js";
import type { Draft } from "../../schemas/agentContracts.js";
import { toolGateway } from "../toolGateway/gateway.js";

export type RenderedArtifactKind = "image" | "whiteboard" | "sheet_chart";

export type RenderedArtifact = {
  slotId: string;
  sectionHeading: string;
  kind: RenderedArtifactKind;
  /** 当 kind=image：飞书 mediaToken；当 kind=whiteboard/sheet_chart：被引用对象的 token */
  embedToken: string;
  url?: string;
  caption?: string;
  fallbackMarkdown?: string;
  source?: "mcp" | "lark_cli" | "openapi" | "local_fallback";
};

export type RenderInput = {
  userId: string;
  documentId?: string;
  draft: Draft;
};

export type RenderOutput = {
  artifacts: RenderedArtifact[];
  warnings: string[];
};

function buildGanttPlantUml(slot: Draft["ganttSlots"][number]): string | null {
  const data = slot.data ?? [];
  if (!Array.isArray(data) || data.length === 0) return null;
  const lines: string[] = [];
  lines.push("@startgantt");
  lines.push(`title ${slot.task}`);
  for (const item of data) {
    const safeTask = item.task.replace(/\[/g, "(").replace(/\]/g, ")");
    lines.push(`[${safeTask}] starts ${item.start} and ends ${item.end}`);
    if (item.owner) {
      lines.push(`note right of [${safeTask}] : ${item.owner}`);
    }
  }
  lines.push("@endgantt");
  return lines.join("\n");
}

function buildGanttMermaid(slot: Draft["ganttSlots"][number]): string | null {
  const data = slot.data ?? [];
  if (!Array.isArray(data) || data.length === 0) return null;
  const lines: string[] = ["gantt", `    title ${slot.task}`, "    dateFormat  YYYY-MM-DD"];
  data.forEach((item, idx) => {
    lines.push(`    section ${item.owner ?? "任务"}`);
    const safeTask = item.task.replace(/:/g, "-");
    lines.push(`    ${safeTask}    :a${idx + 1}, ${item.start}, ${item.end}`);
  });
  return lines.join("\n");
}

function buildTimelineMermaid(slot: Draft["timelineSlots"][number]): string | null {
  const data = slot.data ?? [];
  if (!Array.isArray(data) || data.length === 0) return null;
  const lines: string[] = ["timeline", `    title ${slot.title}`];
  for (const item of data) {
    const safeLabel = item.label.replace(/:/g, "-");
    lines.push(`    ${item.when} : ${safeLabel}${item.note ? ` - ${item.note}` : ""}`);
  }
  return lines.join("\n");
}

function buildChartMermaid(slot: Draft["chartSlots"][number]): string | null {
  const data = slot.data;
  if (!data || !Array.isArray(data.series) || data.series.length === 0) return null;
  const kind = slot.dataSemantic?.kind ?? "bar";
  if (kind === "pie") {
    const lines: string[] = ["pie", `    title ${slot.title}`];
    const series = data.series[0];
    if (!series) return null;
    series.values.forEach((value, idx) => {
      const cat = data.categories[idx] ?? `项${idx + 1}`;
      lines.push(`    "${cat}" : ${value}`);
    });
    return lines.join("\n");
  }
  if (kind === "line" || kind === "bar") {
    const lines: string[] = ["xychart-beta", `    title "${slot.title}"`];
    if (data.categories.length > 0) {
      lines.push(`    x-axis [${data.categories.map((c) => `"${c}"`).join(", ")}]`);
    }
    for (const series of data.series) {
      const values = series.values.join(", ");
      lines.push(`    ${kind === "bar" ? "bar" : "line"} [${values}]`);
    }
    return lines.join("\n");
  }
  return null;
}

function ensureMermaidCliAvailable(): boolean {
  try {
    const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["mmdc", "--version"], {
      encoding: "utf8",
      shell: false,
      timeout: 8_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

let mermaidCliAvailable: boolean | null = null;
function isMermaidCliAvailable(): boolean {
  if (mermaidCliAvailable !== null) return mermaidCliAvailable;
  mermaidCliAvailable = ensureMermaidCliAvailable();
  return mermaidCliAvailable;
}

function renderMermaidToPng(diagram: string): Uint8Array | null {
  if (!isMermaidCliAvailable()) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mermaid-"));
  const inputPath = path.join(tmpDir, "diagram.mmd");
  const outputPath = path.join(tmpDir, "diagram.png");
  try {
    fs.writeFileSync(inputPath, diagram, "utf-8");
    const result = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["mmdc", "-i", inputPath, "-o", outputPath, "-b", "white"],
      {
        encoding: "utf8",
        shell: false,
        timeout: 30_000,
      },
    );
    if (result.status !== 0) {
      logger.warn("mermaid render failed", { stderr: result.stderr?.slice(0, 400) });
      return null;
    }
    if (!fs.existsSync(outputPath)) return null;
    return new Uint8Array(fs.readFileSync(outputPath));
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function tryWhiteboardForGantt(input: {
  userId: string;
  slot: Draft["ganttSlots"][number];
}): Promise<RenderedArtifact | null> {
  const plantuml = buildGanttPlantUml(input.slot);
  if (!plantuml) return null;
  try {
    const result = await toolGateway.createWhiteboard(
      {
        title: `${input.slot.task}-甘特`,
        syntax: "plantuml",
        body: plantuml,
      },
      { userId: input.userId, preferUserScope: true },
    );
    return {
      slotId: input.slot.slotId,
      sectionHeading: input.slot.task,
      kind: "whiteboard",
      embedToken: result.whiteboardToken,
      url: result.url,
      source: result.source ?? "lark_cli",
    };
  } catch (error) {
    logger.warn("whiteboard render skipped", {
      slotId: input.slot.slotId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function tryImageFallback(input: {
  userId: string;
  documentId?: string;
  slotId: string;
  sectionHeading: string;
  diagram: string;
  caption?: string;
}): Promise<RenderedArtifact | null> {
  const png = renderMermaidToPng(input.diagram);
  if (!png) return null;
  try {
    const upload = await toolGateway.uploadImageMedia(
      {
        buffer: png,
        fileName: `${input.slotId}.png`,
        parent: input.documentId
          ? { type: "docx_image", documentId: input.documentId }
          : { type: "drive" },
        mimeType: "image/png",
      },
      { userId: input.userId, preferUserScope: true },
    );
    return {
      slotId: input.slotId,
      sectionHeading: input.sectionHeading,
      kind: "image",
      embedToken: upload.mediaToken,
      url: upload.url,
      caption: input.caption,
      source: upload.source ?? "openapi",
    };
  } catch (error) {
    logger.warn("image upload failed for slot", {
      slotId: input.slotId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function renderDraftArtifacts(input: RenderInput): Promise<RenderOutput> {
  const out: RenderedArtifact[] = [];
  const warnings: string[] = [];

  for (const slot of input.draft.ganttSlots ?? []) {
    if (slot.status !== "ready" || !slot.data || slot.data.length === 0) continue;
    const native = await tryWhiteboardForGantt({ userId: input.userId, slot });
    if (native) {
      out.push(native);
      continue;
    }
    const mermaid = buildGanttMermaid(slot);
    if (mermaid) {
      const img = await tryImageFallback({
        userId: input.userId,
        documentId: input.documentId,
        slotId: slot.slotId,
        sectionHeading: slot.task,
        diagram: mermaid,
        caption: slot.task,
      });
      if (img) {
        out.push(img);
        continue;
      }
    }
    warnings.push(`gantt slot ${slot.slotId} fallback to markdown`);
  }

  for (const slot of input.draft.timelineSlots ?? []) {
    if (slot.status !== "ready" || !slot.data || slot.data.length === 0) continue;
    const mermaid = buildTimelineMermaid(slot);
    if (!mermaid) continue;
    const img = await tryImageFallback({
      userId: input.userId,
      documentId: input.documentId,
      slotId: slot.slotId,
      sectionHeading: slot.title,
      diagram: mermaid,
      caption: slot.title,
    });
    if (img) {
      out.push(img);
      continue;
    }
    warnings.push(`timeline slot ${slot.slotId} fallback to markdown`);
  }

  for (const slot of input.draft.chartSlots ?? []) {
    if (slot.status !== "ready" || !slot.data) continue;
    const mermaid = buildChartMermaid(slot);
    if (!mermaid) continue;
    const img = await tryImageFallback({
      userId: input.userId,
      documentId: input.documentId,
      slotId: slot.slotId,
      sectionHeading: slot.title,
      diagram: mermaid,
      caption: slot.title,
    });
    if (img) {
      out.push(img);
      continue;
    }
    warnings.push(`chart slot ${slot.slotId} fallback to markdown`);
  }

  return { artifacts: out, warnings };
}
