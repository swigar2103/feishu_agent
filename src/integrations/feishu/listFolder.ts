import { logger } from "../../shared/logger.js";
import type { FeishuMvpConfig } from "./feishuConfig.js";
import { getTenantAccessToken } from "./token.js";

export type ListedDriveChild = {
  token: string;
  name: string;
  type: string;
  shortcut_info?: { target_token?: string; target_type?: string };
};

type ListFilesResponse = {
  code?: number;
  msg?: string;
  data?: {
    files?: ListedDriveChild[];
    has_more?: boolean;
    next_page_token?: string;
  };
};

/**
 * GET /drive/v1/files 分页列举文件夹直属子节点。
 * @see https://open.feishu.cn/document/server-docs/docs/drive-v1/folder/list
 */
export async function listFolderChildrenPaged(
  c: FeishuMvpConfig,
  folderToken: string,
): Promise<ListedDriveChild[]> {
  const access = await getTenantAccessToken(c);
  const out: ListedDriveChild[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const qs = new URLSearchParams();
    qs.set("folder_token", folderToken);
    qs.set("page_size", "200");
    if (pageToken) qs.set("page_token", pageToken);

    const url = `${c.baseUrl}/open-apis/drive/v1/files?${qs.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
    const data = (await res.json()) as ListFilesResponse;
    if (!res.ok || data.code !== 0) {
      logger.error("飞书 list folder 失败", { status: res.status, data, folderToken });
      throw new Error(
        `飞书 list folder: ${data.msg ?? res.status} (code=${data.code})`,
      );
    }
    out.push(...(data.data?.files ?? []));
    if (!data.data?.has_more) break;
    pageToken = data.data.next_page_token;
    if (!pageToken) break;
  }
  return out;
}

/** 仅保留「正文型」云文档 token：docx 本体与指向 docx 的快捷方式 */
export function pickDocxDocumentTokens(items: ListedDriveChild[], max: number): string[] {
  const tokens: string[] = [];
  for (const f of items) {
    if (tokens.length >= max) break;
    if (f.type === "docx" && f.token) {
      tokens.push(f.token);
      continue;
    }
    if (f.type === "shortcut" && f.shortcut_info?.target_type === "docx") {
      const t = f.shortcut_info.target_token;
      if (t) tokens.push(t);
    }
  }
  return tokens;
}
