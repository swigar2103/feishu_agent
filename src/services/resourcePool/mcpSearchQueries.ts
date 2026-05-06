/**
 * 飞书 MCP search-doc 更适合「关键词」式查询（官方示例多为短句）。
 * 用户整段任务描述直接搜索时容易 0 条，故拆成若干短查询合并去重。
 */
export function deriveMcpDocumentSearchQueries(fullPrompt: string): string[] {
  const t = fullPrompt.trim().replace(/\s+/g, " ");
  const out: string[] = [];
  const add = (s: string) => {
    const x = s.trim();
    if (x.length < 2) return;
    if (!out.includes(x)) out.push(x);
  };

  if (t.length <= 100) add(t);
  else add(t.slice(0, 100));

  const patterns: RegExp[] = [
    /第\s*\d+\s*周[^，。！？\n]{0,50}/,
    /院周会[^，。！？\n]{0,40}/,
    /会议纪要[^，。！？\n]{0,35}/,
    /周报[^，。！？\n]{0,50}/,
    /（[^）]{2,40}院区[^）]{0,15}）/,
    /[\u4e00-\u9fff·]{2,22}院区/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) add(m[0]);
  }

  let core = t
    .replace(/^请根据/, "")
    .replace(/^请结合/, "")
    .replace(/，\s*写一份[\s\S]+$/, "")
    .replace(/写一份[\s\S]+$/, "")
    .trim();
  if (core.length >= 6 && core.length <= 120) add(core);

  return out.slice(0, 6);
}
