/* global marked */

const el = (id) => document.getElementById(id);

let sessionId = null;
let hasLatestReport = false;
/** @type {string[]} */
let pendingMentions = [];
/** Cursor 式对话选区上下文，发送时进入 extraContext */
/** @type {object[]} */
let pendingSelectionContexts = [];
let msgCounter = 0;

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 报告链路可能较慢；超时后 UI 可恢复，避免一直停留在「生成中」 */
const DEFAULT_API_TIMEOUT_MS = 600_000;

async function api(path, options = {}) {
  const { timeoutMs = DEFAULT_API_TIMEOUT_MS, ...fetchOpts } = options;
  const ctrl = new AbortController();
  const timer =
    timeoutMs > 0
      ? setTimeout(() => ctrl.abort(), timeoutMs)
      : null;
  try {
    const baseHeaders = { ...(fetchOpts.headers || {}) };
    const body = fetchOpts.body;
    const hasBody =
      body !== undefined &&
      body !== null &&
      (typeof body !== "string" || body.length > 0);
    if (
      hasBody &&
      !baseHeaders["Content-Type"] &&
      !baseHeaders["content-type"]
    ) {
      baseHeaders["Content-Type"] = "application/json; charset=utf-8";
    }

    const res = await fetch(path, {
      ...fetchOpts,
      signal: ctrl.signal,
      headers: baseHeaders,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new Error(data.message || res.statusText || String(res.status));
    }
    return data;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        "请求超时（报告生成耗时过长）。可检查百炼/网络，或稍后重试。",
      );
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function renderMarkdown(md) {
  if (window.marked && typeof marked.parse === "function") {
    return marked.parse(md, { breaks: true });
  }
  return `<pre class="plain-md">${escapeHtml(md)}</pre>`;
}

function appendMessage(role, htmlOrText, isMarkdown) {
  const wrap = el("messages");
  const div = document.createElement("div");
  const idx = msgCounter++;
  div.className = `msg ${role}`;
  div.dataset.msgIndex = String(idx);
  div.dataset.role = role;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = role === "user" ? "你" : "助手";
  div.appendChild(meta);
  const body = document.createElement("div");
  body.className = "msg-body";
  if (isMarkdown) body.innerHTML = htmlOrText;
  else body.innerHTML = `<p>${escapeHtml(htmlOrText).replace(/\n/g, "<br/>")}</p>`;
  div.appendChild(body);
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function setStatus(t) {
  el("chatStatus").textContent = t;
}

function updateIncButton() {
  el("btnSendInc").disabled = !hasLatestReport;
}

async function refreshSessionList() {
  const uid = el("chatUserId").value.trim();
  if (!uid) return [];
  try {
    const { sessions } = await api(`/api/chat/sessions?userId=${encodeURIComponent(uid)}`, {
      timeoutMs: 30_000,
    });
    const list = sessions || [];
    const box = el("sessionList");
    box.innerHTML = "";
    for (const s of list) {
      const row = document.createElement("div");
      row.className = "session-row";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "session-item" + (s.sessionId === sessionId ? " active" : "");
      btn.textContent = `${s.preview}`;
      btn.title = s.sessionId;
      btn.addEventListener("click", () => loadSession(s.sessionId));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn-del";
      del.textContent = "删除";
      del.title = "删除此对话";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void removeSession(s.sessionId);
      });

      row.appendChild(btn);
      row.appendChild(del);
      box.appendChild(row);
    }
    return list;
  } catch {
    return [];
  }
}

async function removeSession(sid) {
  const uid = el("chatUserId").value.trim();
  if (!uid) return;
  if (!window.confirm("确定删除该对话？不可恢复。")) return;
  try {
    let wasEmpty = false;
    try {
      const data = await api(
        `/api/chat/sessions/${encodeURIComponent(sid)}`,
        { timeoutMs: 30_000 },
      );
      wasEmpty = !data.messages || data.messages.length === 0;
    } catch {
      wasEmpty = true;
    }

    await api(
      `/api/chat/sessions/${encodeURIComponent(sid)}?userId=${encodeURIComponent(uid)}`,
      { method: "DELETE", timeoutMs: 30_000 },
    );

    if (sessionId === sid) {
      sessionId = null;
      hasLatestReport = false;
      el("messages").innerHTML = "";
      pendingMentions = [];
      pendingSelectionContexts = [];
      renderChips();
      renderContextChips();
      updateIncButton();

      const list = await refreshSessionList();

      if (wasEmpty) {
        if (list.length > 0) {
          await loadSession(list[0].sessionId);
        } else {
          setStatus("就绪");
        }
      } else if (list.length > 0) {
        await loadSession(list[0].sessionId);
      } else {
        await createSession();
      }
    } else {
      await refreshSessionList();
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  }
}

/** 无会话时自动创建（用户可直接输入发送） */
async function ensureSession() {
  const uid = el("chatUserId").value.trim();
  if (!uid) {
    throw new Error("请填写用户 ID");
  }
  if (sessionId) return sessionId;
  setStatus("创建会话…");
  const { sessionId: sid } = await api("/api/chat/sessions", {
    method: "POST",
    body: JSON.stringify({ userId: uid }),
    timeoutMs: 30_000,
  });
  sessionId = sid;
  hasLatestReport = false;
  pendingMentions = [];
  renderChips();
  updateIncButton();
  setStatus("就绪");
  await refreshSessionList();
  return sid;
}

async function loadSession(sid) {
  sessionId = sid;
  hasLatestReport = false;
  pendingMentions = [];
  pendingSelectionContexts = [];
  msgCounter = 0;
  renderChips();
  renderContextChips();
  el("messages").innerHTML = "";
  setStatus("加载会话…");
  try {
    const data = await api(`/api/chat/sessions/${encodeURIComponent(sid)}`, {
      timeoutMs: 60_000,
    });
    hasLatestReport =
      Boolean(data.latestReport) ||
      (data.messages || []).some((m) => m.role === "assistant");
    for (const m of data.messages || []) {
      if (m.role === "user") {
        appendMessage("user", m.content, false);
      } else {
        appendMessage("assistant", renderMarkdown(m.content), true);
      }
    }
    updateIncButton();
    setStatus("就绪");
  } catch (e) {
    setStatus("加载失败");
    appendMessage("assistant", escapeHtml(String(e.message)), false);
  }
  refreshSessionList();
}

function renderChips() {
  const box = el("mentionChips");
  box.innerHTML = "";
  for (const id of pendingMentions) {
    const span = document.createElement("span");
    span.className = "chip";
    span.textContent = id;
    box.appendChild(span);
  }
}

function renderContextChips() {
  const box = el("contextChips");
  if (!box) return;
  box.innerHTML = "";
  pendingSelectionContexts.forEach((c) => {
    const row = document.createElement("span");
    row.className = "chip-row";
    const span = document.createElement("span");
    span.className = "chip chip-context";
    span.textContent = `${c.pseudoPath} · L${c.lineStart}–${c.lineEnd} · ${c.language}`;
    span.title = c.snippet.slice(0, 900);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-remove";
    rm.setAttribute("aria-label", "移除引用");
    rm.textContent = "×";
    rm.addEventListener("click", (ev) => {
      ev.preventDefault();
      const rid = c.id;
      pendingSelectionContexts = pendingSelectionContexts.filter((x) => x.id !== rid);
      renderContextChips();
    });
    row.appendChild(span);
    row.appendChild(rm);
    box.appendChild(row);
  });
}

async function createSession() {
  const uid = el("chatUserId").value.trim();
  if (!uid) {
    alert("请填写用户 ID");
    return;
  }
  setStatus("创建会话…");
  const { sessionId: sid } = await api("/api/chat/sessions", {
    method: "POST",
    body: JSON.stringify({ userId: uid }),
    timeoutMs: 30_000,
  });
  sessionId = sid;
  hasLatestReport = false;
  pendingMentions = [];
  pendingSelectionContexts = [];
  msgCounter = 0;
  el("messages").innerHTML = "";
  renderChips();
  renderContextChips();
  updateIncButton();
  setStatus("新会话已创建");
  refreshSessionList();
}

async function sendTurn(revisionMode) {
  const text = el("chatInput").value.trim();
  if (!text && pendingSelectionContexts.length === 0) return;

  try {
    await ensureSession();
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
    return;
  }

  const displayUser =
    text || (pendingSelectionContexts.length > 0 ? "（已附带对话区引用）" : text);
  appendMessage("user", displayUser, false);
  el("chatInput").value = "";
  setStatus("生成中…");
  el("btnSendFull").disabled = true;
  el("btnSendInc").disabled = true;

  try {
    const payloadContexts = pendingSelectionContexts.map(({ id: _id, ...rest }) => rest);
    const payload = {
      content: text,
      revisionMode,
      mentionedResourceIds: [...pendingMentions],
      selectionContexts: payloadContexts,
    };
    const out = await api(
      `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    appendMessage("assistant", renderMarkdown(out.assistantMarkdown), true);
    hasLatestReport = true;
    pendingMentions = [];
    pendingSelectionContexts = [];
    renderChips();
    renderContextChips();
    setStatus("就绪");
  } catch (e) {
    appendMessage("assistant", escapeHtml(String(e.message)), false);
    setStatus("失败");
  } finally {
    el("btnSendFull").disabled = false;
    updateIncButton();
  }
  refreshSessionList();
}

let mentionTimer = null;
async function openMentions(query) {
  const uid = el("chatUserId").value.trim() || "user_demo_primary";
  const wrap = el("mentionWrap");
  const list = el("mentionList");
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(async () => {
    try {
      const { items } = await api(
        `/api/resource-pool/mentions?userId=${encodeURIComponent(uid)}&q=${encodeURIComponent(query)}`,
      );
      list.innerHTML = "";
      if (!items || items.length === 0) {
        wrap.classList.add("hidden");
        return;
      }
      for (const it of items.slice(0, 20)) {
        const li = document.createElement("li");
        li.textContent = `${it.resourceId} — ${it.title}`;
        li.addEventListener("click", () => {
          if (!pendingMentions.includes(it.resourceId)) {
            pendingMentions.push(it.resourceId);
            renderChips();
          }
          wrap.classList.add("hidden");
        });
        list.appendChild(li);
      }
      wrap.classList.remove("hidden");
    } catch {
      wrap.classList.add("hidden");
    }
  }, 200);
}

function setupMentionTrigger() {
  const ta = el("chatInput");
  ta.addEventListener("input", () => {
    const v = ta.value;
    const m = /@([^\s@]*)$/.exec(v.slice(0, ta.selectionStart));
    if (m) {
      openMentions(m[1] || "");
    } else {
      el("mentionWrap").classList.add("hidden");
    }
  });
}

function findMsgBubble(node) {
  const messagesEl = el("messages");
  if (!node || !messagesEl) return null;
  let n = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (n) {
    if (n.classList?.contains("msg") && n.parentElement === messagesEl) return n;
    n = n.parentElement;
  }
  return null;
}

function getLineRangeInRoot(root, range) {
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const beforeText = before.toString();
  const selected = range.toString();
  const startLine = beforeText.split("\n").length;
  const endLine = startLine + Math.max(0, selected.split("\n").length - 1);
  return { startLine, endLine };
}

function detectSelectionLanguage(range) {
  let node = range.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const bubble = findMsgBubble(range.commonAncestorContainer);
  while (node && node !== bubble) {
    if (node.tagName === "CODE") {
      const cls = node.className || "";
      const m = cls.match(/language-([\w-]+)/);
      return m ? m[1] : "text";
    }
    node = node.parentElement;
  }
  return bubble?.dataset?.role === "assistant" ? "markdown" : "text";
}

function buildChatSelectionContext(sel) {
  const range = sel.getRangeAt(0);
  const aBubble = findMsgBubble(sel.anchorNode);
  const fBubble = findMsgBubble(sel.focusNode);
  if (!aBubble || !fBubble || aBubble !== fBubble) return null;
  const body = aBubble.querySelector(".msg-body");
  if (!body) return null;
  const snippet = sel.toString();
  if (!snippet.trim()) return null;
  const role = aBubble.dataset.role === "user" ? "user" : "assistant";
  const msgIndex = Number(aBubble.dataset.msgIndex ?? "0");
  const sid = sessionId || "local";
  const { startLine, endLine } = getLineRangeInRoot(body, range);
  const language = detectSelectionLanguage(range);
  const pseudoPath = `chat://${sid}/${role}#m${msgIndex}`;
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return {
    id,
    source: "chat",
    pseudoPath,
    language,
    lineStart: startLine,
    lineEnd: endLine,
    snippet: snippet.slice(0, 12_000),
    role,
    messageIndex: msgIndex,
  };
}

/** pendingSelectionPreview：浮层展示前校验后的上下文 */
let pendingSelectionPreview = null;

function isNodeInsideMessages(node) {
  const box = el("messages");
  if (!box || !node) return false;
  let n = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (n) {
    if (n === box) return true;
    n = n.parentElement;
  }
  return false;
}

function hideSelectionToolbar() {
  const t = el("selectionToolbar");
  if (t) t.classList.add("hidden");
  pendingSelectionPreview = null;
}

function ensureSelectionToolbar() {
  let bar = el("selectionToolbar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "selectionToolbar";
    bar.className = "selection-toolbar hidden";
    bar.setAttribute("role", "toolbar");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "selection-toolbar-btn";
    btn.textContent = "加入 Chat";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const ctx = pendingSelectionPreview;
      if (!ctx) return;
      pendingSelectionContexts.push(ctx);
      renderContextChips();
      hideSelectionToolbar();
      window.getSelection()?.removeAllRanges();
      el("chatInput")?.focus();
    });
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }
  return bar;
}

function positionSelectionToolbar(rect, toolbar) {
  const centerX = rect.left + rect.width / 2;
  const x = Math.max(40, Math.min(centerX, window.innerWidth - 40));
  if (rect.top < 52) {
    toolbar.style.left = `${x}px`;
    toolbar.style.top = `${rect.bottom + 8}px`;
    toolbar.style.transform = "translateX(-50%)";
  } else {
    toolbar.style.left = `${x}px`;
    toolbar.style.top = `${rect.top}px`;
    toolbar.style.transform = "translate(-50%, calc(-100% - 6px))";
  }
}

function updateSelectionToolbar() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hideSelectionToolbar();
    return;
  }
  const anchor = sel.anchorNode;
  const focus = sel.focusNode;
  if (!isNodeInsideMessages(anchor) || !isNodeInsideMessages(focus)) {
    hideSelectionToolbar();
    return;
  }
  const ctx = buildChatSelectionContext(sel);
  if (!ctx) {
    hideSelectionToolbar();
    return;
  }
  pendingSelectionPreview = ctx;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideSelectionToolbar();
    return;
  }
  const toolbar = ensureSelectionToolbar();
  positionSelectionToolbar(rect, toolbar);
  toolbar.classList.remove("hidden");
}

