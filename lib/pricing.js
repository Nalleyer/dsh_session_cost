/**
 * dsh-session-cost — pricing engine (pure functions, no price data).
 *
 * 纯函数定价模块：把「政策时间表 + 峰谷时段」解析成某条消息在某一时刻应使用的单价
 * （**双币种：CNY 与 USD**）。价格数据不在此处——由宿主从 lib/pricing-data.json
 * 读取后通过参数传入，便于插件作者随官方调价更新，而无需改动逻辑代码。
 *
 * 语义约定（与 DeepSeek 官方与 provider 适配器一致）：
 * - input      缓存未命中输入
 * - cacheRead  缓存命中输入
 * - output     输出
 * 单价单位：每 1M tokens，人民币（cny）与美元（usd）各一份；官方美元价由 DeepSeek
 * 独立发布，不是汇率换算。
 *
 * 政策（policy）可携带三种信息，均为可选：
 * - `prices`           平价表（未启用峰谷定价的时期）；
 * - `peak` / `offPeak` 峰谷双表（启用峰谷后，空闲时段为高峰半价）；
 * - `routes`           路由表：该政策生效期内 `{ 请求模型名: 实际提供服务并按之计费的模型名 }`。
 *   官方下线旧模型名但保留兼容期时（如 v4-flash 系列暂路由至 deepseek-flash、v4-pro 于
 *   2026-09-14 12:00 起全量路由至 V4.1 Flash），被路由的名字**不重复写价**——单价由目标模型
 *   在该政策链上的价格行决定，避免同一组数字在多处维护而漂移。
 */

/** 零单价（模型未在点名表中时的兜底）。 */
const ZERO_UNIT = Object.freeze({ input: 0, cacheRead: 0, output: 0 });

/** Intl `weekday: "short"`（en-US）→ ISO 序号（周一 1 … 周日 7）。 */
const WEEKDAY_INDEX = Object.freeze({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 });

/** TokenUsage 来自外部 provider；拒绝负数、NaN、Infinity 和隐式字符串。 */
function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * 某时刻生效的政策（第一个 `since` 之前取第一条）。
 * @param timeMs - epoch ms。
 * @param policies - 政策表（来自 lib/pricing-data.json）。
 */
export function activePolicy(timeMs, policies) {
  let active = policies[0];
  for (const policy of policies) {
    const since = Date.parse(policy.since);
    if (Number.isFinite(since) && timeMs >= since) active = policy;
  }
  return active;
}

/**
 * 该时刻是否处于高峰时段（按指定时区、窗口与星期判定）。
 *
 * 窗口为 `[start, end)` 小时；`weekdays` 为 ISO 序号数组（周一 1 … 周日 7），省略或空数组
 * 表示不限星期。官方高峰时段为北京时间**周一至周五** 09:00–12:00 / 14:00–18:00，
 * 其余时段（含周末全天）均为空闲时段。
 */
export function isPeak(timeMs, timezone, windows, weekdays) {
  let hour = -1;
  let weekday = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "numeric",
      weekday: "short"
    }).formatToParts(new Date(timeMs));
    hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
    weekday = WEEKDAY_INDEX[parts.find((part) => part.type === "weekday")?.value ?? ""] ?? 0;
  } catch {
    // 非法时区等异常按非高峰处理，不阻断记账。
    hour = -1;
  }
  if (Array.isArray(weekdays) && weekdays.length > 0 && !weekdays.includes(weekday)) return false;
  return windows.some(([start, end]) => hour >= start && hour < end);
}

/**
 * 下一次峰谷切换：从 `timeMs` 之后的第一个整点起逐小时判定，返回首个与当前
 * 状态不同的整点。峰谷窗口与星期边界都落在整点上（窗口为整点区间、星期在
 * 午夜切换），而 {@link isPeak} 本身只按小时判定，因此逐小时探测与该判定的
 * 粒度完全一致。最远探测 7 天（周末 + 一周窗口），仍未切换则返回 null。
 *
 * @param timeMs - epoch ms。
 * @returns { at, peak, mode } —— `at` 为切换时刻，`peak` 为切换后的状态，
 *   `mode` 为切换后的计价模式（'peak' | 'offPeak'）；无切换时为 null。
 */
