/**
 * dsh-session-cost — pricing engine tests (峰谷 + 模型路由计费验证).
 *
 * 验证 lib/pricing.js（纯函数引擎）结合 lib/pricing-data.json（价格数据）的核心行为：
 * 峰谷判定（含**周一至周五**限制）、按消息时刻取价、DeepSeek 官方模型名路由
 * （v4-flash 系列 → deepseek-flash；2026-09-14 12:00 起 v4-pro → deepseek-flash）、
 * 双币种费用计算。运行：node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isPeak,
  priceAt,
  costOf,
  nextPeakTransition,
  cacheHitPercent,
  zeroTrimmed,
  addTrimmed
} from "../lib/pricing.js";

// 价格数据来自数据文件（不写在代码里），此处直接读取以保持单一事实来源。
const DATA = JSON.parse(
  readFileSync(fileURLToPath(new URL("../lib/pricing-data.json", import.meta.url)), "utf8")
);
const { timezone, peakWindows, peakWeekdays, policies, models } = DATA;
const opts = { timezone, peakWindows, peakWeekdays, policies };

/** 构造北京时间（UTC+8）的 epoch ms。 */
const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

// 关键时间点（weekday 以北京时间计）。
const T_FLAT = bj(2026, 6, 1, 10, 0);        // 2026-05-22 之后、峰谷之前 → 平价（周一）
const T_PEAK = bj(2026, 8, 17, 10, 0);       // 周一 10:00 ∈ [9,12) 高峰
const T_PEAK2 = bj(2026, 8, 17, 15, 0);      // 周一 15:00 ∈ [14,18) 高峰
const T_OFF = bj(2026, 8, 17, 20, 0);        // 周一 20:00 空闲
const T_WEEKEND = bj(2026, 9, 12, 10, 0);    // 周六 10:00：窗口内但周末 → 空闲
const T_V41_PEAK = bj(2026, 9, 10, 10, 0);   // V4.1 新价生效后的高峰（周四）
const T_V41_OFF = bj(2026, 9, 10, 20, 0);    // V4.1 新价生效后的空闲
const T_PRO_LAST = bj(2026, 9, 14, 11, 0);   // V4 Pro 路由生效前（周一 11:00，高峰）
const T_PRO_ROUTED = bj(2026, 9, 14, 12, 0); // V4 Pro 全量路由至 V4.1 Flash 的起点

/** 某政策是否为该模型自带价格行（与路由区分）。 */
const hasRow = (policy, name) =>
  policy.peak?.[name] !== void 0 || policy.offPeak?.[name] !== void 0 || policy.prices?.[name] !== void 0;

test("支持的模型为官方在售及兼容期内模型", () => {
  assert.deepEqual([...models].sort(), [
    "deepseek-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp"
  ].sort());
});

test("数据完整性：每条 routes 的目标模型在政策链上有价格行", () => {
  for (const policy of policies) {
    for (const [from, to] of Object.entries(policy.routes ?? {})) {
      assert.ok(
        policies.some((candidate) => hasRow(candidate, to)),
        `${policy.since} 的 ${from} → ${to} 缺少价格行`
      );
    }
  }
});

test("isPeak 按北京时间窗口判定（省略 weekdays 表示不限星期）", () => {
  assert.equal(isPeak(T_PEAK, timezone, peakWindows), true);
  assert.equal(isPeak(T_PEAK2, timezone, peakWindows), true);
  assert.equal(isPeak(T_OFF, timezone, peakWindows), false);
  assert.equal(isPeak(bj(2026, 8, 17, 12, 0), timezone, peakWindows), false);
  // 窗口内但周末 → 非高峰（官方：高峰为周一至周五）
  assert.equal(isPeak(T_WEEKEND, timezone, peakWindows), true);
  assert.equal(isPeak(T_WEEKEND, timezone, peakWindows, peakWeekdays), false);
  assert.equal(isPeak(bj(2026, 9, 13, 15, 0), timezone, peakWindows, peakWeekdays), false); // 周日
});

