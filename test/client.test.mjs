/**
 * dsh-session-cost — client bundle tests（浏览器侧行为）。
 *
 * 手写的客户端 bundle 没有构建步骤，因此这里在 Node 里把它当作它本来的样子执行：
 * 造一个 `window.__ModuleLoader__` 门面接住工厂，用 jsdom 提供 DOM，再用真实
 * react / react-dom 渲染组件。覆盖：
 * 1. 角标被门户进官方信息栏那一行（`[data-composer-stats]`）的右端，而不是自己占一行；
 * 2. 点开角标 → 明细菜单（当前单价、下一处峰谷切换、用量、模型路由）；
 * 3. 外部点击 / Esc 关闭菜单；
 * 4. 官方信息栏不存在时退回自己的 dock 行；
 * 5. 没有已计费用量、或会话含未支持模型时不占位；
 * 6. 英文界面 → 美元与英文文案；官方 locale 服务注入的 `t` 优先于内置字典。
 *
 * 运行：node --test（缺 jsdom / react 时自动跳过）
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

/** 依赖不一定装了（devDependencies）：缺了就跳过整份用例，而不是报错。 */
const optional = async (name) => {
  try {
    return await import(name);
  } catch {
    return null;
  }
};

const jsdomModule = await optional("jsdom");
const reactModule = await optional("react");

const SKIP = jsdomModule === null || reactModule === null
  ? "client tests need devDependencies (jsdom, react, react-dom)"
  : false;

let dom = null;
let React = null;
let jsxRuntime = null;
let reactDom = null;
let createRoot = null;
let act = null;

before(async () => {
  if (SKIP !== false) return;
  const { JSDOM } = jsdomModule;
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://127.0.0.1:8090/",
    pretendToBeVisual: true
  });
  // react-dom 需要真实的 window / document；用 jsdom 的全局替换后再加载它。
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = (await import("react")).default ?? (await import("react"));
  jsxRuntime = await import("react/jsx-runtime");
  reactDom = await import("react-dom");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act ?? (await import("react-dom/test-utils")).act;
});

after(() => {
  if (dom !== null) dom.window.close();
});

/** 已挂载的 React 根：每个用例结束都卸载，避免轮询定时器与旧 DOM 串场。 */
const roots = [];

async function unmountAll() {
  for (const root of roots.splice(0)) {
    try {
      await act(async () => {
        root.unmount();
      });
    } catch {
      // 卸载失败不影响后续用例。
    }
  }
}

afterEach(async () => {
  if (SKIP === false) await unmountAll();
});

/** 一条明细载荷（形状与 host 的 /detail 端点一致）。 */
function detailPayload(overrides = {}) {
  return {
    ok: true,
    sessionId: "s1",
    supported: true,
    calls: 3,
    cost: 0.133545,
    costUsd: 0.0185,
    savings: 0,
    savingsUsd: 0,
    inputTokens: 12000,
    cacheReadTokens: 228000,
    outputTokens: 4500,
    cacheHitPercent: 95,
    firstTime: Date.UTC(2026, 8, 10, 1, 0),
    lastTime: Date.UTC(2026, 8, 10, 2, 30),
    lastMode: "peak",
    lastModel: "deepseek-v4-pro",
    lastBilledAs: "deepseek-flash",
    models: [
      { model: "deepseek-v4-pro", billedAs: "deepseek-flash", calls: 2, cost: 0.12, costUsd: 0.017, inputTokens: 8000, cacheReadTokens: 200000, outputTokens: 3000 },
      { model: "deepseek-flash", billedAs: "deepseek-flash", calls: 1, cost: 0.013545, costUsd: 0.0015, inputTokens: 4000, cacheReadTokens: 28000, outputTokens: 1500 }
    ],
    modes: {
      peak: { calls: 3, cost: 0.133545, costUsd: 0.0185 },
      offPeak: { calls: 0, cost: 0, costUsd: 0 },
      flat: { calls: 0, cost: 0, costUsd: 0 }
    },
    trimmed: { calls: 0, cost: 0, costUsd: 0 },
    pricing: {
      model: "deepseek-v4-pro",
      billedAs: "deepseek-flash",
      mode: "peak",
      cny: { input: 2, cacheRead: 0.04, output: 8 },
      usd: { input: 0.3, cacheRead: 0.006, output: 1.2 },
      since: "2026-09-14T12:00:00+08:00",
      label: "…",
      checkedAt: "2026-09-10",
      source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing"
    },
    nextSwitch: { at: Date.UTC(2026, 8, 10, 4, 0), mode: "offPeak" },
    serverTime: Date.UTC(2026, 8, 10, 3, 0),
    displayCurrency: "auto",
    symbol: "¥",
    symbolUsd: "$",
    ...overrides
  };
}

