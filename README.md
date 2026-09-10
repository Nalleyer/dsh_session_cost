# dsh-session-cost

DeepSeek Harness（`dsh web`）插件：在聊天界面**底部默认信息栏（stats 行）的右端**追加一枚
可点击的「本会话消耗」角标，按 DeepSeek 官方政策（含峰谷定价）实时计费，人民币 / 美元随界面
语言切换；**点开角标展开详细菜单**：当前计价时段与单价、下一次峰谷切换、按模型 / 按时段的
用量与费用。

> 计费引擎（纯函数）与价格数据分离：`lib/pricing.js` 只含取价逻辑，**价格数据全部在
> `lib/pricing-data.json`**（由插件作者随官方调价维护，不写在代码里）。展示形态独立实现，
> 只落在底部信息栏那一行里。支持官方在售及兼容期内的模型：`deepseek-flash`（V4.1 Flash）、
> `deepseek-v4-pro`，以及已下线但仍可调用的旧名 `deepseek-v4-flash` /
> `deepseek-v4-flash-vision-exp`（官方将旧名请求路由至 V4.1 Flash，按 Flash 单价计费）。

## 效果

- 官方信息栏（`[data-composer-stats]` 那一行）保持原样，本插件的角标**追加在该行右端**，
  与官方 stat pill 同款：同尺寸、同留白、同 hover 反馈：

  ```
  ◔ 1 轮 14 步 · 256 tok/s      ▤ 409K tok · 缓存命中 95%      ▤ ¥0.1335 · 高峰
  ```

  - 金额：双币种，按配置 / 界面语言决定展示人民币还是美元（`¥0.1335` / `$0.0185`）。
  - 角标 `高峰` / `空闲`：来自最近一条 assistant 消息的计价模式（2026-08-17 起的峰谷定价）；
    平价时期（峰谷定价启用前）不显示角标。
  - **仅上列官方模型**（`deepseek-flash` / `deepseek-v4-pro` / `deepseek-v4-flash` /
    `deepseek-v4-flash-vision-exp`）显示；其它模型的会话不显示角标。
  - 本会话还没有任何已计费消息时不占位（官方信息栏本身也是「有用量才出现」）。

## 详细菜单（点开角标）

面板样式与官方 stat pill 的详情面板一致（门户到 body、视口内夹取定位、外部点击 / Esc 关闭）：

| 分组 | 内容 |
| --- | --- |
| 计价 | 当前计价时段（高峰 / 空闲 / 平价）、单价（输入 / 缓存读取 / 输出，每 1M tokens）、模型（发生官方兼容路由时写成 `请求名 → 实际计费名`）、下一处峰谷切换时刻 |
| 用量 | 输入 tokens、缓存读取、输出 tokens、缓存命中率、请求数 |
| 时间 | 首次 / 最近计费时刻 |
| 按模型 | 会话用过多个模型时，逐模型给出费用 |

- 标题左侧是「本会话消耗」，右侧是精确金额（最多六位小数）。
- 单价按**最近计费的模型在当前时刻**取——即「下一条消息会按什么价计费」；账本里记的是每条
  消息各自时刻的价，历史金额不随当前时段变化。
- 面板底部标注价格数据核对日期；明细超限被裁剪时也会注明。
- 菜单展开时才请求明细端点，展开期间跟随概览一起刷新（5s）。

## 计费方法（峰谷 + 模型路由）

- 订阅 `session/event`，对每条带 `usage` 的 `assistant/message` **按消息完成时刻取价**。
- 峰谷时段（北京时间，`Asia/Shanghai`，与官方一致）：
  - **高峰**：**周一至周五** `09:00–12:00`、`14:00–18:00`
  - **空闲**（其余时段，含**周末全天**）：单价为高峰的**一半**。
- **模型名路由**：官方下线模型后常保留旧模型名的兼容期，此时请求由新模型提供服务、并按
  新模型单价计费。路由写在数据文件的 `policies[].routes`（`{ 请求名: 实际计费名 }`）：
  - 2026-09-10 起：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` → `deepseek-flash`
  - 2026-09-14 12:00 起（至 V4.1 Pro 上线前）：`deepseek-v4-pro` → `deepseek-flash`
  被路由的名字**不重复写价**，单价由目标模型在政策链上的价格行决定，避免同一组数字多处维护。
- 政策链继承：重启后，保留的消息明细按各自时刻重新计价（重启自愈）。超过
  `maxMessagesPerSession` 的裁剪历史只保留当时的聚合金额，不再逐条重算。
- **价格数据在 `lib/pricing-data.json`**：官方调价时，插件作者直接更新该文件（无需改逻辑代码）。
  包含时间轴（`policies`，含可选 `routes`）、峰谷窗口（`peakWindows`）、高峰星期
  （`peakWeekdays`，周一 1 … 周日 7；缺省/空数组表示不限星期）、支持的模型（`models`），
  以及核对来源（`source`）。
- 普通用户**不可**覆盖价格：不提供 `prices` / `policyOverrides` 等覆盖入口。

## 人民币 / 美元

`displayCurrency: auto`（默认）跟随界面语言：英文界面显示 USD，其余显示 CNY；
配置为 `CNY` / `USD` 则强制指定。计费时双币种同时算，`/session-cost/session/<id>`
返回 `cost` 与 `costUsd`，由客户端按上述规则择一展示；展示符号取配置
`symbol` / `symbolUsd`（默认 `¥` / `$`）。界面文案随语言切换（zh / en 字典注册进官方
locale 服务）。

## 安装

插件是一个标准 **DSH 组合包（bundle）**（`dsh.bundle.patch` 指向包内 `cordis.patch.yml`）。

```bash
# 从 GitHub 安装（上传后）
dsh plugin --profile web add https://github.com/Nalleyer/dsh_session_cost