test("nextPeakTransition：给出下一个整点切换（高峰 → 空闲）", () => {
  const next = nextPeakTransition(T_PEAK, timezone, peakWindows, peakWeekdays);
  assert.equal(next.at, bj(2026, 8, 17, 12, 0));
  assert.equal(next.peak, false);
  assert.equal(next.mode, "offPeak");
});

test("nextPeakTransition：午休结束后回到高峰（空闲 → 高峰）", () => {
  const next = nextPeakTransition(bj(2026, 8, 17, 12, 30), timezone, peakWindows, peakWeekdays);
  assert.equal(next.at, bj(2026, 8, 17, 14, 0));
  assert.equal(next.mode, "peak");
});

test("nextPeakTransition：跨夜与跨周末的切换（周一 09:00 / 下周一 09:00）", () => {
  const overNight = nextPeakTransition(T_OFF, timezone, peakWindows, peakWeekdays);
  assert.equal(overNight.at, bj(2026, 8, 18, 9, 0)); // 周二 09:00
  assert.equal(overNight.mode, "peak");

  // 周五 18:00 之后：周末全天空闲，直到下周一 09:00。
  const overWeekend = nextPeakTransition(bj(2026, 8, 21, 18, 0), timezone, peakWindows, peakWeekdays);
  assert.equal(overWeekend.at, bj(2026, 8, 24, 9, 0));
  assert.equal(overWeekend.mode, "peak");
});

test("nextPeakTransition：整点边界（窗口起点即为当前状态时不误报切换）", () => {
  const atStart = nextPeakTransition(bj(2026, 8, 17, 9, 0), timezone, peakWindows, peakWeekdays);
  assert.equal(atStart.at, bj(2026, 8, 17, 12, 0));
  assert.equal(atStart.mode, "offPeak");
});

test("nextPeakTransition：不限星期时仅按窗口切换", () => {
  const next = nextPeakTransition(bj(2026, 8, 22, 10, 0), timezone, peakWindows); // 周六 10:00（不限星期=高峰）
  assert.equal(next.at, bj(2026, 8, 22, 12, 0));
  assert.equal(next.mode, "offPeak");
});

test("cacheHitPercent：命中率按提示侧输入计算，无可计费输入时为 null", () => {
  assert.equal(cacheHitPercent(1_000, 9_000), 90);
  assert.equal(cacheHitPercent(0, 1_000), 100);
  assert.equal(cacheHitPercent(1_000, 0), 0);
  assert.equal(cacheHitPercent(0, 0), null);
  assert.equal(cacheHitPercent(Number.NaN, -5), null);
  assert.equal(cacheHitPercent(2_000, 1_000), 33.3);
});

test("priceAt：峰谷之前的时段为平价（flat）", () => {
  const flat = priceAt("deepseek-v4-flash", T_FLAT, opts);
  assert.equal(flat.mode, "flat");
  assert.equal(flat.cny.input, 1);
  assert.equal(flat.cny.cacheRead, 0.02);
  assert.equal(flat.cny.output, 2);
  assert.equal(flat.billedAs, "deepseek-v4-flash");
});

test("priceAt：2026-08-17 峰谷价（历史政策沿用，未受新价影响）", () => {
  const peak = priceAt("deepseek-v4-flash", T_PEAK, opts);
  assert.equal(peak.mode, "peak");
  assert.equal(peak.cny.input, 3);
  assert.equal(peak.cny.cacheRead, 0.1);
  assert.equal(peak.cny.output, 9);
  assert.equal(peak.billedAs, "deepseek-v4-flash");

  const off = priceAt("deepseek-v4-flash", T_OFF, opts);
  assert.equal(off.mode, "offPeak");
  assert.equal(off.cny.input, 1.5); // 空闲 = 高峰半价
  assert.equal(off.cny.output, 4.5);

  const pro = priceAt("deepseek-v4-pro", T_PEAK, opts);
  assert.equal(pro.cny.input, 9);
  assert.equal(pro.cny.output, 27);
});

