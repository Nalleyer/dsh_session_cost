/**
 * dsh-session-cost — host face.
 *
 * 在聊天界面底部默认信息栏（conversation.composer.dock）之下追加一行「本会话消耗」，
 * 仅支持 DeepSeek 官方两个模型（deepseek-v4-flash / deepseek-v4-pro）。价格数据来自
 * lib/pricing-data.json（由插件作者随官方调价维护），按每条 assistant 消息完成时刻取价
 * （含 2026-08-17 起的峰谷定价：高峰 09:00–12:00 / 14:00–18:00 北京时间，空闲半价）。
 * 非这两个模型的会话不显示第二行。
 *
 * 端点（仅回环）：
 *   GET /session-cost/session/<id>  → { ok, sessionId, cost, costUsd, …, lastMode, supported, displayCurrency }
 */

import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { URL } from "node:url";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import {
  addCounts,
  costOf,
  priceAt,
  zeroCounts
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
const SUPPORTED_MODELS = new Set(PRICING_DATA.models);

/** 服务要求：webServer 提供查询端点。 */
const inject = ["webServer"];

const Config = z.object({
  currency: z.string().default("CNY"),
  symbol: z.string().default("¥"),
  /** 美元展示符号。 */
  symbolUsd: z.string().default("$"),
  /** auto=跟随界面语言（英文界面显示 USD）；CNY/USD=强制指定展示币种。 */
  displayCurrency: z.union([z.const("auto"), z.const("CNY"), z.const("USD")]).default("auto"),
  /** 账本文件；默认落在 $DSH_HOME/storages 下。 */
  persistPath: z.string().default(dshHomePath("storages", "session-cost.json")),
  /** 每个会话消息级明细保留条数。 */
  maxMessagesPerSession: z.number().default(2000),
  /** /session-cost 端点仅允许回环地址访问（默认开）。 */
  loopbackOnly: z.boolean().default(true)
});

/**
 * 持久化账本：按会话聚合「本会话消耗」+ 每会话消息级明细（用于计价规则变化时重估）。
 * 写盘做 1s 防抖 + 临时文件原子替换；加载失败时从空账本开始并告警。
 */
class SessionCostLedger {
  constructor(path, maxMessagesPerSession) {
    this.path = path;
    this.maxMessagesPerSession = maxMessagesPerSession;
    this.bySession = /* @__PURE__ */ new Map();
    this.writeTimer = null;
    this.pendingWrite = null;
    this.pricingHash = "";
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
        messages: new Map(Object.entries(value.messages ?? {}))
      }]));
      this.pricingHash = typeof raw.pricingHash === "string" ? raw.pricingHash : "";
    } catch (error) {
      console.warn("[dsh-session-cost] ledger load failed, starting empty:", error?.message ?? error);
    }
  }

  /** 计价规则变化后重估：以保留的逐条记录为唯一来源，按每条消息时刻重新取价重建聚合。 */
  reprice(pricing) {
    if (this.pricingHash === pricing.hash) return;
    const entries = [];
    for (const [sessionId, session] of this.bySession) {
      for (const [messageId, message] of session.messages) {
        entries.push({ sessionId, messageId, time: message.time, provider: message.provider, model: message.model, ...message });
      }
    }
    this.bySession = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      this.record({ ...entry, ...this.price(entry.model, entry.provider, entry.time, entry, pricing) });
    }
    this.pricingHash = pricing.hash;
  }

  /** 按定价上下文计算一条消息的费用（双币种，含计价模式）。 */
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
      mode: nominal.mode
    };
  }

  /** 标记某会话含不支持的模型（用于隐藏第二行）。 */
  markUnsupported(sessionId) {
    let session = this.bySession.get(sessionId);
    if (session === void 0) {
      session = { ...zeroCounts(), messages: /* @__PURE__ */ new Map() };
      this.bySession.set(sessionId, session);
    }
    session.unsupported = true;
  }

  /**
   * 记一笔。以 (sessionId, messageId) 为主键幂等：重复/重放事件只覆盖明细并撤销
   * 会话级旧计数，绝不重复累计（服务重启会重放历史事件，这是防重复累计的关键）。
   */
  record(entry) {
    let session = this.bySession.get(entry.sessionId);
    if (session === void 0) {
      session = { ...zeroCounts(), messages: /* @__PURE__ */ new Map() };
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
    if (entry.time >= session.lastTime) {
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
      mode: entry.mode
    });
    if (session.messages.size > this.maxMessagesPerSession) {
      const oldest = [...session.messages.keys()].slice(0, session.messages.size - this.maxMessagesPerSession);
      for (const key of oldest) session.messages.delete(key);
    }
    this.scheduleWrite();
  }

  /** 防抖写盘（1s）。 */
  scheduleWrite() {
    if (this.writeTimer !== null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.pendingWrite ??= this.flush().finally(() => {
        this.pendingWrite = null;
      });
    }, 1000);
  }

  /** 立即落盘（进程退出前调用）。 */
  async flush() {
    if (this.pendingWrite !== null) return this.pendingWrite;
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
        messages: Object.fromEntries(value.messages)
      }]))
    });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, this.path);
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
      policies: POLICIES
    })
  };
  // 计价规则与账本记录不一致时，用当前规则重估全部存量记录。
  ledger.reprice(pricing);
  const headersBySession = /* @__PURE__ */ new Map();

  ctx.on("session/event", (session, event) => {
    try {
      if (event?.type === "request/header" && event.data?.header?.config) {
        const header = event.data.header.config;
        if (typeof header.provider === "string" && typeof header.model === "string") {
          headersBySession.set(session.id, { provider: header.provider, model: header.model });
        }
        return;
      }
      if (event?.type !== "assistant/message") return;
      const data = event.data;
      if (data?.usage === void 0 || data.usage === null) return;
      const usage = data.usage;
      if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return;
      const source = data.message?.source;
      const header = headersBySession.get(session.id);
      const provider = typeof source?.provider === "string" ? source.provider : header?.provider ?? "";
      const model = typeof source?.model === "string" ? source.model : header?.model ?? "unknown";
      // 仅支持官方两个模型；其它模型不计入、并标记该会话以隐藏第二行。
      if (!SUPPORTED_MODELS.has(model)) {
        ledger.markUnsupported(session.id);
        return;
      }
      ledger.record({
        sessionId: session.id,
        messageId: String(data.message?.id ?? `seq-${event.seq}`),
        seq: event.seq,
        time: event.time,
        provider,
        model,
        ...ledger.price(model, provider, event.time, usage, pricing)
      });
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
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      const tail = pathname.startsWith("/session-cost") ? pathname.slice("/session-cost".length) : "";
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
            displayCurrency: config.displayCurrency
          });
          return;
        }
        sendJson(res, 200, { ok: true, ...view, displayCurrency: config.displayCurrency });
        return;
      }
      sendJson(res, 404, { ok: false, error: "not-found" });
    }
  }), "dsh-session-cost: /session-cost routes");
}

export { Config, apply, inject, name };
