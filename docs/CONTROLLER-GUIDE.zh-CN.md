# AdminLogger 控制端

一个独立的 Node.js 项目，用 Steam 账号登录、为 Rust 申请并保持认证票据，然后通过 WebSocket 对接用户提供的 `AdminLogger.cs`。管理界面为中文。

公网服务器的 Windows/Linux 启动、HTTPS、systemd 常驻和压缩包校验见 [PUBLIC-DEPLOY.md](../PUBLIC-DEPLOY.md)。

## 快速启动

要求 Windows 和 Node.js 22 或更新版本。代码也可在其他 Node 22 平台运行；Windows 使用 DPAPI 保护加密密钥，其他平台使用受文件权限保护的本地密钥。

1. 双击 `start.cmd`。首次启动自动安装锁定版本的依赖，默认监听 `127.0.0.1:3220`。
2. 保持服务运行，双击 `open-dashboard.cmd` 打开并解锁页面。也可访问 `http://127.0.0.1:3220`，手动读取 `data/api-key.txt`。
3. 添加服务器，填写**该 Rust 服务器能访问的控制端地址**。
4. 将 `plugin/AdminLogger.cs` 放入目标 Rust 服务器的 `oxide/plugins/` 或 `carbon/plugins/`。已有部署先保留原插件及配置副本。
5. 点击服务器卡片上的“配对命令”，复制到 Rust 管理员控制台/RCON 执行，等待服务器卡片显示“已连接”。
6. 添加自己的 Steam 账号，按需完成邮箱或手机验证码，等待账号“在线”。支持每行 `账号:密码` 批量导入。
7. 点击“新建分配”，选择账号和服务器。也可勾选多个账号后“分配选中”。
8. 会话先显示“实体已创建 · 等待认证”，收到插件的 `steam_auth_ok` 后才显示“Steam 认证已通过”。
9. 单条会话使用“停止”，整台服务器使用“一键停止”；账号区的“一键退出全部”会先停止关联会话，再退出 Steam。结束整个控制端使用左下角“停止服务”。

仓库不含任何账号、密码、票据或旧项目的本地数据。账号需能登录 Steam，Rust 使用权限和票据申请结果由 Steam 决定。

## 异地服务器如何连接

`start.cmd` 的默认回环地址只适合同机连接。Rust 服务器位于另一台机器时：

- 在局域网使用 `start-network.cmd`，监听所有网卡；添加服务器时填写例如 `http://192.168.1.10:3220`。目标服务器需能访问这个 TCP 端口。
- 公网使用 HTTPS 反向代理，把自己的域名转发到本机 `127.0.0.1:3220`；填写例如 `https://panel.example.com`，页面生成 `wss://panel.example.com/ws`。
- 不要给异地服务器填写 `127.0.0.1`。这里填写的是**控制端地址**，不是游戏服务器的 IP。
- 反向代理需保留 `Authorization`、`Host`，并支持 `/ws` WebSocket Upgrade。地址使用域名根路径，不使用 `/panel` 等子路径。

Caddy 示例（域名和 DNS 由部署者配置）：

```caddyfile
panel.example.com {
    reverse_proxy 127.0.0.1:3220
}
```

如端口被防火墙或云服务器安全组阻断，需要在实际网络环境中放行。管理 API 和插件使用不同的密钥；管理密钥不要当成配对密钥使用。

## 已实现的功能

