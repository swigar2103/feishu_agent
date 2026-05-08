import type { GatewayCapability } from "./capabilities.js";

export type GatewayAdapterName = "mcp" | "lark_cli" | "openapi";

const DEFAULT_ORDER: GatewayAdapterName[] = ["mcp", "lark_cli", "openapi"];

const CAPABILITY_ORDER: Partial<Record<GatewayCapability, GatewayAdapterName[]>> = {
  "document.search": ["mcp", "lark_cli", "openapi"],
  "document.list": ["mcp", "lark_cli", "openapi"],
  // openapi 优先：走 raw_content API（UAT 读真实正文），MCP 作 fallback（仅返回 ~200 字元数据）
  "document.view": ["openapi", "mcp", "lark_cli"],
  "document.fileContent": ["mcp", "lark_cli", "openapi"],
  "document.outline": ["lark_cli", "mcp", "openapi"],
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
  "media.upload.image": ["mcp", "openapi", "lark_cli"],
  "docx.block.image.insert": ["mcp", "openapi", "lark_cli"],
  "docx.block.embed.insert": ["mcp", "openapi", "lark_cli"],
  "sheet.create": ["lark_cli", "openapi", "mcp"],
  "sheet.write": ["lark_cli", "openapi", "mcp"],
  "sheet.chart.create": ["lark_cli", "openapi", "mcp"],
  "whiteboard.create": ["mcp", "lark_cli", "openapi"],
};

export function getAdapterPriority(capability: GatewayCapability): GatewayAdapterName[] {
  return CAPABILITY_ORDER[capability] ?? DEFAULT_ORDER;
}

