/**
 * dsh-session-cost — ledger behavior tests（记账簿行为）。
 *
 * 覆盖：
 * 1. lastMode / lastTime 首次记录即生效（「高峰 / 空闲」角标可用）；
 * 2. 明细裁剪后 reprice 重估不缩水（trimmed 聚合保留）；
 * 3. reprice 保留 unsupported 会话（supported=false 不被重置）；
 * 4. 写盘期间到达的新记录会在同一轮 flush 中落盘；
 * 5. 模型表更新后 unsupported 标记的自愈与保守规则（见 lib/index.js: stillUnsupported）；
 * 6. 模型名路由（v4-pro → deepseek-flash）在记账侧的落地。
 * 运行：node --test
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionCostLedger, recordSessionEvent } from "../lib/index.js";
import { priceAt, zeroCounts, zeroTrimmed } from "../lib/pricing.js";

// 价格数据来自数据文件（不写在代码里），此处直接读取以保持单一事实来源。
const DATA = JSON.parse(
  readFileSync(fileURLToPath(new URL("../lib/pricing-data.json", import.meta.url)), "utf8")
);
const { timezone, peakWindows, peakWeekdays, policies } = DATA;

/** 构造北京时间（UTC+8）的 epoch ms。 */
const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

function makePricing(hash) {
  return {
    hash,
    at: (model, time) => priceAt(model, time, { timezone, peakWindows, peakWeekdays, policies })
  };
}