| 功能 | 实现 |
|---|---|
| Steam 多账号 | 账号密码/保存令牌登录、Guard、自动重连、批量导入、退出与删除 |
| 私密存储 | AES-256-GCM；Windows DPAPI；密码不保存，刷新令牌加密保存 |
| Rust 票据 | 固定 AppID 252490；归属/签名检查；内存持有；结束后取消并清零 |
| 插件连接 | Bearer 配对、hello/hello_ack、双向心跳、命令与响应关联 |
| 机器人控制 | register_bot、unregister_bot、reconcile；多服务器、账号独占分配 |
| 公共在线人数 | 每张服务器卡片显示 Facepunch 公共人数；页面解锁且可见时每 3 秒查询一次 |
| 最终认证 | 独立跟踪 steam_auth_ok/lost，不把创建成功或会话布尔值当成认证成功 |
| Facepunch 遥测试验 | 服务器与角色核对后，上传模拟浏览事件、世界资源事件、输入及性能；使用每账号 analytics 专用票据，停止后清理 |
| 重连事件与批次 | 客户端会话跨临时重连保留，连接标识独立更新；世界资源及性能合并入表，失败时保留连接事件 |
| 认证维护 | 认证失效或 90 秒未收到最终回调时，先结束旧会话，再申请新票据重新注册 |
| 掉线恢复 | 插件恢复后先核对名单；已有实体不重复创建；缺失实体使用仍活动的租约恢复 |
| 不确定结果 | 命令超时/断线后保持票据并先 reconcile，不盲目重发创建 |
| 停止清理 | 在线时先移除远程实体，再取消票据；离线时记录待清理，重连后执行 |
| 进程重启 | 恢复自己保存的新账号与分配；清理上次受管实体后申请新票据；不恢复历史项目账号 |
| 事件 ACK | 有界持久化去重，兼容插件重载后 ID 从头计数；不保存原始 detail |
| 插件更新协议 | 固定插件文件的 SHA256 接口；源码下载默认关闭，可显式启用 |

控制端不需要 Python、Rust 游戏客户端 DLL、原项目的 A2S 代理，也不依赖原项目目录或其运行进程。

当前版本为 **1.0.12，配套插件 2.5.9**。服务器卡片新增“一键停止”，账号区新增无需勾选的“一键退出全部”，均自动处理关联会话。保留 1.0.11 的清理修正、30 秒认证失效重建等待、Steam 票据列表 CRC 审计和暂停客户端遥测模式。使用步骤与判读边界见 [人数下降诊断](POPULATION-DIAGNOSTICS.md)。回家后进行正常客户端、Steam 与 Facepunch 联合研究，按 [研究与采集计划](CLIENT-STEAM-FACEPUNCH-RESEARCH.md) 执行。

服务器卡片的「一键停止」只停用该服的全部会话，保留分配与 Steam 登录；「删除全部分配」会进一步删除分配记录。插件离线时保留待清理状态，重连后清理；待删除记录仅在确认清理后移除。账号区的「一键退出全部」无需勾选，先停止所有账号的关联会话，再退出 Steam 并取消自动重试；也保留「退出选中」及单账号「退出」。账号和分配记录保留，恢复时先登录，再启动分配。

Steam 登录遇到网络中断、服务暂不可用或限流时会自动退避重试，列表显示下次重试时间。优先用已保存的登录令牌；首次登录尚无令牌时，密码仅在内存中用于本次登录及其重试，不写入磁盘。手动退出会取消重试。密码错误、令牌不可用和 Steam Guard 验证需要按界面提示处理。

插件自动读取当前地图文件名、资源依赖、地图地址与世界时间戳，连接时及后续状态核对时同步给控制端，换图后自动更新。升级时保留原有 `data`，替换程序文件，并将 `plugin/AdminLogger.cs` 更新到 Rust 服务器的插件目录；本次认证审计需要更新到 2.5.9。详情见 [人数分析与自动地图更新说明](2026-11-01_后端-人数下降与自动地图-report.md)。

1.0.8 / 2.5.8 修复地图缓存计时字段使用 `float`，而服务器 `TimeEx.realtimeSinceStartup` 返回 `double` 引发的编译错误；两处缓存截止时间赋值均使用双精度。已经运行1.0.7后端的用户可以只替换服务端插件并重载。修复与验证见 [插件编译修复说明](2026-11-01_插件-双精度计时修复.md)。

