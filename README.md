# dsh-session-cost

DeepSeek Harness Desktop / Web 插件：在聊天界面**底部默认信息栏（stats 行）的右端**追加一枚
可点击的「本会话消耗」角标，按 DeepSeek API 公开价格（含峰谷定价）估算费用，人民币 / 美元随界面
语言切换；**点开角标展开详细菜单**：当前计价时段与单价、下一次峰谷切换、按模型 / 按时段的
用量与费用。

> 计费引擎（纯函数）与价格数据分离：`lib/pricing.js` 只含取价逻辑，**价格数据全部在
> `lib/pricing-data.json`**（由插件作者随官方调价维护，不写在代码里）。展示形态独立实现，
> 只落在底部信息栏那一行里。支持官方在售及兼容期内的模型：`deepseek-flash`（V4.1 Flash）、
> `deepseek-v4-pro`，以及已下线但仍可调用的旧名 `deepseek-v4-flash` /
> `deepseek-v4-flash-vision-exp`（官方将旧名请求路由至 V4.1 Flash，按 Flash 单价计费）。

## 安装

### 官方 Desktop

在侧栏打开「插件（Plugins）」，选择「添加插件（Add plugin）」，输入：

```text
https://github.com/Nalleyer/dsh_session_cost
```

安装完成后启用 `dsh-session-cost`，完整退出 Desktop（包括托盘进程），再重新打开。
Desktop 使用 `desktop` profile；装进 `web` profile 的插件不会自动在 Desktop 中启用。

升级时按当前插件页提供的操作卸载后重装，确认详情页显示所需版本。GitHub 安装读取远端仓库；
本地尚未推送的改动不会被安装。本插件不依赖 npm 发布。

### Web / CLI

```bash
dsh plugin --profile web add https://github.com/Nalleyer/dsh_session_cost
```

安装后重启运行该 profile 的 DSH host。CLI 和 Desktop 可能来自不同版本的安装，
维护 Desktop 时优先使用其内置 CLI，或直接使用上述 Desktop 插件页。

### 本地开发

先在仓库运行 `npm ci`，再通过官方 CLI 链接本地包。Windows 助手会调用
`dsh plugin --profile <name> add link:<checkout>`，由 DSH 管理 profile 和组合包，
无需手工修改 profile 清单或创建 junction。

```powershell
# Web：使用 PATH 中的 dsh
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile web

# 官方 Desktop（默认 Windows 安装目录；自定义安装时换成实际路径）
$desktopCli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile desktop -DshCommand $desktopCli
```

自定义用户数据目录可加 `-DshHome <path>`。该参数只在安装命令执行期间设置
`DSH_HOME`，随后恢复原值。源码修改后重启对应 host；Desktop 完整退出后重开，Web 还需刷新页面。

## 兼容性与安装后测试

2026-10-09 已核对官方 Desktop `0.2.0-rc.2` 的内置模块，并在隔离环境验证：

- host：真实 Cordis / WebServer 的插件初始化、`session/event` 记账、HTTP 明细端点和卸载。
- client：真实 ClientModuleSystem / SlotRegistry / LocaleRuntime 的注册和卸载；
  用 jsdom 与 React 18.3.1 验证角标挂入 stats 行、展开明细和 Esc 关闭，定位使用插件自带实现。
- 官方客户端源码仍提供 `conversation.composer.dock`、`[data-composer-stats]`、
  `react-dom` 和所需 locale 接口。

这些检查通过后，无需修改插件的 host/client 接口。`dsh.client.platform` 仍为 `web`：
它描述客户端模块平台，Desktop 的 profile 名称是 `desktop`，两者不应混用。
Headless 没有聊天界面，不能显示角标。

本轮尚未通过 Desktop 的 GitHub 安装入口进行实际验收，也未验证原生窗口的布局和官方定位 hook。
远端更新后，用上述官方方式安装 `1.2.1`，检查：

1. 新建会话，用 `deepseek-flash` 完成一次回复；5 秒内出现费用角标，点击可展开明细，
   外部点击或 Esc 可关闭。
2. 若使用 `deepseek-v4-pro`，明细应保持 Pro 计费名与 Pro 单价。
3. 切换中英文界面，自动币种随之切换；切换会话不应短暂显示上一会话的金额。
4. 完整退出后重开，已记录金额保留；继续聊天时请求数增加，旧记录不重复累计。

安装前的聊天记录不会自动补算。插件订阅运行期间的会话事件；
旧会话尚无插件账本记录时不显示角标，继续对话产生用量后才出现。
账本默认保存在同一 `DSH_HOME` 的 `storages/session-cost.json`；
从 Web 切到 Desktop 只有使用同一数据目录才会读取同一份账本。

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
  - 2026-09-10 12:00 起：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` → `deepseek-flash`
  - `deepseek-v4-pro` 继续按 Pro 单价计费，未路由到 Flash；以[当前官方价格说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)为准。
  被路由的名字**不重复写价**，单价由目标模型在政策链上的价格行决定，避免同一组数字多处维护。
- 政策链继承：重启后，保留的消息明细按各自时刻重新计价（重启自愈）。超过
  `maxMessagesPerSession` 的裁剪历史只保留当时的聚合金额，不再逐条重算。升级到 `1.2.1` 后，
  保留明细中曾按 Flash 错算的 Pro 消息会自动改按 Pro 定价；已裁剪的聚合无法恢复逐条用量。
- **价格数据在 `lib/pricing-data.json`**：官方调价时，插件作者直接更新该文件（无需改逻辑代码）。
  包含时间轴（`policies`，含可选 `routes`）、峰谷窗口（`peakWindows`）、高峰星期
  （`peakWeekdays`，周一 1 … 周日 7；缺省/空数组表示不限星期）、支持的模型（`models`），
  以及核对来源（`source`）。
- 普通用户**不可**覆盖价格：不提供 `prices` / `policyOverrides` 等覆盖入口。

费用来自事件中的 token 用量和价格表，表示 API 标价估算，不等同于供应商实际扣款。
订阅套餐、第三方渠道折扣和本地模型的实际费用不在此估算中；同名模型也按公开 API 标价展示。
当前峰谷规则只处理星期与每日时段，尚未单独处理中国法定节假日。
[英文官方价格页](https://api-docs.deepseek.com/quick_start/pricing/)将这些节假日列为空闲时段，
因此节假日落在工作日高峰窗口时，本插件的估算可能偏高。

## 人民币 / 美元

`displayCurrency: auto`（默认）跟随界面语言：英文界面显示 USD，其余显示 CNY；
配置为 `CNY` / `USD` 则强制指定。计费时双币种同时算，`/session-cost/session/<id>`
返回 `cost` 与 `costUsd`，由客户端按上述规则择一展示；展示符号取配置
`symbol` / `symbolUsd`（默认 `¥` / `$`）。界面文案随语言切换（zh / en 字典注册进官方
locale 服务）。

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
lib/pricing-data.json 价格数据（支持模型的政策时间表 + 峰谷窗口，作者维护）
lib/index.js          host 侧：记账 + /session-cost 端点（概览 / 明细）
lib/client.js         浏览器侧：信息栏角标（门户进官方 stats 行）+ 详细菜单
cordis.patch.yml      组合包配置层
test/                 峰谷计价、账本、端点与浏览器侧行为测试
tools/                本地开发探针（CDP，不随包发布）
```
