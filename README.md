# dsh-session-cost

DeepSeek Harness（`dsh web`）插件：在聊天界面**底部默认信息栏**之下，追加一行
「本会话消耗」，按 DeepSeek 官方政策（含峰谷定价）实时计费，人民币 / 美元随界面语言切换。

> 计费引擎（纯函数）与价格数据分离：`lib/pricing.js` 只含取价逻辑，**价格数据全部在
> `lib/pricing-data.json`**（由插件作者随官方调价维护，不写在代码里）。展示形态独立实现，
> 只落在底部信息栏的一行里。支持官方在售及兼容期内的模型：`deepseek-flash`（V4.1 Flash）、
> `deepseek-v4-pro`，以及已下线但仍可调用的旧名 `deepseek-v4-flash` /
> `deepseek-v4-flash-vision-exp`（官方将旧名请求路由至 V4.1 Flash，按 Flash 单价计费）。

## 效果

- 默认信息栏（stats 行）保持第一行不变；本插件注册为 `conversation.composer.dock`
  的 `order: 1` 条目，自然渲染为**第二行**。
- 第二行显示内容（紧凑一行）：

  ```
  ¥0.0123 · 高峰        （空闲时段则显示「空闲」）
  ```

  - 金额：双币种，按配置 / 界面语言决定展示人民币还是美元。
  - 角标 `高峰` / `空闲`：来自最近一条 assistant 消息的计价模式（2026-08-17 起的峰谷定价）。
  - **仅上列官方模型**（`deepseek-flash` / `deepseek-v4-pro` / `deepseek-v4-flash` /
    `deepseek-v4-flash-vision-exp`）显示；其它模型的会话不显示第二行。

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
`symbol` / `symbolUsd`（默认 `¥` / `$`）。

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
GET /session-cost/session/<id>   → { ok, sessionId, cost, costUsd, lastMode, supported, displayCurrency, symbol, symbolUsd }
```

- `supported: false` 表示该会话含**不被支持模型**的消息（具体模型名记在账本里），第二行不显示。
  官方改名 / 新增模型后（本插件的价格数据版本随之变化）会重新判定该标记：曾因旧模型名被
  标记的会话自动恢复显示；旧版账本没记模型名的标记，只在会话没有任何可用明细时清除，
  有明细的会话保守保留——避免显示出「只算了部分模型」的片面金额。

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
npm test        # node --test 验证峰谷计价
```

## 目录

```
lib/pricing.js        计费引擎（纯函数，无价格数据）
lib/pricing-data.json 价格数据（官方三模型的政策时间表 + 峰谷窗口，作者维护）
lib/index.js          host 侧：记账 + /session-cost 端点
lib/client.js         浏览器侧：composer.dock 第二行信息栏
cordis.patch.yml      组合包配置层
test/                峰谷计价与账本单测
```
