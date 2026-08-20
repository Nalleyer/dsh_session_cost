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
 */

/** 零单价（模型未在点名表中时的兜底）。 */
const ZERO_UNIT = Object.freeze({ input: 0, cacheRead: 0, output: 0 });

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

/** 该时刻是否处于高峰时段（按指定时区与窗口判定；窗口为 [start, end) 小时）。 */
export function isPeak(timeMs, timezone, windows) {
  let hour;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "numeric",
      minute: "numeric"
    }).formatToParts(new Date(timeMs));
    hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  } catch {
    // 非法时区等异常按非高峰处理，不阻断记账。
    hour = -1;
  }
  return windows.some(([start, end]) => hour >= start && hour < end);
}

/** 在单张价格表内取模型单价（含 `*` 兜底）。 */
export function priceFor(model, table) {
  return table[model] ?? table["*"] ?? { cny: ZERO_UNIT, usd: ZERO_UNIT };
}

/**
 * 计算某模型在某一时刻的单价（双币种）。
 *
 * 解析顺序（政策链继承）：
 * 1. 从新到旧遍历「不晚于消息时刻」的政策，取第一个**点名该模型**的政策单价
 *    （被新政策下架的模型自动沿用旧政策价格，历史账单才与平台一致）；
 * 2. 没有任何政策点名 → 用最新适用政策的 `*` 兜底；
 *
 * @param model - 模型名。
 * @param timeMs - 消息时间（epoch ms）。
 * @param opts - { policies, timezone, peakWindows }。
 * @returns { cny, usd, mode, policy } — mode: 'flat' | 'peak' | 'offPeak'。
 */
export function priceAt(model, timeMs, opts) {
  const { timezone, peakWindows, policies } = opts;
  const peak = isPeak(timeMs, timezone, peakWindows);
  const applicable = policies.filter((policy) => timeMs >= Date.parse(policy.since));
  const scope = applicable.length > 0 ? applicable : [policies[0]];
  let winner;
  let baseTable;
  for (let index = scope.length - 1; index >= 0; index--) {
    const policy = scope[index];
    const table = policy.peak !== void 0 && policy.offPeak !== void 0
      ? (peak ? policy.peak : policy.offPeak)
      : policy.prices;
    if (table[model] !== void 0) {
      winner = policy;
      baseTable = table;
      break;
    }
  }
  if (winner === void 0) {
    winner = scope[scope.length - 1];
    baseTable = winner.peak !== void 0 && winner.offPeak !== void 0
      ? (peak ? winner.peak : winner.offPeak)
      : winner.prices;
  }
  const unit = priceFor(model, baseTable);
  return {
    cny: unit.cny,
    usd: unit.usd,
    mode: winner.peak !== void 0 && winner.offPeak !== void 0 ? (peak ? "peak" : "offPeak") : "flat",
    policy: { since: winner.since, label: winner.label }
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