export function nextPeakTransition(timeMs, timezone, windows, weekdays) {
  const HOUR = 3600000;
  const current = isPeak(timeMs, timezone, windows, weekdays);
  let at = (Math.floor(timeMs / HOUR) + 1) * HOUR;
  for (let step = 0; step < 24 * 8; step++, at += HOUR) {
    const peak = isPeak(at, timezone, windows, weekdays);
    if (peak !== current) return { at, peak, mode: peak ? "peak" : "offPeak" };
  }
  return null;
}

/**
 * 缓存命中率（百分数，一位小数）：缓存命中输入 / 全部提示侧输入。
 * 没有可计费的提示输入时返回 null（界面显示为「—」）。
 */
export function cacheHitPercent(inputTokens, cacheReadTokens) {
  const billed = tokenCount(inputTokens) + tokenCount(cacheReadTokens);
  if (billed <= 0) return null;
  return Math.round((tokenCount(cacheReadTokens) / billed) * 1000) / 10;
}

/** 在单张价格表内取模型单价（含 `*` 兜底）。 */
export function priceFor(model, table) {
  return table[model] ?? table["*"] ?? { cny: ZERO_UNIT, usd: ZERO_UNIT };
}

/** 该政策内该时刻适用的价格表（峰谷双表齐备时按峰谷取，否则退回平价表）。 */
function tableFor(policy, peak) {
  if (policy === void 0) return void 0;
  if (policy.peak !== void 0 && policy.offPeak !== void 0) return peak ? policy.peak : policy.offPeak;
  return policy.prices;
}

/** 该政策是否为某模型**自带价格行**（与路由区分：自带行优先）。 */
function ownRow(policy, model) {
  return policy?.peak?.[model] !== void 0
    || policy?.offPeak?.[model] !== void 0
    || policy?.prices?.[model] !== void 0;
}

/**
 * 计算某模型在某一时刻的单价（双币种）。
 *
 * 解析顺序（政策链继承）：
 * 1. 从新到旧遍历「不晚于消息时刻」的政策，找到第一个「点名该模型」的政策：自带价格行
 *    则按原名计费；只声明了 `routes` 则改用路由目标（真正提供服务的模型）计费；
 * 2. 按**实际计费名**从新到旧取第一个自带价格行的政策（被新政策下架的模型自动沿用旧政策
 *    价格，历史账单才与平台一致）；
 * 3. 没有任何政策有该名字的价格行 → 用最新适用政策的价格表 + `*` 兜底。
 *
 * @param model - 请求模型名（官方兼容期内的旧模型名亦可）。
 * @param timeMs - 消息时间（epoch ms）。
 * @param opts - { policies, timezone, peakWindows, peakWeekdays }。
 * @returns { cny, usd, mode, policy, billedAs } —— mode: 'flat' | 'peak' | 'offPeak'；
 *   billedAs: 实际计费模型名（未发生路由时等于入参 `model`）。
 */
export function priceAt(model, timeMs, opts) {
  const { timezone, peakWindows, peakWeekdays, policies } = opts;
  const peak = isPeak(timeMs, timezone, peakWindows, peakWeekdays);
  const applicable = policies.filter((policy) => timeMs >= Date.parse(policy.since));
  const scope = applicable.length > 0 ? applicable : [policies[0]];
  // 1) 该时刻生效的模型名路由（自带价格行的名字不参与路由）。
  let billedAs = model;
  for (let index = scope.length - 1; index >= 0; index--) {
    const policy = scope[index];
    if (ownRow(policy, model)) break;
    const target = policy.routes?.[model];
    if (target !== void 0) {
      billedAs = target;
      break;
    }
  }
  // 2) 按实际计费名取价：取该时刻**适用的那张表**里确有该模型行的最新政策。
  let winner;
  let baseTable;
  for (let index = scope.length - 1; index >= 0; index--) {
    const table = tableFor(scope[index], peak);
    if (table !== void 0 && table[billedAs] !== void 0) {
      winner = scope[index];
      baseTable = table;
      break;
    }
  }
  if (winner === void 0) {
    winner = scope[scope.length - 1];
    baseTable = tableFor(winner, peak) ?? {};
  }
  const unit = priceFor(billedAs, baseTable);
  return {
    cny: unit.cny,
    usd: unit.usd,
    mode: winner.peak !== void 0 && winner.offPeak !== void 0 ? (peak ? "peak" : "offPeak") : "flat",
    policy: { since: winner.since, label: winner.label },
    billedAs
  };
}

