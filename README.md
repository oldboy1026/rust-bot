# Rust Bot / AdminLogger Controller

[中文](#中文) · [English](#english)

Node.js **22+** · Controller **1.0.12** · Plugin **2.5.9**

## 中文

### 项目和当前状态

Steam 多账号、Rust 认证票据与 AdminLogger 插件会话控制端，包含中文面板、认证审计、后台人数诊断及实验性的模拟客户端遥测。

**`AuthTicketCanceled` 与公共人数逐渐下降仍是未解决的研究问题，尚未实现或验证所有账号都能长期计入公共人数。** 项目没有实现完整 Rust 客户端、正常网络连接生命周期或 EAC 客户端会话。Steam 登录、票据认证、插件实体、HTTP 上报与公共计数必须分别判断。

已实现：

- 账号导入、登录、Guard、暂时性登录失败自动重试，以及单账号/选中账号/全部账号退出。
- 每张服务器卡片支持**一键停止**：处理会话、实体和票据清理，保留分配与 Steam 登录；插件离线时保留待清理状态。
- 账号区支持**一键退出全部**：无需勾选，先停止关联会话，再退出 Steam 并取消登录重试。
- 最终认证回调、票据指纹、租约/尝试编号、票据列表提交和 ACK 审计。
- 后台每 10 秒记录本地状态、A2S 与 Facepunch 人数；客户端遥测可单独暂停以进行隔离实验。

### 已出现的问题

证据来自 **2026-11-11 的 17 账号运行**，时间为北京时间：

| 现象 | 已知事实与边界 |
| --- | --- |
| 四个账号反复认证失效 | 共 27 次 `AuthTicketCanceled`；Steam ID 尾号为 04372、13895、59974、31375。关联的本地 EndSession/取消记录晚于失败回调，尚未确定取消来源 |
| 其余十三个账号无认证失效记录，公共人数仍下降 | 每个本轮一张游戏票据、两轮含性能事件的成功上传。只表示最后 OK 未被观察到的失败撤销，不是独立实时 Steam/EAC 核验 |
| 公共人数从 7/8 降至 2 | 13:52 后持续为 2；约 13:56 十三个账号再次成功上传性能批次，人数仍未恢复。中途有真实玩家进入，分配启动前也有背景计数 |
| A2S/实体数与公共人数不一致 | 多个快照仍为 17 个插件实体、A2S 19、Bots=0；不代表对应数量的正常玩家被平台认可 |
| 不能确定具体哪个账号被计数 | 公共接口只有总数，没有账号名单。不能据此认定固定七个、最后固定一个机器人，或用 13−7 定位六个账号 |

已修正的是匹配 Steam 失效通知后的清理误报，另增加 30 秒认证失效重建等待及票据列表审计。**这不代表外部取消原因和公共计数根因已解决。HTTP 200 也不证明事件入库、会话关联或被计入人数。**

详细记录：[17 账号运行分析](docs/17账号运行分析-20261111-1404.md)。

### 要研究的问题

1. **Steam 交互**：正常客户端与控制端的 Steam 连接、游戏/`analytics` 两类票据、`ClientAuthList` 提交与 ACK、CRC 集合和状态通知。检查遥测添加/清理时是否仍保留游戏票据。
2. **取消的因果顺序**：按账号、租约、尝试、票据指纹和 CRC 关联申请、验证、EndSession、实际取消调用及回调。只有账号 ID 的原生回调无法精确标识哪张票据，不应随意忽略或归属。
3. **正常 Rust 入服与持续在线**：观察主菜单→连接→加载完成→静止保持→退出/重连，包括网络连接、Steam/EAC 状态、持续收发和服务器事件，找出模拟路径的差异。
4. **Facepunch 交互**：事件类型、字段来源、会话标识、采样/上传时间、顺序、HTTP 响应和服务器事件送达证据，与公共人数变化对齐。普通 PCAP 无法直接解出全部 HTTPS/Steam 加密正文。
5. **账号历史是否有关**：使用单账号及可解释的背景计数测试；尚无证据证明以前上传的数据会让某账号永久被计数。

优先以**同一账号、同一服务器**分别运行正常 Rust 客户端与控制端，避免同号并发；正常客户端静止至少 30 分钟，先记录自然故障，再单独采集主动停止/退出。关闭遥测的实验用于判断取消是否依赖该流程，不以人数增加作为成功标准。

完整日志开关、实验分组、三条链路采集项和交接提示见 [研究与采集计划](docs/CLIENT-STEAM-FACEPUNCH-RESEARCH.md)。

### 如果你修复成功，请告诉我成功的思路

欢迎提交 GitHub Issue/PR，或联系 **[oldboy1026@gmail.com](mailto:oldboy1026@gmail.com)**。请说明：

- **根因与证据**：哪个调用、状态变化或缺失步骤导致问题，哪些仍是假设。
- **成功的思路与修改**：为什么这样改有效，涉及的文件/函数，以及提交或补丁。
- **复现和前后对照**：版本、实验条件、账号/真实玩家数、时区，及认证与公共人数时间线。
- **持续性验证**：覆盖原故障窗口的运行和重复测试；短时人数上升、HTTP 200 或本地认证标记不能单独证明成功。
- **脱敏日志**：保留关联 ID、指纹/CRC 和时间，移除密码、原票据、令牌、API 密钥及 Cookie。

**希望反馈的不只是“成功了”，还包括“为什么以前失败，这次为什么成功”。**

### 启动与配置

安装 Node.js 22+：

```sh
npm ci
npm start
```

Windows 可双击 `start.cmd` 和 `open-dashboard.cmd`。默认面板 `http://127.0.0.1:3220`，管理密钥由本机生成于 `data/api-key.txt`。安装插件、添加服务器并配对，再登录自己的账号。

**公开仓库不包含上报应用密钥、账号库、登录令牌或运行日志。** 遥测试验需要在启动控制端的同一 PowerShell 中配置应用密钥：

```powershell
$env:FACEPUNCH_API_KEY = 'your-application-key'
npm start
```

未配置时，遥测明确报告配置错误，不申请上传票据、不发送空密钥请求；Steam 登录、游戏会话及人数诊断仍可使用。程序不自动加载 `.env`。新电脑需重新配置账号与服务器，旧 Windows 用户保护的加密数据不保证可迁移。

单独隔离控制端客户端遥测：

```powershell
$env:CONTROLLER_TELEMETRY = 'off'
npm start
```

检查命令：

```sh
npm test
npm run check
node scripts/browser-smoke.mjs
```

浏览器检查需要本机 Chrome/Edge；可选的插件地图 helper 检查需要 .NET SDK 8+。测试使用模拟 Steam/插件及本地接收端，通过不代表真实公共人数已恢复。

文档：[完整控制端指南](docs/CONTROLLER-GUIDE.zh-CN.md) · [公网部署](PUBLIC-DEPLOY.md) · [人数诊断](docs/POPULATION-DIAGNOSTICS.md) · [发布验证](docs/PUBLICATION-VALIDATION.md)

## English

### Overview and current status

A controller for multiple Steam accounts, Rust authentication tickets and AdminLogger plugin sessions. It includes a Chinese dashboard, authentication audits, background population diagnostics and experimental simulated client telemetry.

**`AuthTicketCanceled` and declining public counts remain unresolved research problems. Sustained public inclusion of every account has not been implemented or verified.** This project does not implement a complete Rust client, its normal network lifecycle or an EAC client session. Steam login, ticket validation, plugin entities, HTTP uploads and public population are separate observations.

Implemented features:

- Account import, login, Guard, retries for temporary failures, and individual/selected/all-account logout.
- **Stop all sessions** on each server card: handle session/entity/ticket cleanup while retaining assignments and Steam login; offline cleanup remains pending until reconnection.
- **Log out all accounts** without selecting rows: stop associated sessions, disconnect Steam and cancel automatic login retries.
- Audits for final authentication callbacks, fingerprints, leases/attempts and submitted/acknowledged ticket lists.
- Background sampling of local state, A2S and Facepunch every 10 seconds; a separate controller-telemetry isolation mode.

### Observed problems

Evidence comes from a **17-account run on November 11, 2026**, using Beijing time (UTC+8):

| Observation | Facts and limitations |
| --- | --- |
| Four accounts repeatedly lost authentication | 27 `AuthTicketCanceled` callbacks; Steam ID suffixes 04372, 13895, 59974 and 31375. Associated local EndSession/cancellation records followed the failures; the cancellation source is unknown |
| Thirteen accounts had no recorded auth loss while public counts declined | Each used one game ticket and completed two successful batches containing performance events. This means no observed failure revoked their last OK callback, not independent continuous Steam/EAC attestation |
| Public counts dropped from 7/8 to 2 | Queries stayed at 2 after approximately 13:52. Further successful performance uploads around 13:56 did not restore the count. A real player joined, and a background count existed before assignments started |
| A2S/entities disagreed with public counts | Multiple snapshots still showed 17 plugin entities and A2S 19, Bots=0. These do not establish equivalent platform-recognized player counts |
| Account-level inclusion cannot be identified | The public endpoint returns a total, not an account list. It cannot identify exactly seven included accounts, one permanently included bot, or six excluded accounts by subtracting 7 from 13 |

Matched-invalidation cleanup misreporting has been fixed; a 30-second auth-loss retry delay and ticket-list audits were added. **This does not establish that cancellation or population root causes have been fixed. HTTP 200 does not prove ingestion, correct session association or public inclusion.**

Detailed evidence: [17-account analysis, Chinese](docs/17账号运行分析-20261111-1404.md).

### Research questions

1. **Steam interaction:** compare normal-client/controller Steam connections, game and `analytics` tickets, `ClientAuthList` submissions/ACKs, CRC sets and status notifications. Check that analytics add/remove operations retain the game ticket in the actual submitted list.
2. **Ordering around cancellation:** correlate issuance, validation, EndSession, actual cancellation calls and callbacks by account, lease, attempt, fingerprint and known CRC. Account-only native callbacks cannot precisely identify a ticket; preserve this uncertainty.
3. **Normal Rust connection and idle behavior:** observe menu→connection→loading completion→idle→disconnect/reconnect, including transport, Steam/EAC state, continuing traffic and server events. Identify differences from the simulated path.
4. **Facepunch interaction:** align actual events, field sources, session identifiers, sample/upload timestamps, ordering, HTTP responses and server-event delivery evidence with population changes. Ordinary PCAP cannot directly expose all HTTPS/encrypted Steam bodies.
5. **Account history:** use isolated accounts and an explained baseline. There is no evidence that past uploads permanently keep an account counted.

Run the **same account and server** separately through the normal client and controller, avoiding simultaneous sessions. Keep the normal client idle for at least 30 minutes; capture natural failures before deliberately stopping/logging out. Telemetry-off experiments test cancellation dependencies, not population increases.

The [research/capture plan, Chinese](docs/CLIENT-STEAM-FACEPUNCH-RESEARCH.md) includes logging commands, experiment groups, collection requirements and a handoff prompt.

### If your fix works, please explain how and why

Open a GitHub issue/pull request or contact **[oldboy1026@gmail.com](mailto:oldboy1026@gmail.com)** with:

- **Root cause and evidence:** the responsible call, state transition or missing step; distinguish observations from hypotheses.
- **Your successful approach:** why it works, affected files/functions, and a commit or patch.
- **Reproduction and before/after results:** versions, conditions, account/real-player counts, time zone, and authentication/population timelines.
- **Sustained verification:** operation covering the previous failure window and repeated tests. A brief increase, HTTP 200 or a local auth flag alone is insufficient.
- **Sanitized logs:** retain correlation IDs, fingerprints/CRCs and timestamps; remove passwords, raw tickets, tokens, API keys and cookies.

**Please explain both why the previous implementation failed and why your fix succeeds, rather than only saying “it works.”**

### Getting started and configuration

Install Node.js 22+:

```sh
npm ci
npm start
```

Windows users can run `start.cmd` and `open-dashboard.cmd`. The dashboard defaults to `http://127.0.0.1:3220`; its management key is generated locally in `data/api-key.txt`. Install the plugin, configure/pair the server and sign in with your own accounts.

**The public repository contains no telemetry application key, account database, login tokens or runtime logs.** Supply the application key in the environment of the process starting the controller. PowerShell:

```powershell
$env:FACEPUNCH_API_KEY = 'your-application-key'
npm start
```

Without a key, telemetry reports a configuration error before requesting an upload ticket or making an HTTP request. Steam login, game sessions and population diagnostics remain available. `.env` files are not loaded automatically. Configure accounts/servers again on a new computer; encrypted data protected by a different Windows user/system is not necessarily portable.

To isolate game authentication by disabling controller client telemetry:

```powershell
$env:CONTROLLER_TELEMETRY = 'off'
npm start
```

Validation:

```sh
npm test
npm run check
node scripts/browser-smoke.mjs
```

Browser checks require local Chrome/Edge; the optional plugin map-helper check requires .NET SDK 8+. Tests use simulated Steam/plugin behavior and local receivers; passing does not establish production population recovery.

Documentation: [full guide, Chinese](docs/CONTROLLER-GUIDE.zh-CN.md) · [deployment](PUBLIC-DEPLOY.md) · [diagnostics, Chinese](docs/POPULATION-DIAGNOSTICS.md) · [publication validation](docs/PUBLICATION-VALIDATION.md)

## License / 许可

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for Apache 2.0 licensing, upstream attribution and the separately described plugin licensing status.