const cleanups = [];
after(async () => {
  for (const { ledger, path, root } of cleanups) {
    await ledger.flush().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    await rm(`${path}.tmp`, { force: true }).catch(() => {});
    if (root !== void 0) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

function makeLedger(maxMessagesPerSession) {
  const path = join(tmpdir(), `dsh-session-cost-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const ledger = new SessionCostLedger(path, maxMessagesPerSession);
  cleanups.push({ ledger, path });
  return ledger;
}

/** 按给定时刻记一条 deepseek-v4-flash 消息（m<id>）。 */
function recordAt(ledger, sessionId, messageId, time) {
  ledger.record({
    sessionId,
    messageId,
    time,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    ...ledger.price("deepseek-v4-flash", "deepseek", time, { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100 }, P1)
  });
}

const P1 = makePricing("v1");

test("首条记录即写入 lastMode/lastTime（高峰角标可用）", () => {
  const ledger = makeLedger(10);
  const time = bj(2026, 8, 17, 10, 0); // 10:00 CST ∈ [9,12) 高峰
  recordAt(ledger, "s1", "m1", time);
  const view = ledger.sessionView("s1");
  assert.equal(view.lastMode, "peak");
  assert.equal(view.calls, 1);
  assert.equal(ledger.bySession.get("s1").lastTime, time);
});

test("裁剪后重估：总额与调用次数保持一致（trimmed 聚合保留）", () => {
  const ledger = makeLedger(2);
  const times = [bj(2026, 8, 17, 9, 0), bj(2026, 8, 17, 10, 0), bj(2026, 8, 17, 11, 0)];
  for (let i = 0; i < times.length; i++) recordAt(ledger, "s2", `m${i}`, times[i]);

  const before = ledger.sessionView("s2");
  assert.equal(before.calls, 3);
  assert.ok(before.cost > 0);
  assert.equal(ledger.bySession.get("s2").messages.size, 2); // 最旧的 1 条被裁剪
  assert.equal(ledger.bySession.get("s2").trimmed.calls, 1);

  // 换 pricing hash 强制走一遍 reprice（模拟调价后重启）
  ledger.reprice(makePricing("v2"));

  const after = ledger.sessionView("s2");
  assert.equal(after.calls, 3);
  assert.ok(Math.abs(after.cost - before.cost) < 1e-9);
  assert.ok(Math.abs(after.costUsd - before.costUsd) < 1e-9);
  assert.ok(Math.abs(after.inputTokens - before.inputTokens) < 1e-9);
  assert.equal(ledger.bySession.get("s2").messages.size, 2);
  assert.equal(ledger.bySession.get("s2").trimmed.calls, 1);
  // 重估后角标仍可用（按保留消息的最新时刻）
  assert.equal(after.lastMode, "peak");
});

test("重估保留已裁剪的最新消息角标", () => {
  const ledger = makeLedger(2);
  const times = [
    bj(2026, 8, 17, 9, 0),
    bj(2026, 8, 17, 10, 0),
    bj(2026, 8, 17, 20, 0), // 按消息时刻最新，但随后会被明细裁剪
    bj(2026, 8, 17, 11, 0),
    bj(2026, 8, 17, 12, 0)
  ];
  for (let i = 0; i < times.length; i++) recordAt(ledger, "s3", `m${i}`, times[i]);
  assert.equal(ledger.sessionView("s3").lastMode, "offPeak");
  ledger.reprice(makePricing("v3"));
  assert.equal(ledger.sessionView("s3").lastMode, "offPeak");
});

test("重估保留 unsupported 会话（仍不被支持的模型名 → supported=false 不被重置）", () => {
  const ledger = makeLedger(10);
  ledger.markUnsupported("s9", "claude-opus-4");
  ledger.reprice(makePricing("v9"));
  const view = ledger.sessionView("s9");
  assert.equal(view.supported, false);
  assert.equal(view.calls, 0);
});

test("markUnsupported 记录模型名并落盘（供下次调价重估判定）", async () => {
  const ledger = makeLedger(10);
  ledger.markUnsupported("s13", "claude-opus-4");
  ledger.markUnsupported("s13", "gpt-5");
  ledger.markUnsupported("s13", "claude-opus-4"); // 重复投递不重复记录
  await ledger.flush();
  const saved = JSON.parse(readFileSync(ledger.path, "utf8"));
  assert.deepEqual(saved.sessions.s13.unsupportedModels, ["claude-opus-4", "gpt-5"]);
  assert.equal(saved.sessions.s13.unsupported, true);
});

test("不支持模型即使没有 usage 也隐藏第二行", () => {
  const ledger = makeLedger(10);
  recordSessionEvent(ledger, new Map(), { id: "s10" }, {
    type: "assistant/message",
    seq: 1,
    time: bj(2026, 8, 17, 10, 0),
    data: {
      message: {
        id: "m1",
        source: { kind: "model", provider: "other", model: "other-model" }
      }
    }
  }, P1);
  assert.equal(ledger.sessionView("s10").supported, false);
});

test("flush 会创建不存在的账本父目录", async () => {
  const root = join(tmpdir(), `dsh-session-cost-parent-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const path = join(root, "nested", "ledger.json");
  const ledger = new SessionCostLedger(path, 10);
  cleanups.push({ ledger, path, root });
  recordAt(ledger, "s11", "m1", bj(2026, 8, 17, 10, 0));
  await ledger.flush();
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.sessions.s11.calls, 1);
});

test("deepseek-flash（V4.1）属支持模型：正常记账，不再隐藏第二行", () => {
  const ledger = makeLedger(10);
  recordSessionEvent(ledger, new Map(), { id: "sNew" }, {
    type: "assistant/message",
    seq: 1,
    time: bj(2026, 9, 10, 10, 0), // 周四 10:00 高峰
    data: {
      message: { id: "m1", source: { kind: "model", provider: "deepseek", model: "deepseek-flash" } },
      usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }
    }
  }, P1);
  const view = ledger.sessionView("sNew");
  assert.equal(view.supported, true);
  assert.equal(view.calls, 1);
  assert.equal(view.cost, 2); // 2026-09-10 高峰：¥2 / 1M 输入
  assert.equal(view.lastMode, "peak");
});

test("unsupported 自愈：旧标记源于已支持化的模型名 → 重估后恢复显示", () => {
  const ledger = makeLedger(10);
  // 模拟修复前的账本：当时 deepseek-flash 不在模型表内，被记为不支持。
  ledger.markUnsupported("sHeal", "deepseek-flash");
  assert.equal(ledger.sessionView("sHeal").supported, false);
  ledger.reprice(makePricing("heal"));
  assert.equal(ledger.sessionView("sHeal").supported, true);
});

test("unsupported 迁移：旧账本未记模型名时，无明细会话清除陈旧标记、有明细会话保留", () => {
  const ledger = makeLedger(10);
  // 旧账本形态之一：会话没有任何可用明细（用量全被跳过）→ 标记只是陈旧，清除。
  ledger.bySession.set("sLegacyEmpty", {
    ...zeroCounts(),
    trimmed: zeroTrimmed(),
    messages: new Map(),
    unsupported: true
  });
  // 旧账本形态之二：会话有明细但曾用过不支持模型 → 保守保留（避免片面金额）。
  recordAt(ledger, "sLegacyUsed", "m1", bj(2026, 8, 17, 10, 0));
  ledger.bySession.get("sLegacyUsed").unsupported = true;

  ledger.reprice(makePricing("legacy"));
  assert.equal(ledger.sessionView("sLegacyEmpty").supported, true);
  assert.equal(ledger.sessionView("sLegacyUsed").supported, false);
});

test("模型名路由：v4-pro 于 2026-09-14 12:00 后按 Flash 单价记账", () => {
  const ledger = makeLedger(10);
  const time = bj(2026, 9, 14, 20, 0); // 周一 20:00 空闲时段
  ledger.record({
    sessionId: "sRoute",
    messageId: "m1",
    time,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    ...ledger.price("deepseek-v4-pro", "deepseek", time, { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, P1)
  });
  assert.equal(ledger.sessionView("sRoute").cost, 1); // 空闲 Flash 输入价 ¥1 / 1M
  assert.equal(ledger.bySession.get("sRoute").messages.get("m1").billedAs, "deepseek-flash");
});

test("写盘期间的新记录会在同一轮 flush 中保存", async () => {
  const ledger = makeLedger(10);
  let releaseFirstWrite;
  const firstWriteBlocked = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  let writes = 0;
  const writeSnapshot = ledger.writeSnapshot.bind(ledger);
  ledger.writeSnapshot = async (body) => {
    writes += 1;
    if (writes === 1) await firstWriteBlocked;
    return writeSnapshot(body);
  };

  recordAt(ledger, "s12", "m1", bj(2026, 8, 17, 10, 0));
  const flushing = ledger.flush();
  assert.equal(writes, 1);
  recordAt(ledger, "s12", "m2", bj(2026, 8, 17, 11, 0));
  releaseFirstWrite();
  await flushing;

  const saved = JSON.parse(readFileSync(ledger.path, "utf8"));
  assert.equal(writes, 2);
  assert.equal(saved.sessions.s12.calls, 2);
  assert.ok(saved.sessions.s12.messages.m2);
});