后端运行、Steam 登录、认证失效原因、实体消失、会话释放原因、插件连接及公共人数历史写入 `data/logs/controller/events.jsonl`，自动轮换保留。管理页查询公共人数时，首次、人数或状态变化及每分钟样本会落盘。开启「人数诊断」后，后台每 10 秒采样，关闭页面仍继续；完整快照写入 `data/logs/population/events.jsonl`。日志记录查询时间、接口数据时间、缓存年龄及允许保留的缓存响应头，便于核对延迟数据。

包含 1.0.6 的连接重置修复，未通过认证的 WebSocket 请求断开时，`read ECONNRESET` 不再导致整个后端退出，详见 [连接重置修复说明](2026-10-31_后端-ECONNRESET修复-report.md)。

任务建立后先发送浏览事件，约 30 秒生成首次性能事件，世界资源与性能等待下一次游戏表发送窗口；后续性能每 10 分钟生成。双击 `facepunch-status.cmd` 可选查看每类 HTTP 状态、待发事件、连接序号和地图同步状态，无需运行它才能同步地图。详细请求 JSON、响应正文及错误写入 `data/logs/facepunch/` 的每账号文件。旧的地图导入工具仅保留用于历史版本排查。历史实测步骤见 [docs/FACEPUNCH-TEST.md](FACEPUNCH-TEST.md)。HTTP 成功不能证明游戏连接或公共人数发生变化。

增加的日志诊断工具可通过 `facepunch-log-audit.cmd` 使用，控制端未运行时也能核对历史文件。它按账号关联请求、响应及票据清理记录，检查正文哈希和字节数，支持与原生客户端日志比较事件数量和大小。摘要默认写入 `data/diagnostics/facepunch-log-audit.json`，不包含原始请求头或正文。使用方法见 [docs/LOG-DIAGNOSTICS.md](LOG-DIAGNOSTICS.md)。

## 对原项目的复用

从 `rust-game-server-fake-player/steam-multi-account/src/` 复用了四个模块：

- `accounts.js`：Steam 账号、Guard、登录令牌和重连管理。
- `game-auth.js`：票据申请、归属校验、独占租约、取消与清零。
- `store.js`：AES-GCM、Windows DPAPI、本地 API 密钥。
- `errors.js`：带 HTTP 状态的错误。

新增精简的 `features.js` 适配器，替代原项目的库存、商店和独立 Rust 客户端功能。新增控制器状态、插件 WebSocket 服务、机器人生命周期、HTTP API、中文界面、启动脚本和测试。来源与许可见 `NOTICE`、`LICENSE`。

## 项目内的插件副本

`plugin/AdminLogger.cs` 基于提供的 2.5.5 样本，当前本地集成修订为 2.5.9。2.5.7 增加地图资料自动读取与同步，2.5.8 修复双精度计时兼容，2.5.9 增加认证操作审计；此前的集成修订针对以下问题：

- 同 Steam ID 已有非本插件玩家实体时拒绝创建，避免清理真实玩家或睡眠实体。
- 移除机器人时也关闭失败/待定的 Steam 会话；显式原地重建仍能保留会话。
- 移除前解除字典归属，避免 Kill 钩子安排重生；旧死亡定时器不重生后来创建的同 ID 实体。
- 死亡重生保留缓存票据；刷新票据先结束旧会话并更新缓存。
- 修正 `rne.status` 在线秒数的数据来源。
- 串行化 ClientWebSocket 发送，避免响应、ACK、心跳和事件重叠发送。
- 启动任务捕获对应取消令牌；调试日志不再打印包含票据的完整 WS payload。

以下脚本仅用于从原始样本重现历史 2.5.6 集成，不会生成当前插件；请勿用它覆盖发行包中的 2.5.9：

```powershell
node scripts/prepare-plugin.mjs ..\AdminLogger.cs
```

脚本核对原文件 SHA256 后才应用补丁。它不是通用的其他版本升级器。原插件的其他行为，包括列表补丁、统计提交、自身上报过滤和日志截断，仍来自原样本；普通 `status` 缺正常表格行的问题未在本次改动中修复。