/** 按 TokenUsage 与单价计算费用（双币种）与 token 拆分。 */
export function costOf(usage, unit) {
  const inputTokens = tokenCount(usage?.inputTokens);
  const cacheReadTokens = tokenCount(usage?.cacheReadTokens);
  const outputTokens = tokenCount(usage?.outputTokens);
  const cost = (inputTokens * unit.cny.input + cacheReadTokens * unit.cny.cacheRead + outputTokens * unit.cny.output) / 1e6;
  const costUsd = (inputTokens * unit.usd.input + cacheReadTokens * unit.usd.cacheRead + outputTokens * unit.usd.output) / 1e6;
  return { inputTokens, cacheReadTokens, outputTokens, cost, costUsd };
}

/** 本地日期键（服务器时区）。 */
export function dayKey(time) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地月份键。 */
export function monthKey(time) {
  return dayKey(time).slice(0, 7);
}

/** 空计数（双币种 + 名义/节省）。 */
export function zeroCounts() {
  return {
    calls: 0,
    cost: 0,
    costUsd: 0,
    costNominal: 0,
    costNominalUsd: 0,
    savings: 0,
    savingsUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    unsupported: false
  };
}

/** 把一次计费并入一个计数对象（双币种 + 名义/节省）。 */
export function addCounts(target, sample) {
  target.calls += 1;
  target.cost += Number.isFinite(sample.cost) ? sample.cost : 0;
  target.costUsd += Number.isFinite(sample.costUsd) ? sample.costUsd : 0;
  target.costNominal += Number.isFinite(sample.costNominal) ? sample.costNominal : 0;
  target.costNominalUsd += Number.isFinite(sample.costNominalUsd) ? sample.costNominalUsd : 0;
  target.savings += Number.isFinite(sample.savings) ? sample.savings : 0;
  target.savingsUsd += Number.isFinite(sample.savingsUsd) ? sample.savingsUsd : 0;
  target.inputTokens += tokenCount(sample.inputTokens);
  target.cacheReadTokens += tokenCount(sample.cacheReadTokens);
  target.outputTokens += tokenCount(sample.outputTokens);
  return target;
}

/** 空「已裁剪明细」聚合：被 maxMessagesPerSession 裁剪掉的旧消息的贡献。 */
export function zeroTrimmed() {
  return {
    calls: 0,
    cost: 0,
    costUsd: 0,
    costNominal: 0,
    costNominalUsd: 0,
    savings: 0,
    savingsUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0
  };
}

/**
 * 把一段已裁剪聚合并入计数对象（按 sample 的实际数值相加；与 addCounts 的
 * 「一次一条消息 +1」语义不同，用于重估时把裁剪掉的旧消息贡献加回会话总额）。
 */
export function addTrimmed(target, sample) {
  target.calls += Number.isFinite(sample.calls) && sample.calls >= 0 ? sample.calls : 0;
  target.cost += Number.isFinite(sample.cost) ? sample.cost : 0;
  target.costUsd += Number.isFinite(sample.costUsd) ? sample.costUsd : 0;
  target.costNominal += Number.isFinite(sample.costNominal) ? sample.costNominal : 0;
  target.costNominalUsd += Number.isFinite(sample.costNominalUsd) ? sample.costNominalUsd : 0;
  target.savings += Number.isFinite(sample.savings) ? sample.savings : 0;
  target.savingsUsd += Number.isFinite(sample.savingsUsd) ? sample.savingsUsd : 0;
  target.inputTokens += tokenCount(sample.inputTokens);
  target.cacheReadTokens += tokenCount(sample.cacheReadTokens);
  target.outputTokens += tokenCount(sample.outputTokens);
  return target;
}
