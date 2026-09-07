/**
 * dsh-session-cost — client face.
 *
 * 在聊天界面底部默认的信息栏（conversation.composer.dock，stats 行之下，order=1）
 * 渲染「本会话消耗」第二行：从 host 的 /session-cost/session/<id> 拉取当前会话费用，
 * 按界面语言（或配置）在人民币 / 美元之间切换显示，并附带「高峰 / 空闲」计价角标。
 *
 * 纯手写 __ModuleLoader__ 包（无构建步骤），与官方客户端插件格式一致。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-cost",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");
    //#region session-cost.module.css
    const css = ".sc_line{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;white-space:nowrap;font-variant-numeric:tabular-nums}.sc_line[data-empty]{display:none}.sc_chip{flex:none;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-secondary);border-radius:8px;padding:0 6px;font-size:11px;line-height:16px}.sc_chip[data-mode=peak]{color:#d97706;border-color:rgba(217,119,6,.35)}.sc_chip[data-mode=offPeak]{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-secondary)}.sc_save{color:#16a34a}.sc_sep{flex:none;color:var(--dsw-alias-border-secondary)}";
    const tagId = "dsh-session-cost/session-cost.module.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-cost";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    //#endregion

    const ENDPOINT = "/session-cost/session/";
    /** 轮询间隔（ms）。 */
    const POLL_MS = 5000;

    /** 界面当前语言（'en' 等）；由 apply 内的 locale 订阅维护。 */
    let currentLocale = "zh";
    /** 配置中的展示币种：auto 跟随界面语言，CNY/USD 强制。 */
    let configuredCurrency = "auto";

    /** 根据「配置 + 界面语言」决定展示币种。 */
    function resolveCurrency() {
      if (configuredCurrency === "USD") return "USD";
      if (configuredCurrency === "CNY") return "CNY";
      return currentLocale === "en" ? "USD" : "CNY";
    }

    /** 紧凑金额：>=1 两位小数，否则四位小数，避免小额被省略。 */
    function formatCost(symbol, amount) {
      const v = Number.isFinite(amount) ? amount : 0;
      const text = v >= 1 ? v.toFixed(2) : v.toFixed(4);
      return symbol + text;
    }

    /** 计价模式角标文案。 */
    function modeLabel(mode) {
      if (mode === "peak") return "高峰";
      if (mode === "offPeak") return "空闲";
      return "";
    }

    /**
     * 会话消耗第二行。挂载于 conversation.composer.dock（会话可选作用域），
     * 框架注入 useSession / useProjection / t；这里只用 useSession 取 sessionId。
     */
    /** 空视图：保证信息栏恒为两行（即便本会话暂无消耗）。 */
    const ZERO_VIEW = {
      cost: 0, costUsd: 0, lastMode: "flat", calls: 0,
      savings: 0, savingsUsd: 0, displayCurrency: "auto",
      symbol: "¥", symbolUsd: "$"
    };

    function SessionCostLine(props) {
      const useSession = props.useSession;
      const sessionId = useSession((s) => s.sessionId);
      const [data, setData] = react.useState(ZERO_VIEW);

      react.useEffect(() => {
        // dock 是 session-maybe；切换会话时先清空旧数据，避免短暂显示上一会话金额。
        setData(ZERO_VIEW);
        if (sessionId === void 0 || sessionId === null || sessionId === "") return;
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch(ENDPOINT + encodeURIComponent(sessionId), {
              headers: { accept: "application/json" }
            });
            if (!response.ok) throw new Error("HTTP " + String(response.status));
            const value = await response.json();
            if (value?.ok !== true) throw new Error("unexpected payload");
            if (alive) {
              if (typeof value.displayCurrency === "string") configuredCurrency = value.displayCurrency;
              setData(value);
            }
          } catch {
            // 静默降级：保留上一次数据，不阻塞界面。
          }
        };
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      const currency = resolveCurrency();
      // 非官方三个模型的会话：不显示第二行。
      if (data.supported === false) return null;
      const useUsd = currency === "USD";
      // 展示符号来自 host 配置（symbol / symbolUsd），默认 ¥ / $。
      const symbol = useUsd ? (data.symbolUsd ?? "$") : (data.symbol ?? "¥");
      const amount = useUsd ? (data.costUsd ?? 0) : (data.cost ?? 0);
      const label = formatCost(symbol, amount);
      const mode = modeLabel(data.lastMode);
      const savings = useUsd ? (data.savingsUsd ?? 0) : (data.savings ?? 0);
      const showSave = Number.isFinite(savings) && savings > 0;

      return react_jsx_runtime.jsx("div", {
        className: "sc_line",
        children: [
          react_jsx_runtime.jsx("span", { children: label }, "amount"),
          mode !== ""
            ? react_jsx_runtime.jsx("span", { className: "sc_chip", "data-mode": data.lastMode, children: mode }, "mode")
            : null,
          showSave
            ? react_jsx_runtime.jsx("span", { className: "sc_sep", children: "·" }, "sep")
            : null,
          showSave
            ? react_jsx_runtime.jsx("span", { className: "sc_save", children: "省" + formatCost(symbol, savings) }, "save")
            : null
        ]
      });
    }

    /**
     * 客户端插件主体。
     * @param ctx - client root context。
     */
    function apply(ctx) {
      // 跟踪界面语言，用于 auto 模式下的人民币 / 美元切换。
      const syncLocale = () => {
        const active = ctx.locale.getSnapshot().active;
        currentLocale = typeof active === "string" ? active : "zh";
      };
      syncLocale();
      ctx.effect(() => ctx.locale.subscribe(syncLocale), "dsh-session-cost: locale sync");

      ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () => {
        const dispose = ctx.slots.register({
          name: "conversation.composer.dock",
          id: "session-cost",
          order: 1
        }, SessionCostLine);
        return () => {
          dispose();
        };
      }), "dsh-session-cost: dock entry");
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
