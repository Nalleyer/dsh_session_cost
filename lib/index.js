/**
 * dsh-session-cost — host face.
 *
 * 为浏览器侧提供「本会话消耗」的记账与查询：客户端把角标追加在聊天界面底部信息栏
 * （官方 stats 行）的右端，点开是一份详细菜单。仅支持 DeepSeek 官方在售及兼容期内的模型
 * （deepseek-flash / deepseek-v4-pro / deepseek-v4-flash / deepseek-v4-flash-vision-exp）。
 * 价格数据来自 lib/pricing-data.json（由插件作者随官方调价维护），按每条 assistant 消息
 * 完成时刻取价：峰谷定价（2026-08-17 起）高峰为北京时间**周一至周五**
 * 09:00–12:00 / 14:00–18:00，其余时段（含周末）空闲半价；旧模型名的兼容路由
 * （2026-09-10 起 v4-flash 系列、2026-09-14 12:00 起 v4-pro 全部路由至 V4.1 Flash）
 * 声明在数据文件的 `policies[].routes`，按真正提供服务的模型单价计费。
 * 非上述模型的会话不显示角标。
 *
 * 端点（仅回环）：
 *   GET /session-cost/session/<id>         → { ok, sessionId, cost, costUsd, …, lastMode, supported, displayCurrency, symbol, symbolUsd }
 *   GET /session-cost/session/<id>/detail  → 上列总量 + 按模型/按时段聚合 + 当前单价 + 下一处峰谷切换（信息栏角标点开时才请求）
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { URL } from "node:url";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import {
  addCounts,
  addTrimmed,
  cacheHitPercent,
  costOf,
  nextPeakTransition,
  priceAt,
  zeroCounts,
  zeroTrimmed
} from "./pricing.js";

/** Stable Cordis plugin name. */
const name = "dsh-session-cost";

/** 价格数据（模型表 + 政策时间表 + 峰谷时段）来自数据文件，不写进代码。 */
const PRICING_DATA = JSON.parse(
  readFileSync(new URL("./pricing-data.json", import.meta.url), "utf8")
);
const POLICIES = PRICING_DATA.policies;
const TIMEZONE = PRICING_DATA.timezone;
const PEAK_WINDOWS = PRICING_DATA.peakWindows;
const PEAK_WEEKDAYS = PRICING_DATA.peakWeekdays;
const SUPPORTED_MODELS = new Set(PRICING_DATA.models);

/**
 * 重估时判定会话是否仍应标记 unsupported（官方改模型名/扩表后，陈旧标记需能自愈）：
 * - 账本记录过「不支持的模型名」→ 按当前模型表重新判定，全部已支持则恢复显示；
 * - 旧账本没记录模型名 → 仅在会话没有任何可用明细（calls === 0）时清除陈旧标记；
 *   有明细的会话保守保留，避免显示出「只算了部分模型」的片面金额。
 * @internal
 */
function stillUnsupported(models, calls) {
  if (models !== void 0) return models.some((model) => !SUPPORTED_MODELS.has(model));
  return calls > 0;
}

/** 服务要求：webServer 提供查询端点。 */
const inject = ["webServer"];

const Config = z.object({
  /** 人民币展示符号。 */
  symbol: z.string().default("¥"),
  /** 美元展示符号。 */
  symbolUsd: z.string().default("$"),
  /** auto=跟随界面语言（英文界面显示 USD）；CNY/USD=强制指定展示币种。 */
  displayCurrency: z.union([z.const("auto"), z.const("CNY"), z.const("USD")]).default("auto"),
  /** 账本文件；默认落在 $DSH_HOME/storages 下。 */
  persistPath: z.string().min(1).default(dshHomePath("storages", "session-cost.json")),
  /** 每个会话消息级明细保留条数。 */
  maxMessagesPerSession: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2000),
  /** /session-cost 端点仅允许回环地址访问（默认开）。 */
  loopbackOnly: z.boolean().default(true)
});

/**
 * 持久化账本：按会话聚合「本会话消耗」+ 每会话保留的消息级明细（用于计价规则变化时重估）。
 * 写盘做 1s 防抖 + 临时文件原子替换；加载失败时从空账本开始并告警。
 * @internal 导出仅为单测使用，不属于插件公开 API。
 */