控制器使用的协议兼容原始 2.5.5，但推荐部署项目中的修订副本，以免认证失败后旧 Steam 会话未结束影响后续注册。插件尚未在当前机器上使用实际 Rust/Oxide/Carbon 程序集编译或加载；游戏版本兼容性必须在目标服务器确认。

## 配置

通过进程环境变量配置，可在 PowerShell 中设置后运行 `npm.cmd start`：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | 3220 | HTTP 与 WebSocket 端口 |
| `LISTEN_HOST` | 127.0.0.1 | 监听地址；`start-network.cmd` 设置为 0.0.0.0 |
| `CONTROLLER_DATA_DIR` | 项目内 data | 独立数据目录 |
| `STEAM_HTTP_PROXY` | 未设置 | Steam CM 使用的 HTTP/HTTPS 代理完整 URL；direct 表示直连 |
| `ALLOW_PLUGIN_DOWNLOAD` | 未设置 | 仅设置为 1 才允许插件下载接口返回固定副本 |

数据位于 `data/steam/` 和 `data/controller/`。配对密钥、账号刷新令牌和分配记录加密保存。`data/api-key.txt` 用于解锁管理 API。`service.lock` 阻止两个进程同时写同一数据目录。

Windows 加密密钥绑定创建它的 Windows 用户，不是可跨机器直接搬运的登录包。票据不落盘、不由管理 API 返回、不写日志。事件仅保存类型、时间、服务器和 Steam ID；原版真人事件 detail 不保存。当前页面日志重启后清空，去重摘要有界保存。

创建分配时无需填写 IP。控制端从随包附带的中国大陆 IPv4 网段库中随机选择公网格式地址，同一控制端的分配记录避免重复，地址随分配记录保存，重连、换票和重启保持不变。升级启动时，旧记录中为空或 `0.0.0.0` 的地址会自动补齐，插件重新创建实体后生效。该字段是插件展示元数据，不代表实际持有该地址，也不会改变真实网络来源。网段库来源及日期见 `src/network/china-ipv4.json`，不在创建分配时访问外部查询服务；不同 GeoIP 服务可能有归属差异。

## HTTP 接口

服务器卡片的“公共在线人数”通过控制端查询 `https://api.facepunch.com/api/public/steamServers/playerCounts/rust`，按 `游戏公网IPv4:游戏端口` 匹配，与插件实体数分别显示。返回 `0` 显示“0 人”，没有条目显示“未收录”，失败显示“查询失败”并将上次成功人数标记为过期。卡片显示查询时间和接口数据更新时间；每 3 秒发起查询不代表 Facepunch 后端每 3 秒更新数据。请求超时或上一次请求尚未结束时不叠加请求。

排查人数差异时，先看同一张卡片的“插件角色”“已出现的分配”和“最终 Steam 认证”。“已出现的分配”以当前启用分配为分母；“最终 Steam 认证”只统计名单中已收到成功回调的分配。插件断开或还未核对时，这些人数为未知。分配详情显示本次认证成功时间和本次控制端运行期间上次会话结束的原因。已有的 `public_player_count` 运行日志同时记录核对快照，并在本地人数或公共人数变化时追加，便于按时间对照。若需从服外查询，用插件报告的 UDP 查询端口（或实际公网映射端口）；公共人数仍按游戏端口匹配。公共总数无法归因到单个 Steam ID。

查询地址优先使用服务器“设置”中手动填写的游戏公网 IP、游戏端口，其次使用插件上报的 `server_ip`、`game_port`；上报 IP 为 `0.0.0.0` 或私网地址时尝试使用插件直连的公网来源 IP。不使用查询端口、RCON 端口或控制端 URL 推断游戏端口。反向代理、NAT 端口映射或识别不到地址时，请在“设置”里手动填写实际游戏公网地址。不同服务器及浏览器窗口共用一次上游查询结果，查询不需要 RCON 密码，也不改动游戏服务器。

