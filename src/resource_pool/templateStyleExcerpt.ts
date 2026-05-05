/** 从 Markdown 正文抽取可读 prose，用作「文风摘录」（去掉标题行） */
export function excerptProseFromMarkdown(markdown: string, maxLen: number): string {
  const lines = markdown.split(/\r?\n/);
  const proseLines = lines.filter((line) => {
    const s = line.trim();
    if (!s) return false;
    return !/^#{1,6}\s/.test(s);
  });
  const prose = proseLines.join("\n").replace(/\s+/g, " ").trim();
  return prose.slice(0, maxLen);
}