class SessionCostLedger {
  constructor(path, maxMessagesPerSession) {
    this.path = path;
    this.maxMessagesPerSession = maxMessagesPerSession;
    this.bySession = /* @__PURE__ */ new Map();
    this.writeTimer = null;
    this.pendingWrite = null;
    this.pricingHash = "";
    this.dirty = false;
  }

  load() {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      if (raw?.version !== 1) return;
      this.bySession = new Map(Object.entries(raw.sessions ?? {}).map(([id, value]) => [id, {
        ...zeroCounts(),
        ...value,
        unsupported: value.unsupported === true,
        unsupportedModels: Array.isArray(value.unsupportedModels)
          ? value.unsupportedModels.filter((model) => typeof model === "string")
          : void 0,
        trimmed: value.trimmed !== void 0 ? { ...zeroTrimmed(), ...value.trimmed } : zeroTrimmed(),
        messages: new Map(Object.entries(value.messages ?? {}))
      }]));
      this.pricingHash = typeof raw.pricingHash === "string" ? raw.pricingHash : "";
    } catch (error) {
      console.warn("[dsh-session-cost] ledger load failed, starting empty:", error?.message ?? error);
    }
  }

  /**
   * 计价规则变化后重估：以保留的逐条记录为唯一来源，按每条消息时刻重新取价重建聚合。
   * 被裁剪掉的旧消息（trimmed 聚合）不参与逐条重建，直接保留；unsupported 标记按当前
   * 模型表重新判定（见 stillUnsupported），官方改模型名后可自愈。
   */
  reprice(pricing) {
    if (this.pricingHash === pricing.hash) return;
    const entries = [];
    const extras = [];
    for (const [sessionId, session] of this.bySession) {
      extras.push({
        sessionId,
        unsupported: session.unsupported === true,
        unsupportedModels: session.unsupportedModels,
        trimmed: session.trimmed?.calls > 0 ? session.trimmed : void 0,
        lastTime: session.lastTime,
        lastMode: session.lastMode
      });
      for (const [messageId, message] of session.messages) {
        entries.push({ sessionId, messageId, time: message.time, provider: message.provider, model: message.model, ...message });
      }
    }
    this.bySession = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      this.record({ ...entry, ...this.price(entry.model, entry.provider, entry.time, entry, pricing) });
    }
    for (const extra of extras) {
      let session = this.bySession.get(extra.sessionId);
      if (session === void 0) {
        session = { ...zeroCounts(), trimmed: zeroTrimmed(), messages: /* @__PURE__ */ new Map() };
        this.bySession.set(extra.sessionId, session);
      }
      if (extra.trimmed !== void 0) {
        session.trimmed = { ...zeroTrimmed(), ...extra.trimmed };
        addTrimmed(session, session.trimmed);
      }
      // 记下的模型名无条件带回（已自愈的会话也要保留，供下次调价再判定）；
      // 标记本身在 trimmed 并入之后再判定——calls 需包含被裁剪的旧消息贡献。
      if (extra.unsupportedModels !== void 0) session.unsupportedModels = extra.unsupportedModels;
      if (extra.unsupported === true) {
        session.unsupported = stillUnsupported(extra.unsupportedModels, session.calls);
      }
      // 最新消息可能已被裁剪；保留会话级角标，避免重估后退回到较旧明细。
      if (extra.lastTime !== void 0 && (session.lastTime === void 0 || extra.lastTime >= session.lastTime)) {
        session.lastTime = extra.lastTime;
        session.lastMode = extra.lastMode;
      }
    }
    this.pricingHash = pricing.hash;
    this.dirty = true;
    this.scheduleWrite();
  }

  /** 按定价上下文计算一条消息的费用（双币种，含计价模式与实际计费模型名）。 */
  price(model, provider, time, tokens, pricing) {
    const nominal = pricing.at(model, time);
    const actual = costOf(tokens, nominal);
    return {
      ...actual,
      costNominal: actual.cost,
      costNominalUsd: actual.costUsd,
      savings: 0,
      savingsUsd: 0,
      isLocal: false,
      mode: nominal.mode,
      billedAs: nominal.billedAs
    };
  }

  /**
   * 标记某会话含不支持的模型（用于隐藏角标），并记下具体的模型名——官方改名/扩表后
   * 重估时可据此重新判定该标记是否仍成立（见 stillUnsupported）。
   */
  markUnsupported(sessionId, model) {
    let session = this.bySession.get(sessionId);
    if (session === void 0) {
      session = { ...zeroCounts(), trimmed: zeroTrimmed(), messages: /* @__PURE__ */ new Map() };
      this.bySession.set(sessionId, session);
    }
    let changed = false;
    if (typeof model === "string" && model !== "") {
      const known = session.unsupportedModels ?? [];
      if (!known.includes(model)) {
        session.unsupportedModels = [...known, model];
        changed = true;
      }
    }
    if (session.unsupported !== true) {
      session.unsupported = true;
      changed = true;
    }
    if (changed) {
      this.dirty = true;
      this.scheduleWrite();
    }
  }

  /**
   * 记一笔。以 (sessionId, messageId) 为主键幂等：重复/重放事件只覆盖明细并撤销
   * 会话级旧计数，绝不重复累计。注：dsh-session 的构造 seed 不会重新走
   * session/event firehose，重启后历史事件不会重放给本插件——幂等主要防御
   * 重复投递与插件热重载；明细裁剪（见下）后若同一条消息再次以新条目出现，
   * 其费用会与 trimmed 聚合叠加，属已知边界（正常投递路径不会发生）。
   */
  record(entry) {
    let session = this.bySession.get(entry.sessionId);
    if (session === void 0) {
      session = { ...zeroCounts(), trimmed: zeroTrimmed(), messages: /* @__PURE__ */ new Map() };
      this.bySession.set(entry.sessionId, session);
    }
    const previous = session.messages.get(entry.messageId);
    if (previous !== void 0) {
      session.calls -= 1;
      session.cost -= previous.cost;
      session.costUsd -= previous.costUsd;
      session.costNominal -= previous.costNominal;
      session.costNominalUsd -= previous.costNominalUsd;
      session.savings -= previous.savings;
      session.savingsUsd -= previous.savingsUsd;
      session.inputTokens -= previous.inputTokens;
      session.cacheReadTokens -= previous.cacheReadTokens;
      session.outputTokens -= previous.outputTokens;
    } else {
      addCounts(session, entry);
    }
    // 最近计价模式：以消息时刻最新者为准，用于信息栏的「高峰 / 空闲」角标。
    // lastTime 初始为 undefined（新会话/旧账本），必须显式兜底，否则首次比较恒 false。
    if (session.lastTime === void 0 || entry.time >= session.lastTime) {
      session.lastTime = entry.time;
      session.lastMode = entry.mode;
    }
    session.messages.set(entry.messageId, {
      cost: entry.cost,
      costUsd: entry.costUsd,
      costNominal: entry.costNominal,
      costNominalUsd: entry.costNominalUsd,
      savings: entry.savings,
      savingsUsd: entry.savingsUsd,
      isLocal: entry.isLocal === true,
      model: entry.model,
      provider: entry.provider,
      time: entry.time,
      inputTokens: entry.inputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      outputTokens: entry.outputTokens,
      mode: entry.mode,
      billedAs: entry.billedAs
    });
    // 明细超限时裁剪最旧的记录：会话级总额保持完整（含被裁消息），被裁贡献
    // 并入 session.trimmed，保证后续 reprice 重建后总额不缩水。
    if (session.messages.size > this.maxMessagesPerSession) {
      const oldest = [...session.messages.keys()].slice(0, session.messages.size - this.maxMessagesPerSession);
      for (const key of oldest) {
        const detail = session.messages.get(key);
        if (detail !== void 0) addCounts(session.trimmed, detail);
        session.messages.delete(key);
      }
    }
    this.dirty = true;
    this.scheduleWrite();
  }

  /** 防抖写盘（1s）。 */
  scheduleWrite() {
    if (this.writeTimer !== null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush().catch((error) => {
        console.warn("[dsh-session-cost] scheduled ledger flush failed:", error?.message ?? error);
      });
    }, 1000);
  }

  /** 将一个快照写入磁盘；每次使用独立临时文件，避免热重载时互相覆盖。 */
  async writeSnapshot(body) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, body, "utf8");
      await rename(tmp, this.path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** 立即落盘（进程退出前调用），并确保写入期间到达的最后一笔也被保存。 */
  async flush() {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    for (;;) {
      if (this.pendingWrite !== null) {
        await this.pendingWrite;
        continue;
      }
      if (!this.dirty) return;
      const body = JSON.stringify({
        version: 1,
        pricingHash: this.pricingHash,
        sessions: Object.fromEntries([...this.bySession].map(([id, value]) => [id, {
          calls: value.calls,
          cost: value.cost,
          costUsd: value.costUsd,
          costNominal: value.costNominal,
          costNominalUsd: value.costNominalUsd,
          savings: value.savings,
          savingsUsd: value.savingsUsd,
          inputTokens: value.inputTokens,
          cacheReadTokens: value.cacheReadTokens,
          outputTokens: value.outputTokens,
          lastMode: value.lastMode,
          lastTime: value.lastTime,
          unsupported: value.unsupported === true,
          unsupportedModels: value.unsupportedModels,
          trimmed: value.trimmed ?? zeroTrimmed(),
          messages: Object.fromEntries(value.messages)
        }]))
      });
      this.dirty = false;
      const write = this.writeSnapshot(body);
      this.pendingWrite = write;
      try {
        await write;
      } catch (error) {
        this.dirty = true;
        throw error;
      } finally {
        if (this.pendingWrite === write) this.pendingWrite = null;
      }
    }
  }

  /** 会话级公开视图。 */
  sessionView(id) {
    const session = this.bySession.get(id);
    if (session === void 0) return void 0;
    return {
      sessionId: id,
      calls: session.calls,
      cost: session.cost,
      costUsd: session.costUsd,
      savings: session.savings,
      savingsUsd: session.savingsUsd,
      inputTokens: session.inputTokens,
      cacheReadTokens: session.cacheReadTokens,
      outputTokens: session.outputTokens,
      lastMode: session.lastMode,
      supported: session.unsupported !== true
    };
  }

  /**
   * 会话明细视图：在总量之外给出「按模型」「按时段」聚合与首末计费时刻。
   *
   * 只做聚合、不取价——单价与峰谷状态由 host 用定价上下文补齐（见 detailPayload）。
   * 被裁剪的旧消息只留在 trimmed 聚合里，不参与按模型拆分（其模型名已不可考）。
   * @internal 导出仅为单测使用，不属于插件公开 API。
   */
  detail(id) {
    const session = this.bySession.get(id);
    if (session === void 0) return void 0;
    const models = /* @__PURE__ */ new Map();
    const modes = { peak: zeroBucket(), offPeak: zeroBucket(), flat: zeroBucket() };
    let firstTime;
    let lastTime;
    let lastModel;
    let lastBilledAs;
    for (const message of session.messages.values()) {
      const model = typeof message.model === "string" ? message.model : "unknown";
      const billedAs = typeof message.billedAs === "string" ? message.billedAs : model;
      const key = `${model}\u0000${billedAs}`;
      let entry = models.get(key);
      if (entry === void 0) {
        entry = {
          model,
          billedAs,
          calls: 0,
          cost: 0,
          costUsd: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0
        };
        models.set(key, entry);
      }
      entry.calls += 1;
      entry.cost += finite(message.cost);
      entry.costUsd += finite(message.costUsd);
      entry.inputTokens += finite(message.inputTokens);
      entry.cacheReadTokens += finite(message.cacheReadTokens);
      entry.outputTokens += finite(message.outputTokens);
      const bucket = modes[message.mode] ?? modes.flat;
      bucket.calls += 1;
      bucket.cost += finite(message.cost);
      bucket.costUsd += finite(message.costUsd);
      const time = message.time;
      if (Number.isFinite(time)) {
        if (firstTime === void 0 || time < firstTime) firstTime = time;
        if (lastTime === void 0 || time >= lastTime) {
          lastTime = time;
          lastModel = model;
          lastBilledAs = billedAs;
        }
      }
    }
    return {
      calls: session.calls,
      cost: finite(session.cost),
      costUsd: finite(session.costUsd),
      savings: finite(session.savings),
      savingsUsd: finite(session.savingsUsd),
      inputTokens: finite(session.inputTokens),
      cacheReadTokens: finite(session.cacheReadTokens),
      outputTokens: finite(session.outputTokens),
      lastMode: session.lastMode,
      supported: session.unsupported !== true,
      firstTime,
      lastTime,
      lastModel,
      lastBilledAs,
      models: [...models.values()].sort((left, right) => right.cost - left.cost),
      modes,
      trimmed: session.trimmed ?? zeroTrimmed()
    };
  }
}

