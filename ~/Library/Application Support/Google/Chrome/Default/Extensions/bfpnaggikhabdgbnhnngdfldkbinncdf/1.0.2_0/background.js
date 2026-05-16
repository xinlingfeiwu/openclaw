const S = [
  {
    id: 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Origin", operation: "set", value: "http://127.0.0.1:18789" }],
    },
    condition: { urlFilter: "ws://127.0.0.1:18789/*", resourceTypes: ["websocket"] },
  },
  {
    id: 2,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Origin", operation: "set", value: "http://localhost:18789" }],
    },
    condition: { urlFilter: "ws://localhost:18789/*", resourceTypes: ["websocket"] },
  },
];
chrome.runtime.onInstalled.addListener(() => {
  (chrome.runtime
    .setUninstallURL("https://tally.so/r/pbBBWE")
    .catch((e) => console.debug("Set uninstall URL failed", e)),
    chrome.declarativeNetRequest.updateDynamicRules(
      { removeRuleIds: S.map((e) => e.id), addRules: S },
      () => {
        chrome.runtime.lastError
          ? console.error("[OpenClaw Ext] Rule setup failed:", chrome.runtime.lastError)
          : (console.log("[OpenClaw Ext] Rules updated successfully"),
            chrome.declarativeNetRequest.getDynamicRules((e) => {
              console.log("[OpenClaw Ext] Current dynamic rules:", e);
            }));
      },
    ));
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !0 }).catch((t) => console.error(t));
const P = 18792,
  F = {
    on: { text: "ON", color: "#FF5A36" },
    off: { text: "", color: "#000000" },
    connecting: { text: "…", color: "#F59E0B" },
    error: { text: "!", color: "#B91C1C" },
  };
let u = null,
  m = null,
  E = !1,
  v = 1;
const a = new Map(),
  p = new Map(),
  h = new Map(),
  b = new Map();
