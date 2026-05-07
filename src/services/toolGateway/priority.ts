import type { GatewayCapability } from "./capabilities.js";

export type GatewayAdapterName = "mcp" | "lark_cli" | "openapi";

const DEFAULT_ORDER: GatewayAdapterName[] = ["mcp", "lark_cli", "openapi"];

const CAPABILITY_ORDER: Partial<Record<GatewayCapability, GatewayAdapterName[]>> = {
  "document.search": ["mcp", "lark_cli", "openapi"],
  "document.list": ["mcp", "lark_cli", "openapi"],
  "document.view": ["mcp", "lark_cli", "openapi"],
  "document.fileContent": ["mcp", "lark_cli", "openapi"],
  "document.create": ["mcp", "lark_cli", "openapi"],
  "document.update": ["mcp", "lark_cli", "openapi"],
  "document.comment.list": ["mcp", "lark_cli", "openapi"],
  "document.comment.add": ["mcp", "lark_cli", "openapi"],
  "user.search": ["mcp", "lark_cli", "openapi"],
  "user.get": ["mcp", "lark_cli", "openapi"],
  "slides.create": ["mcp", "lark_cli", "openapi"],
  "whiteboard.query": ["mcp", "lark_cli", "openapi"],
  "whiteboard.update": ["mcp", "lark_cli", "openapi"],
  "message.send": ["mcp", "lark_cli", "openapi"],
  "message.list": ["mcp", "lark_cli", "openapi"],
  "drive.root.meta": ["openapi", "lark_cli", "mcp"],
  "drive.folder.meta": ["openapi", "lark_cli", "mcp"],
  "drive.folder.list": ["openapi", "lark_cli", "mcp"],
  "drive.folder.create": ["openapi", "lark_cli", "mcp"],
  "drive.file.move": ["openapi", "lark_cli", "mcp"],
  "drive.file.copy": ["openapi", "lark_cli", "mcp"],
  "drive.file.delete": ["openapi", "lark_cli", "mcp"],
  "drive.task.check": ["openapi", "lark_cli", "mcp"],
  "media.upload.image": ["openapi", "lark_cli", "mcp"],
  "docx.block.image.insert": ["openapi", "lark_cli", "mcp"],
  "docx.block.embed.insert": ["openapi", "lark_cli", "mcp"],
  "sheet.create": ["lark_cli", "openapi", "mcp"],
  "sheet.write": ["lark_cli", "openapi", "mcp"],
  "sheet.chart.create": ["lark_cli", "openapi", "mcp"],
  "whiteboard.create": ["lark_cli", "openapi", "mcp"],
};

export function getAdapterPriority(capability: GatewayCapability): GatewayAdapterName[] {
  return CAPABILITY_ORDER[capability] ?? DEFAULT_ORDER;
}

