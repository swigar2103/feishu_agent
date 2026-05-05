# Word 模板占位（阶段 B 扩展）

当前导出仍使用 `docx` **程序化生成**；蒸馏画像中的 `wordExportHints.dotxRelativePath` 可指向本目录下的 `.dotx` 壳文件（例如 `report-shell.dotx`），便于后续接入：

- **docxtemplater**（占位符替换）
- 或 **Open XML SDK** / **python-docx** 合并样式

在未接入合并逻辑前，`wordExport.ts` 若检测到路径对应文件存在，仅打印日志提示，不改变导出行为。

建议壳模板内预置：

- 标题 1 / 标题 2 / 正文 / 编号列表样式名称与业务约定一致；
- 预留内容控件（Structured Document Tags）对应各小节。