function A() {
  try {
    return new Error().stack || "";
  } catch {
    return "";
  }
}
async function x() {
  const e = (await chrome.storage.local.get(["relayPort"])).relayPort,
    r = Number.parseInt(String(e || ""), 10);
  return !Number.isFinite(r) || r <= 0 || r > 65535 ? P : r;
}
function g(t, e) {
  const r = F[e];
  (chrome.action.setBadgeText({ tabId: t, text: r.text }),
    chrome.action.setBadgeBackgroundColor({ tabId: t, color: r.color }),
    chrome.action.setBadgeTextColor({ tabId: t, color: "#FFFFFF" }).catch(() => {}));
}
function w(t) {
  chrome.runtime.sendMessage({ type: "RELAY_STATUS", connected: t }).catch(() => {});
}
async function C() {
  if (!(u && u.readyState === WebSocket.OPEN)) {
    if (m) {
      return await m;
    }
    m = (async () => {
      const t = await x(),
        e = `http://127.0.0.1:${t}`,
        r = `ws://127.0.0.1:${t}/extension`;
      try {
        const n = AbortSignal.timeout ? AbortSignal.timeout(2e3) : void 0;
        await fetch(`${e}/`, { method: "HEAD", signal: n });
      } catch (n) {
        throw new Error(`Relay server not reachable at ${e} (${String(n)})`, { cause: n });
      }
      const o = new WebSocket(r);
      ((u = o),
        await new Promise((n, c) => {
          const s = setTimeout(() => c(new Error("WebSocket connect timeout")), 5e3);
          ((o.onopen = () => {
            (clearTimeout(s), n());
          }),
            (o.onerror = () => {
              (clearTimeout(s), c(new Error("WebSocket connect failed")));
            }),
            (o.onclose = (l) => {
              (clearTimeout(s),
                c(new Error(`WebSocket closed (${l.code} ${l.reason || "no reason"})`)));
            }));
        }),
        (o.onmessage = (n) => {
          D(String(n.data || ""));
        }),
        (o.onclose = () => R("closed")),
        (o.onerror = () => R("error")),
        E ||
          ((E = !0),
          chrome.debugger.onEvent.addListener($),
          chrome.debugger.onDetach.addListener(_)));
    })();
    try {
      await m;
    } finally {
      m = null;
    }
  }
}
function R(t) {
  u = null;
  for (const [e, r] of b.entries()) {
    (b.delete(e), r.reject(new Error(`Relay disconnected (${t})`)));
  }
  for (const e of a.keys()) {
    (chrome.debugger.detach({ tabId: e }).catch(() => {}),
      g(e, "connecting"),
      chrome.action.setTitle({
        tabId: e,
        title: "OpenClaw Browser Relay: disconnected (click to re-attach)",
      }));
  }
  (a.clear(), p.clear(), h.clear(), w(!1));
}
function f(t) {
  const e = u;
  if (!e || e.readyState !== WebSocket.OPEN) {
    throw new Error("Relay not connected");
  }
  e.send(JSON.stringify(t));
}
async function D(t) {
  let e;
  try {
    e = JSON.parse(t);
  } catch {
    return;
  }
  if (e && e.method === "ping") {
    try {
      f({ method: "pong" });
    } catch {}
    return;
  }
  if (e && typeof e.id == "number" && (e.result !== void 0 || e.error !== void 0)) {
    const r = b.get(e.id);
    if (!r) {
      return;
    }
    (b.delete(e.id), e.error ? r.reject(new Error(String(e.error))) : r.resolve(e.result));
    return;
  }
  if (e && typeof e.id == "number" && e.method === "forwardCDPCommand") {
    try {
      const r = await U(e);
      f({ id: e.id, result: r });
    } catch (r) {
      f({ id: e.id, error: r instanceof Error ? r.message : String(r) });
    }
  }
}
function N(t) {
  const e = p.get(t);
  if (e) {
    return { tabId: e, kind: "main" };
  }
  const r = h.get(t);
  return r ? { tabId: r, kind: "child" } : null;
}
function T(t) {
  for (const [e, r] of a.entries()) {
    if (r.targetId === t) {
      return e;
    }
  }
  return null;
}
async function k(t, e = {}) {
  const r = { tabId: t };
  (await chrome.debugger.attach(r, "1.3"),
    await chrome.debugger.sendCommand(r, "Page.enable").catch(() => {}));
  const n = (await chrome.debugger.sendCommand(r, "Target.getTargetInfo"))?.targetInfo,
    c = String(n?.targetId || "").trim();
  if (!c) {
    throw new Error("Target.getTargetInfo returned no targetId");
  }
  const s = `cb-tab-${v++}`,
    l = v;
  return (
    a.set(t, { state: "connected", sessionId: s, targetId: c, attachOrder: l }),
    p.set(s, t),
    chrome.action.setTitle({
      tabId: t,
      title: "OpenClaw Browser Relay: attached (click to detach)",
    }),
    e.skipAttachedEvent ||
      f({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: { sessionId: s, targetInfo: { ...n, attached: !0 }, waitingForDebugger: !1 },
        },
      }),
    g(t, "on"),
    w(!0),
    { sessionId: s, targetId: c }
  );
}
async function B(t, e) {
  const r = a.get(t);
  if (r?.sessionId && r?.targetId) {
    try {
      f({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: r.sessionId, targetId: r.targetId, reason: e },
        },
      });
    } catch {}
  }
  (r?.sessionId && p.delete(r.sessionId), a.delete(t));
  for (const [o, n] of h.entries()) {
    n === t && h.delete(o);
  }
  try {
    await chrome.debugger.detach({ tabId: t });
  } catch {}
  (g(t, "off"),
    chrome.action.setTitle({ tabId: t, title: "OpenClaw Browser Relay (click to attach/detach)" }),
    w(!1));
}
async function W() {
  const [t] = await chrome.tabs.query({ active: !0, currentWindow: !0 }),
    e = t?.id;
  if (!e) {
    return;
  }
  if (
    t.url &&
    (t.url.startsWith("chrome://") ||
      t.url.startsWith("edge://") ||
      t.url.startsWith("devtools://") ||
      (t.url.startsWith("about:") && t.url !== "about:blank"))
  ) {
    (g(e, "error"),
      chrome.action.setTitle({
        tabId: e,
        title: "OpenClaw Browser Relay: Cannot attach to restricted system pages.",
      }),
      console.warn("attach failed: restricted URL", t.url),
      w(!1));
    return;
  }
  if (a.get(e)?.state === "connected") {
    await B(e, "toggle");
    return;
  }
  (a.set(e, { state: "connecting" }),
    g(e, "connecting"),
    chrome.action.setTitle({
      tabId: e,
      title: "OpenClaw Browser Relay: connecting to local relay…",
    }));
  try {
    (await C(), await k(e));
  } catch (o) {
    (a.delete(e),
      g(e, "error"),
      chrome.action.setTitle({
        tabId: e,
        title: "OpenClaw Browser Relay: relay not running (open options for setup)",
      }));
    const n = o instanceof Error ? o.message : String(o);
    (console.warn("attach failed", n, A()), w(!1));
  }
}
async function U(t) {
  const e = String(t?.params?.method || "").trim(),
    r = t?.params?.params || void 0,
    o = typeof t?.params?.sessionId == "string" ? t.params.sessionId : void 0,
    n = o ? N(o) : null,
    c = typeof r?.targetId == "string" ? r.targetId : void 0,
    s =
      n?.tabId ||
      (c ? T(c) : null) ||
      (() => {
        for (const [i, d] of a.entries()) {
          if (d.state === "connected") {
            return i;
          }
        }
        return null;
      })();
  if (!s) {
    throw new Error(`No attached tab for method ${e}`);
  }
  const l = { tabId: s };
  if (e === "Runtime.enable") {
    try {
      (await chrome.debugger.sendCommand(l, "Runtime.disable"),
        await new Promise((i) => setTimeout(i, 50)));
    } catch {}
    return await chrome.debugger.sendCommand(l, "Runtime.enable", r);
  }
  if (e === "Target.createTarget") {
    const i = typeof r?.url == "string" ? r.url : "about:blank",
      d = await chrome.tabs.create({ url: i, active: !1 });
    if (!d.id) {
      throw new Error("Failed to create tab");
    }
    return (await new Promise((O) => setTimeout(O, 100)), { targetId: (await k(d.id)).targetId });
  }
  if (e === "Target.closeTarget") {
    const i = typeof r?.targetId == "string" ? r.targetId : "",
      d = i ? T(i) : s;
    if (!d) {
      return { success: !1 };
    }
    try {
      await chrome.tabs.remove(d);
    } catch {
      return { success: !1 };
    }
    return { success: !0 };
  }
  if (e === "Target.activateTarget") {
    const i = typeof r?.targetId == "string" ? r.targetId : "",
      d = i ? T(i) : s;
    if (!d) {
      return {};
    }
    const y = await chrome.tabs.get(d).catch(() => null);
    return y
      ? (y.windowId && (await chrome.windows.update(y.windowId, { focused: !0 }).catch(() => {})),
        await chrome.tabs.update(d, { active: !0 }).catch(() => {}),
        {})
      : {};
  }
  const I = a.get(s)?.sessionId,
    L = o && I && o !== I ? { ...l, sessionId: o } : l;
  return await chrome.debugger.sendCommand(L, e, r);
}
function $(t, e, r) {
  const o = t.tabId;
  if (!o) {
    return;
  }
  const n = a.get(o);
  if (n?.sessionId) {
    (e === "Target.attachedToTarget" && r?.sessionId && h.set(String(r.sessionId), o),
      e === "Target.detachedFromTarget" && r?.sessionId && h.delete(String(r.sessionId)));
    try {
      f({
        method: "forwardCDPEvent",
        params: { sessionId: t.sessionId || n.sessionId, method: e, params: r },
      });
    } catch {}
  }
}
function _(t, e) {
  const r = t.tabId;
  r && a.has(r) && B(r, e);
}
chrome.runtime.onMessage.addListener((t, e, r) => {
  if (t.type === "TOGGLE_RELAY") {
    (t.port && chrome.storage.local.set({ relayPort: t.port }), W());
  } else {
    if (t.type === "TEST_RELAY") {
      return (
        (async () => {
          try {
            (t.port && (await chrome.storage.local.set({ relayPort: t.port })),
              u && (u.close(), (u = null)),
              await C(),
              r({ success: !0 }));
          } catch (o) {
            r({ success: !1, error: o instanceof Error ? o.message : String(o) });
          }
        })(),
        !0
      );
    }
    if (t.type === "GET_RELAY_STATUS") {
      return (
        chrome.tabs.query({ active: !0, currentWindow: !0 }).then(([o]) => {
          const n = o?.id,
            c = n && a.has(n) && a.get(n).state === "connected";
          r({ connected: !!c });
        }),
        !0
      );
    }
  }
});
