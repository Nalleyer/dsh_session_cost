# dsh-session-cost

在 DeepSeek Harness Desktop 和 Web 的聊天信息栏右侧显示本会话的估算费用。点击金额，可以查看 token 用量、缓存命中率、当前单价和各模型的费用。

```text
◔ 1 轮 14 步 · 256 tok/s      ▤ 409K tok · 缓存命中 95%      ▤ ¥0.1335 · 高峰
```

费用按 DeepSeek API 公开标价估算，实际扣款以服务商账单为准。插件只记录启用后收到的用量，安装前的聊天记录不会自动补算。

## 支持的模型

| 请求模型名 | 计费方式 |
| --- | --- |
| `deepseek-flash` | 按 V4.1 Flash 单价计算 |
| `deepseek-v4-pro` | 按 Pro 单价计算 |
| `deepseek-v4-flash` | 2026-09-10 12:00 起按 V4.1 Flash 单价计算 |
| `deepseek-v4-flash-vision-exp` | 2026-09-10 12:00 起按 V4.1 Flash 单价计算 |

旧模型名的兼容路由见 [DeepSeek 官方更新日志](https://api-docs.deepseek.com/zh-cn/updates/)。插件按消息发生时的规则计价，因此此前的记录仍使用对应时期的价格。

**会话中只要出现不支持的模型，插件就会隐藏整个会话的费用角标**，避免只显示部分费用。没有收到有效用量的会话也不显示角标。Headless 没有聊天界面，无法显示角标。

## 安装

### Desktop

1. 在侧栏打开「插件（Plugins）」，选择「添加插件（Add plugin）」。
2. 输入下方仓库地址，安装后启用 `dsh-session-cost`。
3. 完整退出 Desktop，包括托盘进程，再重新打开。

```text
https://github.com/Nalleyer/dsh_session_cost
```

Desktop 使用 `desktop` profile。装在 `web` profile 中的插件不会自动在 Desktop 中启用。

升级时按插件页提供的操作卸载后重装，并在详情页确认版本。GitHub 安装读取远端仓库，本地尚未推送的改动不会被安装。

### Web

```bash
dsh plugin --profile web add https://github.com/Nalleyer/dsh_session_cost
```

安装后重启使用 `web` profile 的 DSH host，再刷新页面。

## 使用

用支持的模型完成一次回复后，费用角标会在下一次刷新时出现；刷新间隔为 5 秒。点击角标打开明细，点击面板外部或按 Esc 关闭。

| 明细内容 | 说明 |
| --- | --- |
| 总费用 | 最多显示六位小数 |
| 计价 | 当前高峰／空闲状态，输入、缓存读取和输出的单价，单位为每百万 tokens |
| 模型 | 最近计费的模型；发生兼容路由时显示「请求名 → 实际计费名」 |
| 时段 | 下一次峰谷切换时间，以及高峰、空闲和平价记录各自的费用 |
| 用量 | 未命中缓存的输入、缓存读取、输出 tokens，缓存命中率和请求数 |
| 时间 | 保留明细中的首次和最近计费时间 |
| 按模型 | 会话使用过多个模型时，列出各模型的费用 |

角标上的「高峰／空闲」表示最近一条计费消息所处的时段。明细里的单价则按最近计费的模型在当前时刻查询，两者可能不同。时段切换不会改变已经记录的费用。

默认情况下，英文界面显示美元，其他语言显示人民币；也可以通过 `displayCurrency` 固定币种。两种金额分别按官方价格表计算，不通过汇率换算。

明细只在面板打开时请求，打开期间每 5 秒刷新。面板底部会显示价格数据的核对日期；早期明细已被归档时，也会注明记录条数。

## 费用怎么算

插件根据每条助手消息附带的 token 用量，按消息完成时刻取价。输入、缓存读取和输出分别计算，再累计到会话总额。

当前价格表采用北京时间（`Asia/Shanghai`）：

- 周一至周五的 `09:00–12:00` 和 `14:00–18:00` 为高峰时段。
- 其余时段为空闲时段，包括周末全天；空闲单价为高峰的一半。

**插件尚未单独处理中国法定节假日。** [官方价格说明](https://api-docs.deepseek.com/quick_start/pricing/)将这些节假日全天列为空闲时段，因此节假日落在周一至周五的高峰窗口时，插件估算可能偏高。

价格表随插件发布，由作者维护在 [lib/pricing-data.json](lib/pricing-data.json)，不会自动从官网获取更新。官方调价后，需要更新插件。用户配置不提供价格覆盖选项。

估算不包含订阅套餐和第三方渠道折扣，也无法反映本地模型的实际成本。其他渠道使用相同模型名时，插件仍按公开 API 标价计算。

## 记录保存在哪里

账本默认保存在当前 DSH 数据目录下：

```text
$DSH_HOME/storages/session-cost.json
```

正常退出后重新打开，插件会读取已保存的金额。Web 和 Desktop 只有使用同一数据目录时，才会读取同一份账本。

每个会话默认保留 2000 条逐条明细。超出后，早期记录只保留汇总金额和用量，仍计入总额，但不再参与按模型、按时段拆分；明细中的时间范围也只涵盖保留的记录。

价格规则更新后，插件会在启动时按各条明细的原始时间重新计价。已归档的汇总保留原金额，无法逐条重算。升级到 `1.2.1` 后，保留明细中此前误按 Flash 计价的 Pro 记录会改按 Pro 单价计算，已归档的部分无法修正。

## 配置

默认配置见 [cordis.patch.yml](cordis.patch.yml)。如需调整，在当前 profile 的配置层中覆盖 `session-cost` 对应的配置。

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `displayCurrency` | `auto` | 跟随界面语言；设为 `CNY` 或 `USD` 可固定币种 |
| `symbol` | `¥` | 人民币显示符号 |
| `symbolUsd` | `$` | 美元显示符号 |
| `persistPath` | `$DSH_HOME/storages/session-cost.json` | 账本文件路径 |
| `maxMessagesPerSession` | `2000` | 每个会话保留的逐条明细数，影响可拆分和重算的范围 |
| `loopbackOnly` | `true` | 查询端点只允许回环地址访问 |

## 安装后没有显示金额

依次检查：

1. 插件是否已启用，并安装在当前运行的 profile 中。Desktop 用 `desktop`，Web 用 `web`。
2. 安装后是否重启了对应的 host。Desktop 需要退出托盘进程，Web 需要刷新页面。
3. 启用插件后，是否用支持的模型完成过一次回复。旧聊天记录不会补算，回复还需要携带有效用量。
4. 同一会话是否出现过不支持的模型。出现后，整个会话的费用角标会隐藏。
5. Web 是否通过远程地址访问。`loopbackOnly: true` 时，费用查询只接受回环连接。

## 本地开发

需要 Node.js 20 或更新版本。在仓库目录安装依赖：

```bash
npm ci
```

Windows 安装助手通过官方 CLI 链接当前仓库：

```powershell
# Web：使用 PATH 中的 dsh
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile web

# Desktop：使用内置 CLI；自定义安装时替换为实际路径
$desktopCli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile desktop -DshCommand $desktopCli
```

自定义数据目录可加 `-DshHome <path>`。助手只在安装命令执行期间设置 `DSH_HOME`，结束后恢复原值；运行 host 时也需要使用对应的数据目录。

CLI 和 Desktop 可能来自不同版本的安装，给 Desktop 安装本地插件时应使用其内置 CLI。源码修改后重启对应 host，Web 还需刷新页面。

### 检查与测试

```bash
npm run check
npm test
```

`check` 检查三个 `lib` JavaScript 文件的语法。测试覆盖峰谷计价、模型路由、账本、HTTP 端点和客户端交互。

客户端文件无需构建。客户端测试通过 jsdom 和 React 渲染组件，检查角标位置、明细开关、语言切换及无可用记录时的隐藏行为；缺少开发依赖时会跳过这些测试，检查结果时应留意跳过项。

现有兼容性检查记录针对官方 Desktop `0.2.0-rc.2`（2026-10-09）：已核对内置模块，并在隔离环境检查 host 记账、HTTP 端点及客户端注册与卸载。Desktop 的 GitHub 安装流程、原生窗口布局和官方定位 hook 仍需在实际应用中验收。

安装后可用以下操作验收：完成一次 Flash 回复并展开明细；用 Pro 检查计费模型；切换中英文和会话；完整退出后重开，再继续聊天，确认金额保留且请求数继续增加。

### 文件与查询接口

| 文件 | 职责 |
| --- | --- |
| [lib/pricing-data.json](lib/pricing-data.json) | 模型、历史价格、峰谷窗口、兼容路由和来源日期 |
| [lib/pricing.js](lib/pricing.js) | 计价函数 |
| [lib/index.js](lib/index.js) | host 记账、持久化和查询端点 |
| [lib/client.js](lib/client.js) | 费用角标和明细面板 |
| [test/](test/) | 自动化测试 |
| [tools/](tools/) | 本地 CDP 探针，用于检查实际页面的 DOM、样式和控制台错误，不随包发布 |

host 提供两个 GET 端点，默认仅允许回环访问：

```text
/session-cost/session/<id>
/session-cost/session/<id>/detail
```

概览返回 `cost`（人民币）、`costUsd`（美元）、token 用量、`calls`、`lastMode`、`supported` 和显示配置。明细另含 `cacheHitPercent`、`firstTime`、`lastTime`、`models[]`、`modes`、`pricing`、`nextSwitch` 和 `trimmed`。

`supported: false` 时客户端隐藏角标。未知会话返回零汇总，明细的 `pricing` 为 `null`。价格表更新后，插件会重新判断已记录的不支持模型名是否已获支持；旧账本缺少模型名且仍有计费记录时，会保留隐藏状态。

客户端注册到 `conversation.composer.dock`，将角标挂到 `[data-composer-stats]` 行的右端；找不到该行时使用自己的 dock 行。`dsh.client.platform` 的 `web` 表示客户端模块平台，Desktop 的 profile 名称仍是 `desktop`。

## 许可

[MIT](LICENSE)