function setupSelectionToChat() {
  document.addEventListener(
    "mouseup",
    () => requestAnimationFrame(updateSelectionToolbar),
    true,
  );

  document.addEventListener("mousedown", (e) => {
    const bar = el("selectionToolbar");
    if (!bar || bar.classList.contains("hidden")) return;
    const target = e.target;
    if (bar.contains(target)) return;
    if (el("messages") && el("messages").contains(target)) return;
    hideSelectionToolbar();
  });

  const msgBox = el("messages");
  if (msgBox) {
    msgBox.addEventListener("scroll", hideSelectionToolbar, { passive: true });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideSelectionToolbar();
  });

  window.addEventListener(
    "resize",
    () => {
      hideSelectionToolbar();
    },
    { passive: true },
  );
}

function bindChatUi() {
  const bNew = el("btnNewSession");
  const bFull = el("btnSendFull");
  const bInc = el("btnSendInc");
  if (!bNew || !bFull || !bInc || !el("messages") || !el("chatStatus")) {
    console.error("[chat] 缺少必要 DOM 节点");
    return;
  }

  bNew.addEventListener("click", async () => {
    try {
      await createSession();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(msg);
      setStatus("失败");
    }
  });
  bFull.addEventListener("click", async () => {
    try {
      await sendTurn("full");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(msg);
    }
  });
  bInc.addEventListener("click", async () => {
    try {
      await sendTurn("incremental");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(msg);
    }
  });

  setupMentionTrigger();
  setupSelectionToChat();
  updateIncButton();

  if (el("chatUserId")) {
    el("chatUserId").addEventListener("change", async () => {
      try {
        await refreshSessionList();
        await createSession();
      } catch (e) {
        console.error(e);
      }
    });
  }

  if (typeof marked !== "undefined" && marked.setOptions) {
    marked.setOptions({ mangle: false, headerIds: false });
  }

  void bootstrapChat();
}

async function bootstrapChat() {
  const uid = el("chatUserId")?.value?.trim();
  if (!uid) {
    setStatus("请填写用户 ID");
    return;
  }
  try {
    await createSession();
  } catch (e) {
    console.error(e);
    setStatus("无法自动创建会话，请点击「新对话」");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindChatUi);
} else {
  bindChatUi();
}