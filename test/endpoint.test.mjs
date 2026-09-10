/**
 * dsh-session-cost — endpoint tests（host 端点）。
 *
 * 用假的 cordis 上下文把插件 apply 起来：`session/event` 事件照常投喂账本，
 * `webServer.register` 捕获路由处理函数，然后用假的 req/res 发真实请求。
 * 覆盖：概览端点、明细端点（聚合 + 当前单价 + 下一处峰谷切换）、未知会话回零、
 * 非 GET 方法、回环限制、未知路径 404、畸形百分号编码 400。
 *
 * 运行：node --test
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";
import { priceAt } from "../lib/pricing.js";

// 价格数据来自数据文件（不写在代码里），此处直接读取以保持单一事实来源。
const DATA = JSON.parse(
  readFileSync(fileURLToPath(new URL("../lib/pricing-data.json", import.meta.url)), "utf8")
);
const { timezone, peakWindows, peakWeekdays, policies } = DATA;

const cleanups = [];
after(async () => {
  for (const path of cleanups) await rm(path, { force: true }).catch(() => {});
});

/** 北京时间（UTC+8）的 epoch ms。 */
const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

/** 起一个插件实例，返回发请求的小工具。 */
function boot(options = {}) {
  const persistPath = join(tmpdir(), `dsh-session-cost-endpoint-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  cleanups.push(persistPath, `${persistPath}.tmp`);
  const routes = [];
  const listeners = [];
  const warnings = [];
  const config = {
    symbol: "¥",
    symbolUsd: "$",
    displayCurrency: "auto",
    persistPath,
    maxMessagesPerSession: 2000,
    loopbackOnly: true,
    ...options
  };
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    on: (event, handler) => {
      if (event === "session/event") listeners.push(handler);
    },
    get: () => void 0,
    effect: (callback) => {
      callback();
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      }
    }
  };
  apply(ctx, config);
  assert.equal(routes.length, 1, "plugin must register exactly one route");

  /** 投喂一条 assistant 消息事件（含用量）。 */
  const message = (sessionId, seq, time, model, usage) => {
    for (const listener of listeners) {
      listener({ id: sessionId }, {
        type: "assistant/message",
        seq,
        time,
        data: {
          message: { id: `m${seq}`, source: { kind: "model", provider: "deepseek", model } },
          usage
        }
      });
    }
  };

  /** 发一个请求，返回 { status, body }。 */
  const request = async (url, options2 = {}) => {
    const chunks = [];
    const response = {
      status: 0,
      headers: null,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers ?? null;
        return this;
      },
      end(chunk) {
        if (chunk !== void 0 && chunk !== null) chunks.push(String(chunk));
      }
    };
    await routes[0].handler({
      method: options2.method ?? "GET",
      url,
      socket: { remoteAddress: options2.remoteAddress ?? "127.0.0.1" }
    }, response);
    const raw = chunks.join("");
    return { status: response.status, headers: response.headers, body: raw === "" ? null : JSON.parse(raw) };
  };

  return { config, message, request, warnings, path: persistPath };
}

test("概览端点：总量 / 角标模式 / 展示币种", async () => {
  const plugin = boot();
  plugin.message("s1", 1, bj(2026, 9, 10, 10, 0), "deepseek-flash", {
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0
  });
  const { status, body } = await plugin.request("/session-cost/session/s1");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sessionId, "s1");
  assert.equal(body.calls, 1);
  assert.equal(body.cost, 2); // 2026-09-10 高峰：deepseek-flash 输入 ¥2 / 1M
  assert.equal(body.lastMode, "peak");
  assert.equal(body.supported, true);
  assert.equal(body.displayCurrency, "auto");
  assert.equal(body.symbol, "¥");
  assert.equal(body.headers ?? body.symbolUsd, "$");
});

test("明细端点：按模型/时段聚合 + 当前单价 + 下一处峰谷切换", async () => {
  const plugin = boot();
  // 两条消息：一条 deepseek-flash（高峰）、一条 v4-pro（空闲，且已进入兼容路由）。
  plugin.message("s2", 1, bj(2026, 9, 10, 10, 0), "deepseek-flash", {
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 0
  });
  plugin.message("s2", 2, bj(2026, 9, 14, 20, 0), "deepseek-v4-pro", {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 1_000_000
  });

  const { status, body } = await plugin.request("/session-cost/session/s2/detail");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.calls, 2);
  assert.equal(body.inputTokens, 1_000_000);
  assert.equal(body.cacheReadTokens, 1_000_000);
  assert.equal(body.outputTokens, 1_000_000);
  assert.equal(body.cacheHitPercent, 50);
  assert.equal(body.firstTime, bj(2026, 9, 10, 10, 0));
  assert.equal(body.lastTime, bj(2026, 9, 14, 20, 0));
  assert.equal(body.lastMode, "offPeak");
  assert.equal(body.modes.peak.calls, 1);
  assert.equal(body.modes.offPeak.calls, 1);
  assert.equal(body.models.length, 2);
  const routed = body.models.find((entry) => entry.model === "deepseek-v4-pro");
  assert.equal(routed.billedAs, "deepseek-flash"); // 2026-09-14 12:00 起全量路由
  assert.equal(routed.outputTokens, 1_000_000);
  // 单价按「最近模型的当前时刻」给出（下一条消息的价）：这里与 priceAt(now) 对齐，
  // 不依赖测试运行时刻落在哪一条政策区间。
  const expected = priceAt(body.lastModel, body.serverTime, { timezone, peakWindows, peakWeekdays, policies });
  assert.equal(body.pricing.model, "deepseek-v4-pro");
  assert.equal(body.pricing.billedAs, expected.billedAs);
  assert.equal(body.pricing.mode, expected.mode);
  assert.deepEqual(body.pricing.cny, expected.cny);
  assert.equal(typeof body.pricing.checkedAt, "string");
  assert.equal(typeof body.nextSwitch.at, "number");
  assert.ok(["peak", "offPeak"].includes(body.nextSwitch.mode));
  assert.equal(typeof body.serverTime, "number");
});

test("明细端点：未知会话回零聚合，不臆造单价", async () => {
  const plugin = boot();
  const { status, body } = await plugin.request("/session-cost/session/nope/detail");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.calls, 0);
  assert.equal(body.cost, 0);
  assert.equal(body.pricing, null);
  assert.equal(body.cacheHitPercent, null);
  assert.deepEqual(body.models, []);
  assert.equal(body.supported, true);
});

test("概览端点：未知会话回零", async () => {
  const plugin = boot();
  const { status, body } = await plugin.request("/session-cost/session/nope");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.calls, 0);
  assert.equal(body.cost, 0);
  assert.equal(body.lastMode, "flat");
});

test("明细端点：含未支持模型的会话仍照实返回明细（supported=false 由客户端隐藏）", async () => {
  const plugin = boot();
  plugin.message("s3", 1, bj(2026, 9, 10, 10, 0), "claude-opus-4", { inputTokens: 10, outputTokens: 10 });
  const { body } = await plugin.request("/session-cost/session/s3/detail");
  assert.equal(body.ok, true);
  assert.equal(body.supported, false);
  assert.equal(body.calls, 0);
});

test("路由守卫：非 GET 405、非回环 403、未知路径 404、畸形编码 400", async () => {
  const plugin = boot();
  assert.equal((await plugin.request("/session-cost/session/s1", { method: "POST" })).status, 405);
  const remote = await plugin.request("/session-cost/session/s1", { remoteAddress: "10.0.0.7" });
  assert.equal(remote.status, 403);
  assert.equal(remote.body.error, "loopback-only");
  assert.equal((await plugin.request("/session-cost/whatever")).status, 404);
  assert.equal((await plugin.request("/session-cost/session/%E0%A4%A")).status, 400);
});

test("loopbackOnly=false 时允许非回环访问（配置项生效）", async () => {
  const plugin = boot({ loopbackOnly: false });
  const { status } = await plugin.request("/session-cost/session/s1", { remoteAddress: "10.0.0.7" });
  assert.equal(status, 200);
});

test("showCurrency 强制 USD 时两个端点都带同一配置", async () => {
  const plugin = boot({ displayCurrency: "USD", symbol: "￥", symbolUsd: "US$" });
  plugin.message("s4", 1, bj(2026, 9, 10, 10, 0), "deepseek-flash", { inputTokens: 1_000_000, outputTokens: 0 });
  const overview = await plugin.request("/session-cost/session/s4");
  const detail = await plugin.request("/session-cost/session/s4/detail");
  for (const body of [overview.body, detail.body]) {
    assert.equal(body.displayCurrency, "USD");
    assert.equal(body.symbol, "￥");
    assert.equal(body.symbolUsd, "US$");
  }
});
