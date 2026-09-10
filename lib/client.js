/**
 * dsh-session-cost — client face.
 *
 * 把「本会话消耗」作为一枚**可点击的角标**，追加到官方底部信息栏（stats 行）的右端，
 * 点开是一个详细菜单：当前计价时段与单价、下一次峰谷切换、按模型 / 按时段的用量与费用。
 *
 * 为什么是门户（portal）而不是插槽：官方 `conversation.composer.dock` 是**列式**列表，
 * 每个条目各占一行——官方自己的 stats 行（`[data-composer-stats]`）就是其中 order=0 的
 * 那一条。要在同一行的右侧追加，只能把角标挂进官方那一行；官方行不存在（例如本会话还
 * 没有任何计费用量）时退回自己的 dock 行渲染。
 *
 * 纯手写 __ModuleLoader__ 包（无构建步骤），与官方客户端插件格式一致；
 * react / react-dom / 官方 UI primitives 都在壳的静态模块表内，缺失时逐项降级。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-cost",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let jsx_runtime = require("react/jsx-runtime");
    let jsx = jsx_runtime.jsx;
    let jsxs = jsx_runtime.jsxs;
    let Fragment = jsx_runtime.Fragment;
    // react-dom（门户）与官方 primitives（定位 / 外部点击关闭 / 图标）都是静态模块表内的
    // 基线模块；这里逐项兜底，任一缺失都只降级、不影响插件加载。
    let react_dom = null;
    try {
      react_dom = require("react-dom");
    } catch {
      react_dom = null;
    }
    let primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch {
      primitives = null;
    }
    const can_portal = typeof react_dom?.createPortal === "function";
    const create_portal = can_portal ? react_dom.createPortal : (node) => node;
    //#region session-cost.module.css
    const css = [
      // 常驻锚点：定位官方信息栏用，display:contents 让它不占位、不动布局。
      ".sc_anchor{display:contents}",
      // 找不到官方信息栏时的退路：自己占一行，居中（与官方信息栏同一视觉节奏）。
      ".sc_row{display:flex;align-items:center;justify-content:center;gap:6px;min-height:20px}",
      // 角标：与官方 stat pill 同款（同尺寸 / 同留白 / 同 hover），order 让它排在官方行最右。
      ".sc_pill{box-sizing:border-box;order:1;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}",
      ".sc_pill svg{flex:none;width:14px;height:14px}",
      "button.sc_pill{cursor:pointer}",
      "button.sc_pill:hover,button.sc_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
      ".sc_label{text-overflow:ellipsis;min-width:0;overflow:hidden}",
      ".sc_sep{color:var(--dsw-alias-label-caption)}",
      ".sc_mode{flex:none}",
      ".sc_mode[data-mode=peak]{color:var(--dsw-alias-state-warn-primary)}",
      ".sc_mode[data-mode=offPeak],.sc_mode[data-mode=flat]{color:var(--dsw-alias-label-tertiary)}",
      // 详细菜单：官方 stat dialog 同款面板（门户到 body，固定定位、视口内夹取）。
      ".sc_panel{z-index:1100;box-sizing:border-box;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(420px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;position:fixed}",
      ".sc_title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}",
      ".sc_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}",
      ".sc_titleLabel svg{flex:none;width:14px;height:14px}",
      ".sc_titleValue{font-variant-numeric:tabular-nums}",
      ".sc_rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}",
      ".sc_section{color:var(--dsw-alias-label-caption);margin:10px 0 4px}",
      ".sc_details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}",
      ".sc_details dt,.sc_details dd{min-width:0;margin:0}",
      ".sc_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}",
      ".sc_route{overflow-wrap:anywhere}",
      ".sc_muted{color:var(--dsw-alias-label-caption)}",
      ".sc_foot{color:var(--dsw-alias-label-caption);margin-top:10px}"
    ].join("");
    const tagId = "dsh-session-cost/session-cost.module.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-cost";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    //#endregion

    /** host 端点前缀；明细菜单在点开时才请求 `<前缀><id>/detail`。 */
    const ENDPOINT = "/session-cost/session/";
    /** 轮询间隔（ms）。 */
    const POLL_MS = 5000;
    /** 面板与触发角标之间的间距、以及距视口边缘的安全边距（官方 stat dialog 取值同）。 */
    const PANEL_GAP = 8;
    const PANEL_MARGIN = 12;
    /** 尚未定位的面板：隐藏但仍参与排版，供定位 hook 量取真实尺寸。 */
    const MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };
    /** 本插件的 locale 命名空间（字典注册进官方 locale 服务，界面文案随语言切换）。 */
    const NS = "session-cost";

    /** 界面当前语言（'en' 等）；由 apply 内的 locale 订阅维护。 */
    let currentLocale = "zh";
    /** 配置中的展示币种：auto 跟随界面语言，CNY/USD 强制。 */
    let configuredCurrency = "auto";

    /** 内置字典：官方 locale 服务注册失败时（或 `t` 座位缺失时）的兜底。 */
    const STRINGS = {
      zh: {
        title: "本会话消耗",
        pricing: "计价",
        usage: "用量",
        timeline: "时间",
        byModel: "按模型",
        peak: "高峰",
        offPeak: "空闲",
        flat: "平价",
        mode: "计价时段",
        unit: "单价 / 1M tokens",
        model: "模型",
        route: "{model} → {billedAs}",
        nextSwitch: "下次切换",
        switchAt: "{time} 转{mode}",
        noSwitch: "近 7 天无切换",
        input: "输入 tokens",
        cacheRead: "缓存读取",
        output: "输出 tokens",
        cacheHit: "缓存命中",
        calls: "请求数",
        firstBilled: "首次计费",
        lastBilled: "最近计费",
        peakCost: "高峰时段",
        offPeakCost: "空闲时段",
        flatCost: "平价时段",
        priceChecked: "价格核对 {date}",
        trimmed: "含已归档早期记录 {calls} 条",
        loadFailed: "明细加载失败"
      },
      en: {
        title: "Session cost",
        pricing: "Pricing",
        usage: "Usage",
        timeline: "Timeline",
        byModel: "By model",
        peak: "Peak",
        offPeak: "Off-peak",
        flat: "Flat",
        mode: "Billing window",
        unit: "Price / 1M tokens",
        model: "Model",
        route: "{model} → {billedAs}",
        nextSwitch: "Next change",
        switchAt: "{mode} at {time}",
        noSwitch: "No change within 7 days",
        input: "Input tokens",
        cacheRead: "Cache read",
        output: "Output tokens",
        cacheHit: "Cache hit",
        calls: "Requests",
        firstBilled: "First billed",
        lastBilled: "Last billed",
        peakCost: "Peak window",
        offPeakCost: "Off-peak window",
        flatCost: "Flat rate",
        priceChecked: "Prices checked {date}",
        trimmed: "Includes {calls} archived records",
        loadFailed: "Details unavailable"
      }
    };

    /** 语言标签（数字 / 时间格式化用）。 */
    function localeTag() {
      return currentLocale === "en" ? "en-US" : "zh-CN";
    }

    /** 根据「配置 + 界面语言」决定展示币种。 */
    function resolveCurrency() {
      if (configuredCurrency === "USD") return "USD";
      if (configuredCurrency === "CNY") return "CNY";
      return currentLocale === "en" ? "USD" : "CNY";
    }

    /** `{name}` 占位替换（官方 `t` 已替换过时这里不再有占位符，重复替换无副作用）。 */
    function interpolate(template, params) {
      if (params === void 0 || template.indexOf("{") === -1) return template;
      return template.replace(/\{(\w+)\}/g, (match, key) => (
        params[key] === void 0 ? match : String(params[key])
      ));
    }

    /**
     * 文案：优先用框架注入的 `t`（绑定本插件命名空间），拿不到译文（或未注册成功）时
     * 回落到内置字典——两者都缺时显示键名，便于发现漏翻。
     */
    function makeTranslate(injected) {
      return (key, params) => {
        let text;
        if (typeof injected === "function") {
          try {
            text = injected(key, params);
          } catch {
            text = void 0;
          }
        }
        if (typeof text !== "string" || text === "" || text === key) {
          const table = STRINGS[currentLocale] ?? STRINGS.zh;
          text = table[key] ?? STRINGS.zh[key] ?? key;
        }
        return interpolate(text, params);
      };
    }

    let numberFormatter = null;
    let numberFormatterTag = "";
    /** 千分位整数（token 计数等）。 */
    function numberText(value) {
      const tag = localeTag();
      if (numberFormatter === null || numberFormatterTag !== tag) {
        try {
          numberFormatter = new Intl.NumberFormat(tag);
          numberFormatterTag = tag;
        } catch {
          numberFormatter = null;
          numberFormatterTag = tag;
        }
      }
      const number = Number.isFinite(value) ? value : 0;
      return numberFormatter === null ? String(number) : numberFormatter.format(number);
    }

    /**
     * 金额：角标用紧凑写法（≥1 两位小数，否则四位，避免小额被省略），
     * 菜单用精确写法（六位小数、去掉多余尾零，至少保留两位）。
     */
    function formatMoney(symbol, amount, exact) {
      const value = Number.isFinite(amount) ? amount : 0;
      if (exact !== true) return symbol + (value >= 1 ? value.toFixed(2) : value.toFixed(4));
      return symbol + value.toFixed(6).replace(/(\.\d\d)0+$/, "$1");
    }

    /** 单价（每 1M tokens）的紧凑写法。 */
    function unitText(value) {
      return String(Number.isFinite(value) ? value : 0);
    }

    /** 时刻：当天只显示时分，跨天补月-日。 */
    function clockText(timeMs) {
      const date = new Date(timeMs);
      const time = date.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" });
      if (date.toDateString() === new Date().toDateString()) return time;
      return `${date.toLocaleDateString(localeTag(), { month: "2-digit", day: "2-digit" })} ${time}`;
    }

    /** 计价模式显示名（平价是峰谷定价启用前的历史时段，菜单内如实标注）。 */
    function modeText(t, mode) {
      if (mode === "peak") return t("peak");
      if (mode === "offPeak") return t("offPeak");
      return t("flat");
    }

    /** 模型显示名：发生官方兼容路由时写成「请求名 → 实际计费名」。 */
    function modelText(t, model, billedAs) {
      if (typeof billedAs !== "string" || billedAs === "") return typeof model === "string" ? model : "—";
      if (typeof model !== "string" || model === "" || model === billedAs) return billedAs;
      return t("route", { model, billedAs });
    }

    /** 会话 id 是否可用（dock 是 session-maybe，可能没有会话）。 */
    function isSessionId(value) {
      return typeof value === "string" && value !== "";
    }

    /** 取一份 JSON；任何失败（网络 / 非 2xx / 载荷不符）都返回 null，由调用方决定降级。 */
    async function requestJson(url) {
      try {
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) return null;
        const value = await response.json();
        return value?.ok === true ? value : null;
      } catch {
        return null;
      }
    }

    const raf = typeof requestAnimationFrame === "function"
      ? (callback) => requestAnimationFrame(callback)
      : (callback) => setTimeout(callback, 16);
    const cancelRaf = typeof cancelAnimationFrame === "function"
      ? (handle) => cancelAnimationFrame(handle)
      : (handle) => clearTimeout(handle);

    /** primitives 缺失时的图标兜底（柱状图，16×16）。 */
    function FallbackCostIcon() {
      return jsxs("svg", {
        viewBox: "0 0 16 16",
        width: 16,
        height: 16,
        fill: "none",
        "aria-hidden": true,
        children: [
          jsx("path", {
            d: "M2.6 12.4V8.6M6.2 12.4V3.6M9.8 12.4V6.8M13.4 12.4V10",
            stroke: "currentColor",
            strokeWidth: "1.3",
            strokeLinecap: "round"
          }, "bars"),
          jsx("path", {
            d: "M1.6 14.2H14.4",
            stroke: "currentColor",
            strokeWidth: "1.1",
            strokeLinecap: "round",
            opacity: "0.5"
          }, "base")
        ]
      });
    }

    /** 费用图标：优先用官方 primitives 的同一枚（与官方 pill 视觉一致）。 */
    const CostIcon = typeof primitives?.IconDataOutline16 === "function"
      ? primitives.IconDataOutline16
      : FallbackCostIcon;

    /**
     * 官方 stat dialog 的等价实现（primitives 缺失时使用）：把面板夹在视口内，
     * 面板尺寸变化时重新定位。
     */
    function useLocalAnchoredPosition(options) {
      const { open, anchorRef, panelRef, side, gap, margin } = options;
      const [pos, setPos] = react.useState(null);
      react.useLayoutEffect(() => {
        if (!open) {
          setPos(null);
          return;
        }
        const measure = () => {
          const anchor = anchorRef.current;
          if (anchor === null) return;
          const rect = anchor.getBoundingClientRect();
          const panel = panelRef.current;
          const width = panel?.offsetWidth ?? 0;
          const height = panel?.offsetHeight ?? 0;
          let left = rect.left;
          let top = side === "top" ? rect.top - gap - height : rect.bottom + gap;
          if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
          if (height > 0) top = Math.min(Math.max(top, margin), window.innerHeight - height - margin);
          setPos({ left, top });
        };
        measure();
        window.addEventListener("scroll", measure, true);
        window.addEventListener("resize", measure);
        const panel = panelRef.current;
        let observer = null;
        if (typeof ResizeObserver !== "undefined" && panel !== null) {
          observer = new ResizeObserver(measure);
          observer.observe(panel);
        }
        return () => {
          observer?.disconnect();
          window.removeEventListener("scroll", measure, true);
          window.removeEventListener("resize", measure);
        };
      }, [open, anchorRef, panelRef, side, gap, margin]);
      return pos;
    }

    /** 指针落在触发角标与面板之外即关闭（primitives 缺失时的等价实现）。 */
    function useLocalDismissOnOutsidePointer(rootRef, open, setOpen, panelRef) {
      react.useEffect(() => {
        if (!open) return;
        const onPointerDown = (event) => {
          if (!(event.target instanceof Node)) return;
          if (rootRef.current?.contains(event.target) === true) return;
          if (panelRef.current?.contains(event.target) === true) return;
          setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
      }, [rootRef, open, setOpen, panelRef]);
    }

    const useAnchoredPosition = typeof primitives?.useAnchoredPosition === "function"
      ? primitives.useAnchoredPosition
      : useLocalAnchoredPosition;
    const useDismissOnOutsidePointer = typeof primitives?.useDismissOnOutsidePointer === "function"
      ? primitives.useDismissOnOutsidePointer
      : useLocalDismissOnOutsidePointer;

    /**
     * 一个「触发角标 + 门户面板」座位：开合状态、视口内定位、外部点击与 Esc 关闭。
     * 与官方 stat pill 的对话框行为一致。
     */
    function useStatDialog() {
      const [open, setOpen] = react.useState(false);
      const rootRef = react.useRef(null);
      const panelRef = react.useRef(null);
      const pos = useAnchoredPosition({
        open,
        anchorRef: rootRef,
        panelRef,
        side: "top",
        gap: PANEL_GAP,
        margin: PANEL_MARGIN
      });
      useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
      react.useEffect(() => {
        if (!open) return;
        const onKeyDown = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
      }, [open]);
      return { open, setOpen, rootRef, panelRef, pos };
    }

    /**
     * 定位官方底部信息栏那一行（`[data-composer-stats]`）：从本条目自己的锚点向上找最近的
     * 「含有该行」的祖先，并监听沿途祖先与目标行的子节点变化——官方行在会话没有用量时
     * 整体消失（如新建会话），出现与消失都要重新定位；锚点常驻，因此也能等到它出现。
     */
    function useStatsRow(anchorRef) {
      const [row, setRow] = react.useState(null);
      react.useEffect(() => {
        const anchor = anchorRef.current;
        if (anchor === null || typeof MutationObserver === "undefined") return;
        let observed = [];
        let frame = 0;
        let observer = null;
        const locate = () => {
          const current = anchorRef.current;
          if (current === null) return;
          let node = current.parentElement;
          let found = null;
          // 只向上找几层：官方行与本条目同属一个 composer stack（条目 → 可能的包装 → stack），
          // 层数限制可避免在「本会话没有官方行」时误挂到别处（例如另一个会话）的官方行上。
          for (let depth = 0; node !== null && depth < 4; depth++, node = node.parentElement) {
            const candidate = node.querySelector("[data-composer-stats]");
            if (candidate !== null && candidate.isConnected) {
              found = candidate;
              break;
            }
          }
          setRow(found);
          const parent = current.parentElement;
          const scope = [parent, parent?.parentElement, parent?.parentElement?.parentElement, found]
            .filter((element) => element !== null && element !== void 0);
          const changed = scope.length !== observed.length
            || scope.some((element, index) => element !== observed[index]);
          if (changed) {
            // MutationObserver 没有 unobserve（该 API 已从规范移除）：整体重挂一次。
            observer.disconnect();
            observed = scope;
            for (const element of observed) observer.observe(element, { childList: true });
          }
        };
        const schedule = () => {
          if (frame !== 0) return;
          frame = raf(() => {
            frame = 0;
            locate();
          });
        };
        observer = new MutationObserver(schedule);
        locate();
        return () => {
          if (frame !== 0) cancelRaf(frame);
          observer.disconnect();
        };
      }, [anchorRef]);
      return row;
    }

    /** 详细菜单内容：当前单价与下一处切换、用量、时间跨度、多模型拆分。 */
    function DetailPanel(props) {
      const { detail, failed, symbol, useUsd, t, panelRef, pos } = props;
      const sections = [];
      if (detail !== null) {
        const pricingRows = [];
        const pricing = detail.pricing;
        if (pricing !== null && pricing !== void 0) {
          const unit = useUsd ? pricing.usd : pricing.cny;
          pricingRows.push([t("mode"), modeText(t, pricing.mode)]);
          pricingRows.push([
            t("unit"),
            `${symbol}${unitText(unit.input)} / ${symbol}${unitText(unit.cacheRead)} / ${symbol}${unitText(unit.output)}`
          ]);
          pricingRows.push([t("model"), modelText(t, pricing.model, pricing.billedAs)]);
        }
        const next = detail.nextSwitch;
        pricingRows.push([
          t("nextSwitch"),
          next === null || next === void 0
            ? t("noSwitch")
            : t("switchAt", { time: clockText(next.at), mode: modeText(t, next.mode) })
        ]);
        const modes = detail.modes ?? {};
        for (const [key, label] of [["peak", "peakCost"], ["offPeak", "offPeakCost"], ["flat", "flatCost"]]) {
          const bucket = modes[key];
          if ((bucket?.calls ?? 0) > 0) {
            pricingRows.push([t(label), formatMoney(symbol, useUsd ? bucket.costUsd : bucket.cost, false)]);
          }
        }
        sections.push([t("pricing"), pricingRows]);
        sections.push([t("usage"), [
          [t("input"), numberText(detail.inputTokens)],
          [t("cacheRead"), numberText(detail.cacheReadTokens)],
          [t("output"), numberText(detail.outputTokens)],
          [t("cacheHit"), detail.cacheHitPercent === null || detail.cacheHitPercent === void 0
            ? "—"
            : `${detail.cacheHitPercent}%`],
          [t("calls"), numberText(detail.calls)]
        ]]);
        if (Number.isFinite(detail.firstTime) && Number.isFinite(detail.lastTime)) {
          sections.push([t("timeline"), [
            [t("firstBilled"), clockText(detail.firstTime)],
            [t("lastBilled"), clockText(detail.lastTime)]
          ]]);
        }
        if (Array.isArray(detail.models) && detail.models.length > 1) {
          sections.push([t("byModel"), detail.models.map((entry) => [
            modelText(t, entry.model, entry.billedAs),
            formatMoney(symbol, useUsd ? entry.costUsd : entry.cost, false)
          ])]);
        }
      }
      const children = [
        jsx("div", {
          className: "sc_title",
          children: [
            jsxs("span", {
              className: "sc_titleLabel",
              children: [jsx(CostIcon, {}, "icon"), t("title")]
            }, "label"),
            jsx("span", {
              className: "sc_titleValue",
              children: detail === null ? "…" : formatMoney(symbol, useUsd ? detail.costUsd : detail.cost, true)
            }, "value")
          ]
        }, "title"),
        jsx("div", { className: "sc_rule", "aria-hidden": true }, "rule")
      ];
      if (failed && detail === null) {
        children.push(jsx("div", { className: "sc_muted", children: t("loadFailed") }, "failed"));
      }
      sections.forEach(([heading, rows], index) => {
        children.push(jsx("div", { className: "sc_section", children: heading }, `h${index}`));
        children.push(jsx("dl", {
          className: "sc_details",
          children: rows.flatMap(([key, value], rowIndex) => [
            jsx("dt", { children: key }, `k${rowIndex}`),
            jsx("dd", { children: value }, `v${rowIndex}`)
          ])
        }, `d${index}`));
      });
      const foot = [];
      if (typeof detail?.pricing?.checkedAt === "string") {
        foot.push(t("priceChecked", { date: detail.pricing.checkedAt }));
      }
      if ((detail?.trimmed?.calls ?? 0) > 0) {
        foot.push(t("trimmed", { calls: numberText(detail.trimmed.calls) }));
      }
      if (foot.length > 0) {
        children.push(jsx("div", { className: "sc_foot", children: foot.join(" · ") }, "foot"));
      }
      return jsx("div", {
        ref: panelRef,
        className: "sc_panel",
        role: "dialog",
        "aria-label": t("title"),
        "data-session-cost-panel": true,
        style: pos ?? MEASURE_STYLE,
        children
      });
    }

    /**
     * 本会话消耗角标。挂在 conversation.composer.dock（会话作用域，order=1），
     * 但真正渲染的位置是官方信息栏那一行的右端（见 useStatsRow）。
     */
    function SessionCost(props) {
      const useSession = props.useSession;
      const t = react.useMemo(() => makeTranslate(props.t), [props.t]);
      const sessionId = useSession((state) => state.sessionId);
      const [data, setData] = react.useState(null);
      const [detail, setDetail] = react.useState(null);
      const [detailFailed, setDetailFailed] = react.useState(false);
      const anchorRef = react.useRef(null);
      const row = useStatsRow(anchorRef);
      const { open, setOpen, rootRef, panelRef, pos } = useStatDialog();

      react.useEffect(() => {
        // 切换会话时先清空旧数据，避免短暂显示上一会话的金额。
        setData(null);
        setDetail(null);
        setDetailFailed(false);
        if (!isSessionId(sessionId)) return;
        let alive = true;
        const load = async () => {
          const value = await requestJson(ENDPOINT + encodeURIComponent(sessionId));
          if (!alive || value === null) return;
          if (typeof value.displayCurrency === "string") configuredCurrency = value.displayCurrency;
          setData(value);
        };
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      react.useEffect(() => {
        // 菜单只在展开时取明细（账本聚合 + 当前单价），展开期间跟随概览一起刷新。
        if (!open || !isSessionId(sessionId)) return;
        let alive = true;
        const load = async () => {
          const value = await requestJson(`${ENDPOINT}${encodeURIComponent(sessionId)}/detail`);
          if (!alive) return;
          if (value === null) setDetailFailed(true);
          else {
            setDetail(value);
            setDetailFailed(false);
          }
        };
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [open, sessionId]);

      const currency = resolveCurrency();
      const useUsd = currency === "USD";
      const symbol = useUsd ? (data?.symbolUsd ?? "$") : (data?.symbol ?? "¥");
      const amount = useUsd ? (data?.costUsd ?? 0) : (data?.cost ?? 0);
      // 没有任何已计费消息（或会话含未支持的模型）时不占位：官方信息栏本身也是
      // 「有用量才出现」。锚点常驻，官方行稍后出现即可挂上去。
      if (data === null || data.supported === false || (data.calls ?? 0) <= 0) {
        return jsx("span", { ref: anchorRef, className: "sc_anchor", "aria-hidden": true }, "anchor");
      }

      const mode = data.lastMode;
      const badge = mode === "peak" || mode === "offPeak" ? modeText(t, mode) : "";
      const amountText = formatMoney(symbol, amount, false);
      const chip = jsxs("button", {
        ref: rootRef,
        type: "button",
        className: "sc_pill",
        "data-session-cost": true,
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-label": `${t("title")} ${amountText}`,
        onClick: () => setOpen(!open),
        children: [
          jsx(CostIcon, {}, "icon"),
          jsx("span", { className: "sc_label", children: amountText }, "amount"),
          badge === "" ? null : jsx("span", { className: "sc_sep", "aria-hidden": true, children: "·" }, "sep"),
          badge === "" ? null : jsx("span", { className: "sc_mode", "data-mode": mode, children: badge }, "mode")
        ]
      }, "chip");

      const children = [
        jsx("span", { ref: anchorRef, className: "sc_anchor", "aria-hidden": true }, "anchor"),
        // 门户不可用（壳没给出 react-dom）时退回自己那一行：功能不减，只是与官方行同行而已。
        row !== null && can_portal
          ? create_portal(chip, row, "chip")
          : jsx("div", { className: "sc_row", children: chip }, "row")
      ];
      if (open) {
        children.push(can_portal
          ? create_portal(
              jsx(DetailPanel, { detail, failed: detailFailed, symbol, useUsd, t, panelRef, pos }, "panel"),
              document.body,
              "panel"
            )
          : jsx(DetailPanel, { detail, failed: detailFailed, symbol, useUsd, t, panelRef, pos }, "panel"));
      }
      return jsxs(Fragment, { children });
    }

    /**
     * 渲染兜底：本插件出任何渲染期错误时只让自己的角标消失，不牵连官方聊天界面。
     * （插件的角标是无障碍的增量信息，而 composer 是主交互面。）
     */
    class RenderGuard extends react.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        if (typeof console !== "undefined") console.warn("[dsh-session-cost] render failed:", error);
      }

      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    /**
     * 客户端插件主体。
     * @param ctx - client root context。
     */
    function apply(ctx) {
      // 跟踪界面语言，用于 auto 模式下的人民币 / 美元切换与本地文案。
      const syncLocale = () => {
        const active = ctx.locale.getSnapshot().active;
        currentLocale = typeof active === "string" ? active : "zh";
      };
      syncLocale();
      ctx.effect(() => ctx.locale.subscribe(syncLocale), "dsh-session-cost: locale sync");
      // 文案走官方 locale 服务（zh/en 字典）；注册失败时组件回落到内置字典。
      ctx.effect(() => {
        try {
          const dispose = ctx.locale.register(NS, { zh: STRINGS.zh, en: STRINGS.en });
          return typeof dispose === "function" ? dispose : () => {};
        } catch {
          return () => {};
        }
      }, "dsh-session-cost: locale dictionary");

      ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () => {
        const dispose = ctx.slots.register({
          name: "conversation.composer.dock",
          id: "session-cost",
          order: 1,
          locale: NS
        }, (props) => jsx(RenderGuard, { children: jsx(SessionCost, props) }));
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