管理请求都使用 `Authorization: Bearer <data/api-key.txt>`；写请求使用 `Content-Type: application/json`。不要将票据作为管理接口参数上传。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | /health | 无需密钥的存活检查 |
| GET | /api/state | 账号、服务器、分配和脱敏事件状态 |
| GET | /api/public-player-counts | 各服务器公共人数、匹配地址、查询状态和接口数据更新时间 |
| POST | /api/accounts | accountName、password；添加并登录 |
| POST | /api/accounts/import | text，每行账号:密码，最多 100 行 |
| POST | /api/accounts/:id/login | 使用保存的登录令牌 |
| POST | /api/accounts/:id/guard | code，提交验证码 |
| POST | /api/accounts/:id/logout | 先停止分配，再退出账号 |
| DELETE | /api/accounts/:id | 停止并删除本地账号 |
| POST | /api/servers | name、publicUrl、可选 gameIp/gamePort/queryPort；添加服务器 |
| PATCH | /api/servers/:id | 更新名称、控制端地址、游戏公网 IP、游戏端口与 UDP 查询端口 |
| GET | /api/servers/:id/pair | 生成含配对密钥的命令，仅供管理员 |
| POST | /api/servers/:id/sync | 核对远程实体 |
| POST | /api/servers/:id/ping | 插件存活探测 |
| POST | /api/servers/:id/diagnostics | enabled 布尔值；开启/停止后台人数诊断，保存设置 |
| DELETE | /api/servers/:id | 无关联分配时移除服务器 |
| POST | /api/assignments | accountId、serverId、可选 displayName；ip 由控制端自动生成，忽略传入值 |
| POST | /api/assignments/:id/start | 启用分配 |
| POST | /api/assignments/:id/stop | 停止并尝试远程清理 |
| DELETE | /api/assignments/:id | 清理完成后删除分配 |
| POST | /api/shutdown | 正常清理并停止服务 |

插件专用 `/ws`、`/api/plugin/hash?name=AdminLogger.cs` 和可选 download 使用该服务器的配对密钥。WebSocket 命令 ACK 仅表示消息处理，不代替业务 resp 或 Steam 认证回调。

## 验证与边界

```powershell
npm.cmd test
npm.cmd run check
node scripts/browser-smoke.mjs
# 可选：PowerShell 7 中编译并验证本次修改的插件认证 helper
pwsh -File scripts/check-plugin-auth.ps1
```

测试使用合成 Steam 客户端和真实本地 HTTP/WebSocket 传输，覆盖票据生命周期、Guard、认证时序、超时、掉线清理、重连、重复事件、账号独占、加密存储和接口认证。浏览器验证需要本机 Chrome/Edge，可用 `BROWSER_PATH` 指定，使用临时数据目录，不登录 Steam。截图保存在 `docs/`。

1.0.11 的新增恢复逻辑尚未完成真实服务器上的联合运行验证；插件认证审计 helper 已提取实际源码编译并以模拟 Steam 接口验证。Steam 票据申请成功、插件实体存在、认证成功、EAC 有效和 Facepunch 公共人数是不同结果。项目包含模拟客户端遥测试验，不实现完整 Rust 游戏客户端或 EAC 会话；公共人数由平台判定，不能保证与分配数一致。

掉线期间最多保持票据两分钟，之后结束本地租约并保留远程清理记录。控制端无法向离线插件立即删除实体。不要在“待清理”时手动删掉状态文件，否则会丢失后续清理所需的受管身份记录。

控制端和插件现有本地认证尝试编号，但 Steam 原生回调没有对应编号，因此仍无法精确归属延迟回调；成功状态来自插件上报。其他控制器不应同时管理同一 Steam ID。共享/外部机器人会显示在核对结果中，但本控制端不会主动删除未记录为自己管理的身份。

管理员密钥或配对命令只通过管理页面/本地文件查看，不要放入共享截图或提交到版本库。依赖和 data 目录已在 `.gitignore` 排除。
