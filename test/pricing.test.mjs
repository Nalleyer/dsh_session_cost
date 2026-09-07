/**
 * dsh-session-cost — pricing engine tests (peak/off-peak 计费验证).
 *
 * 验证 lib/pricing.js（纯函数引擎）结合 lib/pricing-data.json（价格数据）的核心行为：
 * 峰谷判定、按消息时刻取价、双币种费用计算。运行：node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPeak, priceAt, costOf, zeroTrimmed, addTrimmed } from "../lib/pricing.js";

// 价格数据来自数据文件（不写在代码里），此处直接读取以保持单一事实来源。
const DATA = JSON.parse(
  readFileSync(fileURLToPath(new URL("../lib/pricing-data.json", import.meta.url)), "utf8")
);
const { timezone, peakWindows, policies, models } = DATA;

/** 构造北京时间（UTC+8）的 epoch ms。 */
const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

// 2026-08-17 起启用峰谷定价；2026-05-22 起 V4 系列 75% 降价（平价为该日之前生效）。
const T_PEAK = bj(2026, 8, 17, 10, 0);   // 10:00 CST ∈ [9,12) 高峰
const T_PEAK2 = bj(2026, 8, 17, 15, 0);  // 15:00 CST ∈ [14,18) 高峰
const T_OFF = bj(2026, 8, 17, 20, 0);    // 20:00 CST 空闲
const T_FLAT = bj(2026, 6, 1, 10, 0);    // 2026-05-22 之后、峰谷之前 → 平价

test("支持的模型为官方三个 V4 模型", () => {
  assert.deepEqual([...models].sort(), [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp"
  ].sort());
});

test("isPeak 按北京时间窗口判定", () => {
  assert.equal(isPeak(T_PEAK, timezone, peakWindows), true);
  assert.equal(isPeak(T_PEAK2, timezone, peakWindows), true);
  assert.equal(isPeak(T_OFF, timezone, peakWindows), false);
  assert.equal(isPeak(bj(2026, 8, 17, 12, 0), timezone, peakWindows), false);
});

test("priceAt：峰谷时段返回对应单价与 mode", () => {
  const peak = priceAt("deepseek-v4-flash", T_PEAK, { timezone, peakWindows, policies });
  assert.equal(peak.mode, "peak");
  assert.equal(peak.cny.input, 3);
  assert.equal(peak.cny.cacheRead, 0.1);
  assert.equal(peak.cny.output, 9);

  const off = priceAt("deepseek-v4-flash", T_OFF, { timezone, peakWindows, policies });
  assert.equal(off.mode, "offPeak");
  assert.equal(off.cny.input, 1.5); // 空闲 = 高峰半价
  assert.equal(off.cny.output, 4.5);
});

test("priceAt：deepseek-v4-flash-vision-exp 与 flash 同价（高峰/空闲，双币种）", () => {
  for (const [time, mode] of [[T_PEAK, "peak"], [T_OFF, "offPeak"]]) {
    const flash = priceAt("deepseek-v4-flash", time, { timezone, peakWindows, policies });
    const vision = priceAt("deepseek-v4-flash-vision-exp", time, { timezone, peakWindows, policies });
    assert.equal(vision.mode, mode);
    assert.deepEqual(vision.cny, flash.cny); // 官网：vision-exp 价格 = flash 价格
    assert.deepEqual(vision.usd, flash.usd);
    assert.equal(vision.cny.cacheRead, mode === "peak" ? 0.1 : 0.05); // 缓存命中价
  }
});

test("priceAt：峰谷之前的时段为平价（flat）", () => {
  const flat = priceAt("deepseek-v4-flash", T_FLAT, { timezone, peakWindows, policies });
  assert.equal(flat.mode, "flat");
  assert.equal(flat.cny.input, 1);
  assert.equal(flat.cny.cacheRead, 0.02);
  assert.equal(flat.cny.output, 2);
});

test("costOf：按 token 与单价计算双币种费用", () => {
  const unit = { cny: { input: 3, cacheRead: 0.1, output: 9 }, usd: { input: 0.44, cacheRead: 0.014, output: 1.32 } };
  const cost = costOf({ inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, unit);
  assert.equal(cost.cost, 3);
  assert.equal(cost.costUsd, 0.44);
  const cost2 = costOf({ inputTokens: 0, cacheReadTokens: 2_000_000, outputTokens: 500_000 }, unit);
  assert.equal(cost2.cost, 2 * 0.1 + 0.5 * 9);
});

test("costOf：异常 token 值不会污染费用", () => {
  const unit = { cny: { input: 1, cacheRead: 1, output: 1 }, usd: { input: 1, cacheRead: 1, output: 1 } };
  assert.deepEqual(costOf({ inputTokens: Number.NaN, cacheReadTokens: -1, outputTokens: Infinity }, unit), {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    cost: 0,
    costUsd: 0
  });
});

test("zeroTrimmed / addTrimmed：裁剪聚合按实际数值并入", () => {
  const t = zeroTrimmed();
  assert.equal(t.calls, 0);
  assert.equal(t.cost, 0);
  addTrimmed(t, {
    calls: 3, cost: 1.5, costUsd: 0.2, costNominal: 1.5, costNominalUsd: 0.2,
    savings: 0.5, savingsUsd: 0.07, inputTokens: 100, cacheReadTokens: 200, outputTokens: 50
  });
  assert.equal(t.calls, 3);
  assert.equal(t.cost, 1.5);
  assert.equal(t.costUsd, 0.2);
  assert.equal(t.costNominal, 1.5);
  assert.equal(t.savings, 0.5);
  assert.equal(t.inputTokens, 100);
  assert.equal(t.cacheReadTokens, 200);
  assert.equal(t.outputTokens, 50);
  addTrimmed(t, { calls: 1, cost: 2, costUsd: 0.3 });
  assert.equal(t.calls, 4);
  assert.equal(t.cost, 3.5);
  assert.equal(t.costUsd, 0.5);
});
