/**
 * MCP create-doc / fetch-doc / update-doc 响应解析回归（README §12.5 P2）
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  extractCreateDocMetaFromUnknown,
  extractFetchDocBodyFromUnknown,
  extractSearchDocListFromUnknown,
  interpretMcpUpdateDocResult,
  mcpSearchDocResponseIndicatesScopeGap,
} from "./mcpResponseParse.js";
import { deriveMcpDocumentSearchQueries } from "../resourcePool/mcpSearchQueries.js";

test("create-doc: 飞书扁平 doc_id + doc_url + message，title 用入参兜底", () => {
  const raw = {
    doc_id: "Abc123",
    doc_url: "https://www.feishu.cn/docx/Abc123",
    message: "文档创建成功",
  };
  const r = extractCreateDocMetaFromUnknown(raw, "我的标题");
  assert.ok(r);
  assert.equal(r!.id, "Abc123");
  assert.equal(r!.title, "我的标题");
  assert.equal(r!.url, "https://www.feishu.cn/docx/Abc123");
});

test("create-doc: 嵌套 data.document", () => {
  const raw = { data: { document: { document_id: "X1", title: "内嵌", url: "https://x/docx/X1" } } };
  const r = extractCreateDocMetaFromUnknown(raw);
  assert.ok(r);
  assert.equal(r!.id, "X1");
  assert.equal(r!.title, "内嵌");
});

test("create-doc: 缺 id 返回 null", () => {
  assert.equal(extractCreateDocMetaFromUnknown({ title: "仅标题", url: "http://u" }, "t"), null);
});

test("create-doc: 无 fallbackTitle 且无 API title 时 null", () => {
  assert.equal(extractCreateDocMetaFromUnknown({ doc_id: "Z" }), null);
});

test("fetch-doc: content", () => {
  assert.equal(extractFetchDocBodyFromUnknown({ content: "hello" }), "hello");
});

test("fetch-doc: 同层 content 短、markdown 长时取长正文", () => {
  const long = "x".repeat(500);
  assert.equal(extractFetchDocBodyFromUnknown({ content: "hi", markdown: long }), long);
});

test("fetch-doc: blocks 数组抽取 docx 块文本", () => {
  const raw = {
    blocks: [
      { block_type: 2, text: { elements: [{ text_run: { content: "第一节" } }] } },
      { block_type: 4, heading2: { elements: [{ text_run: { content: "标题二" } }] } },
    ],
  };
  const body = extractFetchDocBodyFromUnknown(raw);
  assert.ok(body.includes("第一节"));
  assert.ok(body.includes("标题二"));
});

test("fetch-doc: nested markdown field", () => {
  const md = "# Title\nBody";
  assert.equal(extractFetchDocBodyFromUnknown({ data: { markdown: md } }), md);
});

test("fetch-doc: 空对象", () => {
  assert.equal(extractFetchDocBodyFromUnknown({}), "");
});

test("update-doc: ok true", () => {
  assert.equal(interpretMcpUpdateDocResult({ ok: true }), true);
});

test("update-doc: success false", () => {
  assert.equal(interpretMcpUpdateDocResult({ success: false }), false);
});

test("update-doc: 裸 false", () => {
  assert.equal(interpretMcpUpdateDocResult(false), false);
});

test("update-doc: null 视为 false", () => {
  assert.equal(interpretMcpUpdateDocResult(null), false);
});

test("update-doc: 空对象或含糊 message 视为 false（避免误判成功）", () => {
  assert.equal(interpretMcpUpdateDocResult({}), false);
  assert.equal(interpretMcpUpdateDocResult({ message: "done" }), false);
});

test("update-doc: 飞书式 code=0", () => {
  assert.equal(interpretMcpUpdateDocResult({ code: 0, msg: "success" }), true);
});

test("update-doc: 嵌套 data.code=0", () => {
  assert.equal(interpretMcpUpdateDocResult({ data: { code: 0 } }), true);
});

test("update-doc: revision_id 视为成功", () => {
  assert.equal(interpretMcpUpdateDocResult({ revision_id: "r1" }), true);
});

test("update-doc: error_code=0", () => {
  assert.equal(interpretMcpUpdateDocResult({ error_code: 0 }), true);
});

test("update-doc: JSON 字符串 code=0", () => {
  assert.equal(interpretMcpUpdateDocResult('{"code":0}'), true);
});

test("search-doc: docs 数组", () => {
  const r = extractSearchDocListFromUnknown({ docs: [{ id: "a", title: "t" }] });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.id, "a");
});

test("search-doc: documents + document_id", () => {
  const r = extractSearchDocListFromUnknown({
    documents: [{ document_id: "b", name: "n" }],
  });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.id, "b");
  assert.equal(r[0]!.title, "n");
});

test("search-doc: 嵌套 data.files file_token", () => {
  const r = extractSearchDocListFromUnknown({
    data: { files: [{ file_token: "c", title: "x" }] },
  });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.id, "c");
});

test("deriveMcpDocumentSearchQueries: 院周会/周报拆词", () => {
  const q =
    "请根据本周院周会纪要与第17周医疗运营周报（华章义远·滨江院区），写一份运营分析摘要。";
  const list = deriveMcpDocumentSearchQueries(q);
  assert.ok(list.some((s) => s.includes("院周会")));
  assert.ok(list.some((s) => /第\s*17\s*周/.test(s) || s.includes("第17周")));
});

test("mcpSearchDocResponseIndicatesScopeGap: 命中 search:docs:read", () => {
  assert.equal(
    mcpSearchDocResponseIndicatesScopeGap(
      "failed to search docs: Unauthorized ... [search:docs:read]",
    ),
    true,
  );
  assert.equal(mcpSearchDocResponseIndicatesScopeGap({ ok: true, docs: [] }), false);
});