test("priceAt：deepseek-flash（V4.1 Flash）2026-09-10 起的新价（双币种）", () => {
  const peak = priceAt("deepseek-flash", T_V41_PEAK, opts);
  assert.equal(peak.mode, "peak");
  assert.deepEqual(peak.cny, { input: 2, cacheRead: 0.04, output: 8 });
  assert.deepEqual(peak.usd, { input: 0.3, cacheRead: 0.006, output: 1.2 });
  assert.equal(peak.billedAs, "deepseek-flash");

  const off = priceAt("deepseek-flash", T_V41_OFF, opts);
  assert.equal(off.mode, "offPeak");
  assert.deepEqual(off.cny, { input: 1, cacheRead: 0.02, output: 4 }); // 空闲半价
  assert.deepEqual(off.usd, { input: 0.15, cacheRead: 0.003, output: 0.6 });
});

test("priceAt：周末高峰窗口内按空闲计价（官方高峰仅周一至周五）", () => {
  const flash = priceAt("deepseek-flash", T_WEEKEND, opts);
  assert.equal(flash.mode, "offPeak");
  assert.deepEqual(flash.cny, { input: 1, cacheRead: 0.02, output: 4 });

  const pro = priceAt("deepseek-v4-pro", T_WEEKEND, opts);
  assert.equal(pro.mode, "offPeak");
  assert.deepEqual(pro.cny, { input: 4.5, cacheRead: 0.15, output: 13.5 });
});

test("priceAt：已下线旧名 v4-flash / v4-flash-vision-exp 按 V4.1 Flash 单价计费", () => {
  for (const name of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    for (const [time, mode] of [[T_V41_PEAK, "peak"], [T_V41_OFF, "offPeak"]]) {
      const routed = priceAt(name, time, opts);
      const flash = priceAt("deepseek-flash", time, opts);
      assert.equal(routed.mode, mode);
      assert.equal(routed.billedAs, "deepseek-flash"); // 官方：请求由 V4.1 Flash 提供服务
      assert.deepEqual(routed.cny, flash.cny);
      assert.deepEqual(routed.usd, flash.usd);
    }
  }
  // 兼容路由生效之前，旧名仍按自己的价格计费
  const legacy = priceAt("deepseek-v4-flash", T_PEAK, opts);
  assert.equal(legacy.billedAs, "deepseek-v4-flash");
  assert.equal(legacy.cny.input, 3);
});

test("priceAt：2026-09-14 12:00 起 v4-pro 全量路由至 V4.1 Flash", () => {
  const before = priceAt("deepseek-v4-pro", T_PRO_LAST, opts);
  assert.equal(before.billedAs, "deepseek-v4-pro");
  assert.equal(before.mode, "peak");
  assert.equal(before.cny.input, 9);
  assert.equal(before.cny.output, 27);

  const after = priceAt("deepseek-v4-pro", T_PRO_ROUTED, opts);
  assert.equal(after.billedAs, "deepseek-flash");
  assert.deepEqual(after.cny, { input: 1, cacheRead: 0.02, output: 4 }); // 12:00 起为空闲时段
  const flash = priceAt("deepseek-flash", T_PRO_ROUTED, opts);
  assert.deepEqual(after.cny, flash.cny);

  // 2026-09-10 至 2026-09-14 12:00 之间：v4-pro 单价不变
  const mid = priceAt("deepseek-v4-pro", T_V41_PEAK, opts);
  assert.equal(mid.billedAs, "deepseek-v4-pro");
  assert.equal(mid.cny.input, 9);
});

test("priceAt：未点名的模型按 `*` 兜底为零（不误报费用）", () => {
  const unknown = priceAt("some-other-model", T_V41_PEAK, opts);
  assert.equal(unknown.billedAs, "some-other-model");
  assert.equal(unknown.cny.input, 0);
  assert.equal(unknown.usd.output, 0);
});

test("costOf：按 token 与单价计算双币种费用", () => {
  const unit = { cny: { input: 2, cacheRead: 0.04, output: 8 }, usd: { input: 0.3, cacheRead: 0.006, output: 1.2 } };
  const cost = costOf({ inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, unit);
  assert.equal(cost.cost, 2);
  assert.equal(cost.costUsd, 0.3);
  const cost2 = costOf({ inputTokens: 0, cacheReadTokens: 2_000_000, outputTokens: 500_000 }, unit);
  assert.equal(cost2.cost, 2 * 0.04 + 0.5 * 8);
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