/** 非有限数值一律按 0 处理（旧账本可能缺少字段）。 */
function finite(value) {
  return Number.isFinite(value) ? value : 0;
}

/** 空时段聚合（按计价模式拆分费用）。 */
function zeroBucket() {
  return { calls: 0, cost: 0, costUsd: 0 };
}

/**
 * 明细响应体：账本聚合 + 当前定价（下一条消息的单价、下一处峰谷切换、价格数据来源）。
 *
 * 单价按**最近计费的模型**在当前时刻取——即「下一条消息会按什么价计费」；账本里记的
 * 是每条消息各自时刻的价，历史金额不随当前时段变化。
 * @internal 导出仅为单测使用，不属于插件公开 API。
 */
function detailPayload(view, sessionId, now, pricing, config) {
  const totals = view ?? {
    calls: 0,
    cost: 0,
    costUsd: 0,
    savings: 0,
    savingsUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    lastMode: "flat",
    supported: true,
    models: [],
    modes: { peak: zeroBucket(), offPeak: zeroBucket(), flat: zeroBucket() },
    trimmed: zeroTrimmed()
  };
  const unit = totals.lastModel === void 0 ? null : pricing.at(totals.lastModel, now);
  const transition = pricing.next(now);
  return {
    ok: true,
    ...totals,
    sessionId,
    cacheHitPercent: cacheHitPercent(totals.inputTokens, totals.cacheReadTokens),
    serverTime: now,
    pricing: unit === null ? null : {
      model: totals.lastModel,
      billedAs: unit.billedAs,
      mode: unit.mode,
      cny: unit.cny,
      usd: unit.usd,
      since: unit.policy?.since,
      label: unit.policy?.label,
      checkedAt: PRICING_DATA.source?.checkedAt,
      source: PRICING_DATA.source?.pricing
    },
    nextSwitch: transition === null ? null : { at: transition.at, mode: transition.mode },
    displayCurrency: config.displayCurrency,
    symbol: config.symbol,
    symbolUsd: config.symbolUsd
  };
}