/** 概览载荷（角标用）。 */
function sessionPayload(overrides = {}) {
  return {
    ok: true,
    sessionId: "s1",
    supported: true,
    calls: 3,
    cost: 0.1335,
    costUsd: 0.0185,
    lastMode: "peak",
    displayCurrency: "auto",
    symbol: "¥",
    symbolUsd: "$",
    ...overrides
  };
}

/**
 * 执行客户端 bundle，返回它的注册信息与被 apply 捕获的插槽组件。
 * @param options.locale - `ctx.locale` 的当前语言。
 * @param options.payloads - 端点路径 → 载荷（缺省用上面的样例）。
 * @param options.primitives - 传 true 时提供官方 primitives 桩（否则模拟其缺失）。
 * @param options.translate - 提供时作为框架注入的 `t`。
 */
function loadBundle(options = {}) {
  const registrations = [];
  const requests = [];
  const payloads = options.payloads ?? {
    "/session-cost/session/s1": sessionPayload(),
    "/session-cost/session/s1/detail": detailPayload()
  };
  const fetchStub = async (url) => {
    requests.push(String(url));
    const body = payloads[String(url)];
    if (body === void 0) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  const moduleWindow = dom.window;
  moduleWindow.__ModuleLoader__ = {
    load: (registration) => registrations.push(registration)
  };
  const effect = new Function(
    "window", "document", "fetch", "MutationObserver", "Node",
    "requestAnimationFrame", "cancelAnimationFrame", "setInterval", "clearInterval",
    `${SOURCE}\n;`
  );
  effect(
    moduleWindow,
    dom.window.document,
    fetchStub,
    dom.window.MutationObserver,
    dom.window.Node,
    (callback) => dom.window.setTimeout(callback, 0),
    (handle) => dom.window.clearTimeout(handle),
    setInterval,
    clearInterval
  );
  assert.equal(registrations.length, 1, "bundle must register exactly one factory");
  const registration = registrations[0];
  assert.equal(registration.id, "dsh-session-cost");

  const primitives = options.primitives === true
    ? {
        useAnchoredPosition: () => ({ left: 10, top: 10 }),
        useDismissOnOutsidePointer: () => {},
        IconDataOutline16: (props) => jsxRuntime.jsx("svg", { "data-icon": "data", ...props })
      }
    : null;
  const exported = registration.factory((spec) => {
    if (spec === "react") return React;
    if (spec === "react/jsx-runtime") return jsxRuntime;
    if (spec === "react-dom") {
      if (options.noReactDom === true) throw new Error("react-dom unavailable");
      return reactDom;
    }
    if (spec === "@deepseek-ai/dsh-client-ui-primitives") {
      if (primitives === null) throw new Error("primitives unavailable");
      return primitives;
    }
    throw new Error(`unexpected require: ${spec}`);
  });

  const slotRegistrations = [];
  const dictionaries = [];
  const ctx = {
    locale: {
      getSnapshot: () => ({ active: options.locale ?? "zh" }),
      subscribe: () => () => {},
      register: (namespace, dicts) => {
        dictionaries.push({ namespace, dicts });
        return () => {};
      }
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (registrationOptions, component) => {
        slotRegistrations.push({ options: registrationOptions, component });
        return () => {};
      }
    },
    effect: (callback) => callback()
  };
  exported.apply(ctx);
  assert.equal(slotRegistrations.length, 1, "apply must register one dock entry");
  return {
    component: slotRegistrations[0].component,
    slotOptions: slotRegistrations[0].options,
    dictionaries,
    requests,
    inject: exported.inject
  };
}

/** 造出「官方信息栏 + 本插件的 dock 行」两行结构。 */
async function layout(options = {}) {
  await unmountAll();
  dom.window.document.body.innerHTML = "";
  const stack = dom.window.document.createElement("div");
  const stats = dom.window.document.createElement("div");
  if (options.withStats !== false) {
    stats.setAttribute("data-composer-stats", "true");
    const pill = dom.window.document.createElement("span");
    pill.textContent = "1 轮 14 步";
    stats.appendChild(pill);
  }
  const dock = dom.window.document.createElement("div");
  stack.append(stats, dock);
  dom.window.document.body.appendChild(stack);
  return { stack, stats: options.withStats === false ? null : stats, dock };
}

/** 把插槽组件渲染进 dock 行，并把异步副作用跑完。 */
async function mount(loaded, container, props = {}) {
  const root = createRoot(container);
  roots.push(root);
  const element = React.createElement(loaded.component, {
    useSession: (selector) => selector({ sessionId: props.sessionId ?? "s1" }),
    t: props.t,
    ...props
  });
  await act(async () => {
    root.render(element);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return root;
}

const query = (selector) => dom.window.document.querySelector(selector);

test("client bundle：注册为 dock 条目（order=1、绑定自己的 locale 命名空间）", { skip: SKIP }, () => {
  const loaded = loadBundle();
  assert.equal(loaded.slotOptions.name, "conversation.composer.dock");
  assert.equal(loaded.slotOptions.id, "session-cost");
  assert.equal(loaded.slotOptions.order, 1);
  assert.equal(loaded.slotOptions.locale, "session-cost");
  assert.deepEqual(loaded.inject, ["slots", "locale"]);
  assert.equal(loaded.dictionaries.length, 1);
  assert.equal(loaded.dictionaries[0].namespace, "session-cost");
  assert.equal(typeof loaded.dictionaries[0].dicts.zh.title, "string");
  assert.equal(typeof loaded.dictionaries[0].dicts.en.title, "string");
});

test("角标追加在官方信息栏那一行（不是自己新起一行）", { skip: SKIP }, async () => {
  const loaded = loadBundle();
  const { stats, dock } = await layout();
  await mount(loaded, dock);

  const chip = query("[data-composer-stats] [data-session-cost]");
  assert.ok(chip !== null, "chip must live inside the official stats row");
  assert.equal(chip.tagName, "BUTTON");
  assert.equal(chip.getAttribute("aria-haspopup"), "dialog");
  assert.equal(chip.getAttribute("aria-expanded"), "false");
  assert.match(chip.textContent, /¥0\.1335/);
  assert.match(chip.textContent, /高峰/);
  // 官方原有内容原样保留，我们的角标排在它后面。
  assert.equal(stats.firstChild.textContent, "1 轮 14 步");
  assert.equal(chip.parentElement, stats);
  // dock 行里只剩下不占位的锚点。
  assert.equal(dock.querySelectorAll("button").length, 0);
  assert.equal(dock.querySelectorAll(".sc_anchor").length, 1);
  // 概览端点被轮询到。
  assert.ok(loaded.requests.includes("/session-cost/session/s1"));
});

test("点开角标 → 明细菜单（单价 / 下次切换 / 用量 / 模型路由）", { skip: SKIP }, async () => {
  const loaded = loadBundle();
  const { dock } = await layout();
  await mount(loaded, dock);
  const chip = query("[data-session-cost]");
  assert.equal(query("[data-session-cost-panel]"), null);

  await act(async () => {
    chip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const panel = query("[data-session-cost-panel]");
  assert.ok(panel !== null, "panel must be portaled into document.body");
  assert.equal(panel.parentElement, dom.window.document.body);
  assert.equal(panel.getAttribute("role"), "dialog");
  assert.equal(chip.getAttribute("aria-expanded"), "true");
  const text = panel.textContent;
  assert.match(text, /本会话消耗/);
  assert.match(text, /¥0\.133545/); // 精确金额（标题右侧）
  assert.match(text, /¥2 \/ ¥0\.04 \/ ¥8/); // 当前单价 / 1M tokens
  assert.match(text, /deepseek-v4-pro → deepseek-flash/); // 兼容路由
  assert.match(text, /95%/); // 缓存命中率
  assert.match(text, /12,000/); // 输入 tokens 千分位
  assert.match(text, /228,000/); // 缓存读取
  assert.match(text, /4,500/); // 输出 tokens
  assert.match(text, /下次切换/);
  assert.match(text, /价格核对 2026-09-10/);
  assert.match(text, /按模型/); // 两个模型 → 拆分清单
  assert.ok(loaded.requests.includes("/session-cost/session/s1/detail"));
});

test("外部点击与 Esc 关闭菜单", { skip: SKIP }, async () => {
  const loaded = loadBundle();
  const { dock } = await layout();
  await mount(loaded, dock);
  const click = async (target) => {
    await act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const chip = query("[data-session-cost]");

  await click(chip);
  assert.ok(query("[data-session-cost-panel]") !== null);
  // 面板内部点击不关闭。
  await act(async () => {
    query("[data-session-cost-panel]").dispatchEvent(
      new dom.window.MouseEvent("pointerdown", { bubbles: true })
    );
  });
  assert.ok(query("[data-session-cost-panel]") !== null, "pointerdown inside the panel must keep it open");
  // 面板外部点击关闭。
  await act(async () => {
    dom.window.document.body.dispatchEvent(
      new dom.window.MouseEvent("pointerdown", { bubbles: true })
    );
  });
  assert.equal(query("[data-session-cost-panel]"), null, "outside pointerdown must close the panel");
  // Esc 关闭。
  await click(chip);
  assert.ok(query("[data-session-cost-panel]") !== null);
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(query("[data-session-cost-panel]"), null, "Escape must close the panel");
});

test("官方信息栏不存在时退回自己的 dock 行（仍然可点开）", { skip: SKIP }, async () => {
  const loaded = loadBundle();
  const { dock } = await layout({ withStats: false });
  await mount(loaded, dock);
  const chip = query("[data-session-cost]");
  assert.ok(chip !== null);
  assert.equal(chip.parentElement.className, "sc_row");
  await act(async () => {
    chip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(query("[data-session-cost-panel]") !== null);
});

test("没有已计费用量 / 会话含未支持模型时不占位", { skip: SKIP }, async () => {
  const empty = loadBundle({
    payloads: { "/session-cost/session/s1": sessionPayload({ calls: 0, cost: 0 }) }
  });
  const first = await layout();
  await mount(empty, first.dock);
  assert.equal(query("[data-session-cost]"), null);
  assert.equal(query(".sc_anchor") !== null, true, "anchor stays so a later stats row can be found");

  const unsupported = loadBundle({
    payloads: { "/session-cost/session/s1": sessionPayload({ supported: false }) }
  });
  const second = await layout();
  await mount(unsupported, second.dock);
  assert.equal(query("[data-session-cost]"), null);
});

test("官方行稍后出现时能补挂上去（新建会话 → 首轮对话）", { skip: SKIP }, async () => {
  const loaded = loadBundle();
  const { stack, dock } = await layout({ withStats: false });
  await mount(loaded, dock);
  assert.equal(query(".sc_row [data-session-cost]") !== null, true);

  await act(async () => {
    const stats = dom.window.document.createElement("div");
    stats.setAttribute("data-composer-stats", "true");
    stats.textContent = "1 轮 0 步";
    stack.insertBefore(stats, dock);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 30));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const chip = query("[data-session-cost]");
  assert.equal(chip.parentElement.getAttribute("data-composer-stats"), "true");
  assert.equal(query(".sc_row"), null, "inline fallback gives way to the official row");
});

test("英文界面：美元金额 + 英文文案（内置字典兜底）", { skip: SKIP }, async () => {
  const loaded = loadBundle({ locale: "en" });
  const { dock } = await layout();
  await mount(loaded, dock);
  const chip = query("[data-session-cost]");
  assert.match(chip.textContent, /\$0\.0185/);
  await act(async () => {
    chip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const panel = query("[data-session-cost-panel]");
  assert.match(panel.textContent, /Session cost/);
  assert.match(panel.textContent, /Price \/ 1M tokens/);
  assert.match(panel.textContent, /\$0\.3 \/ \$0\.006 \/ \$1\.2/);
  assert.match(panel.textContent, /Off-peak at/);
  assert.match(panel.textContent, /Prices checked 2026-09-10/);
});

test("框架注入的 t 优先于内置字典", { skip: SKIP }, async () => {
  const loaded = loadBundle();
  const { dock } = await layout();
  await mount(loaded, dock, {
    t: (key) => (key === "title" ? "已翻译标题" : void 0)
  });
  const chip = query("[data-session-cost]");
  await act(async () => {
    chip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const panel = query("[data-session-cost-panel]");
  assert.match(panel.textContent, /已翻译标题/);
  assert.match(panel.textContent, /计价时段/); // 未提供译文的键回落内置字典
});

test("官方 primitives 可用时同样工作（走其定位 / 关闭钩子）", { skip: SKIP }, async () => {
  const loaded = loadBundle({ primitives: true });
  const { stats, dock } = await layout();
  await mount(loaded, dock);
  const chip = query("[data-composer-stats] [data-session-cost]");
  assert.ok(chip !== null);
  await act(async () => {
    chip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const panel = query("[data-session-cost-panel]");
  assert.ok(panel !== null);
  assert.equal(panel.style.left, "10px"); // 桩钩子给的位置被采用
  assert.equal(stats.querySelectorAll("[data-session-cost]").length, 1);
});

test("react-dom 不可用时降级为内联渲染（不抛错）", { skip: SKIP }, async () => {
  const loaded = loadBundle({ noReactDom: true });
  const { dock } = await layout();
  await mount(loaded, dock);
  const chip = query("[data-session-cost]");
  assert.ok(chip !== null, "chip must still render without react-dom");
  assert.equal(chip.parentElement.className, "sc_row");
});