# 或从 npm 安装（发布后）
dsh plugin --profile web add dsh-session-cost

# 本地开发：把 checkout 以 junction 链接进已初始化的 profile（无需先上 GitHub）
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile web
```

- 本地安装助手要求目标 profile 已由 DSH 初始化；全新环境先运行一次 `dsh web`，再执行脚本。
- 本地安装脚本会创建 `$DSH_HOME/profiles/web/node_modules/dsh-session-cost` 指向本仓库，
  并把 `dsh-session-cost` 加入 profile 的 `dsh.profile.bundles`。
- 安装后**重启 `dsh web`** 生效。
- 浏览器端 bundle 为手写模块（与 DSH 官方 client 插件同格式），修改后**刷新页面 + 重启 `dsh web`** 生效；host 端修改需重启。

## 端点（默认仅回环，host 侧）

```
GET /session-cost/session/<id>         → { ok, sessionId, cost, costUsd, calls, lastMode, supported, displayCurrency, symbol, symbolUsd }
GET /session-cost/session/<id>/detail  → 上列总量 + cacheHitPercent、firstTime/lastTime、models[]、modes{peak,offPeak,flat}、
                                          pricing{model,billedAs,mode,cny,usd,checkedAt,…}、nextSwitch{at,mode}、trimmed
```

- `supported: false` 表示该会话含**不被支持模型**的消息（具体模型名记在账本里），角标不显示。
  官方改名 / 新增模型后（本插件的价格数据版本随之变化）会重新判定该标记：曾因旧模型名被
  标记的会话自动恢复显示；旧版账本没记模型名的标记，只在会话没有任何可用明细时清除，
  有明细的会话保守保留——避免显示出「只算了部分模型」的片面金额。
- 明细端点只在菜单展开时请求；未知会话返回零聚合（`pricing: null`）。

## 配置（cordis.patch.yml）

仅展示相关，不含价格覆盖：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `displayCurrency` | `auto` | `auto`=跟随界面语言（英文显示 USD）；`CNY`/`USD`=强制 |
| `symbol` / `symbolUsd` | `¥` / `$` | 人民币 / 美元展示符号 |
| `persistPath` | `$DSH_HOME/storages/session-cost.json` | 账本路径 |
| `maxMessagesPerSession` | `2000` | 每个会话保留的逐条明细数；越大越利于未来调价重算 |
| `loopbackOnly` | `true` | 端点仅回环可访问 |

价格数据不在用户配置里——改价请编辑 `lib/pricing-data.json`（插件作者职责）。

## 开发

```bash
npm run check   # node --check 各 lib 文件
npm test        # node --test：峰谷计价 / 账本 / 端点 / 浏览器侧行为
```

浏览器侧（`lib/client.js`）是手写 bundle、没有构建步骤，因此测试直接把它当它本来的样子执行：
造一个 `window.__ModuleLoader__` 门面接住工厂，用 jsdom 提供 DOM，再用真实 react / react-dom
渲染组件（`test/client.test.mjs`，缺 jsdom / react 时自动跳过）。测试覆盖「角标挂进官方信息栏
那一行」「点开 / 关闭菜单」「官方行缺席时退回自己一行」等关键行为。

`tools/cdp-probe.mjs` 是本地开发用的 CDP 探针（驱动无头 Chrome 打开正在运行的 `dsh web`，
可截图 / 执行选择器表达式 / 收集控制台错误），配合 `tools/footer-probe.js` 可核对信息栏的真实
DOM 结构与样式；放在 `tools/` 而不是 `test/`，因为 `node --test` 会把 `test/` 下的一切都当作用例。

## 目录

```
lib/pricing.js        计费引擎（纯函数，无价格数据）
lib/pricing-data.json 价格数据（官方三模型的政策时间表 + 峰谷窗口，作者维护）
lib/index.js          host 侧：记账 + /session-cost 端点（概览 / 明细）
lib/client.js         浏览器侧：信息栏角标（门户进官方 stats 行）+ 详细菜单
cordis.patch.yml      组合包配置层
test/                 峰谷计价、账本、端点与浏览器侧行为测试
tools/                本地开发探针（CDP，不随包发布）
```