/** 统一 JSON 响应。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

/** 回环地址判定（IPv4 127/8、IPv6 ::1）。 */
function isLoopbackAddress(address) {
  if (address === "::1" || address === "::ffff:127.0.0.1" || address === "127.0.0.1") return true;
  if (typeof address === "string" && address.startsWith("127.")) {
    const octets = address.split(".");
    return octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }
  return false;
}

/**
 * 处理一条 session/event；单独抽出以便验证可选 usage 与模型支持判定的顺序。
 * @internal
 */
function recordSessionEvent(ledger, headersBySession, session, event, pricing) {
  if (event?.type === "request/header" && event.data?.header?.config) {
    const header = event.data.header.config;
    if (typeof header.provider === "string" && typeof header.model === "string") {
      headersBySession.set(session.id, { provider: header.provider, model: header.model });
    }
    return;
  }
  if (event?.type !== "assistant/message") return;
  const data = event.data;
  const source = data?.message?.source;
  const header = headersBySession.get(session.id);
  const provider = typeof source?.provider === "string" ? source.provider : header?.provider ?? "";
  const model = typeof source?.model === "string" ? source.model : header?.model ?? "unknown";
  // 先判断模型，再判断 usage：usage 是可选字段，但不支持的模型仍应隐藏角标。
  if (!SUPPORTED_MODELS.has(model)) {
    ledger.markUnsupported(session.id, model);
    return;
  }
  if (data?.usage === void 0 || data.usage === null) return;
  const usage = data.usage;
  if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return;
  const tokenFields = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens];
  if (tokenFields.some((value) => value !== void 0 && value !== null && (!Number.isFinite(value) || value < 0))) return;
  if (!Number.isFinite(event.time)) return;
  ledger.record({
    sessionId: session.id,
    messageId: String(data.message?.id ?? `seq-${event.seq}`),
    seq: event.seq,
    time: event.time,
    provider,
    model,
    ...ledger.price(model, provider, event.time, usage, pricing)
  });
}

/**
 * 应用插件：订阅会话事件记账，挂 /session-cost 查询路由。
 * @param ctx - plugin context carrying webServer。
 * @param config - validated {@link Config}。
 */
function apply(ctx, config) {
  const ledger = new SessionCostLedger(config.persistPath, config.maxMessagesPerSession);
  ledger.load();
  const pricing = {
    hash: JSON.stringify(PRICING_DATA),
    at: (model, time) => priceAt(model, time, {
      timezone: TIMEZONE,
      peakWindows: PEAK_WINDOWS,
      peakWeekdays: PEAK_WEEKDAYS,
      policies: POLICIES
    }),
    /** 下一处峰谷切换（明细菜单用）。 */
    next: (time) => nextPeakTransition(time, TIMEZONE, PEAK_WINDOWS, PEAK_WEEKDAYS)
  };
  // 计价规则与账本记录不一致时，用当前规则重估全部存量记录。
  ledger.reprice(pricing);
  const headersBySession = /* @__PURE__ */ new Map();

  ctx.on("session/event", (session, event) => {
    try {
      recordSessionEvent(ledger, headersBySession, session, event, pricing);
    } catch (error) {
      ctx.logger.warn(`[dsh-session-cost] record failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const onSettle = () => {
    void ledger.flush().catch((error) => {
      ctx.logger.warn(`[dsh-session-cost] flush failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const settled = ctx.get("loader")?.await();
  if (settled === void 0) onSettle();
  else settled.then(onSettle, () => {});

  ctx.effect(() => () => {
    void ledger.flush().catch((error) => {
      ctx.logger.warn(`[dsh-session-cost] teardown flush failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, "dsh-session-cost: teardown flush");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/session-cost",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      if (config.loopbackOnly) {
        const address = req.socket.remoteAddress ?? "";
        if (!isLoopbackAddress(address)) {
          sendJson(res, 403, { ok: false, error: "loopback-only" });
          return;
        }
      }
      const pathname = (() => {
        try {
          return decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
        } catch {
          // 畸形百分号编码：不抛给上层，直接 400。
          return null;
        }
      })();
      if (pathname === null) {
        sendJson(res, 400, { ok: false, error: "bad-request" });
        return;
      }
      const tail = pathname.startsWith("/session-cost") ? pathname.slice("/session-cost".length) : "";
      // 明细菜单：账本聚合 + 当前单价 + 下一处峰谷切换（点开信息栏角标时才请求）。
      const detailMatch = /^\/session\/([^/]+)\/detail$/.exec(tail);
      if (detailMatch !== null) {
        sendJson(res, 200, detailPayload(
          ledger.detail(detailMatch[1]),
          detailMatch[1],
          Date.now(),
          pricing,
          config
        ));
        return;
      }
      const sessionMatch = /^\/session\/([^/]+)$/.exec(tail);
      if (sessionMatch !== null) {
        const view = ledger.sessionView(sessionMatch[1]);
        if (view === void 0) {
          sendJson(res, 200, {
            ok: true,
            sessionId: sessionMatch[1],
            calls: 0,
            cost: 0,
            costUsd: 0,
            savings: 0,
            savingsUsd: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            lastMode: "flat",
            supported: true,
            displayCurrency: config.displayCurrency,
            symbol: config.symbol,
            symbolUsd: config.symbolUsd
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          ...view,
          displayCurrency: config.displayCurrency,
          symbol: config.symbol,
          symbolUsd: config.symbolUsd
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: "not-found" });
    }
  }), "dsh-session-cost: /session-cost routes");
}

export { Config, SessionCostLedger, apply, detailPayload, inject, name, recordSessionEvent };
