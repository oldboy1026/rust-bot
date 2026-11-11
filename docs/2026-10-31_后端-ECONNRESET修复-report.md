# AdminLogger Controller 1.0.6：连接重置崩溃修复

本次已复现用户提供的 `read ECONNRESET`、`Unhandled 'error' event` 和 `Socket` 堆栈，并修复一个可触发该崩溃的后端分支。未通过认证的 WebSocket 请求收到拒绝响应后，如果对端重置 TCP 连接，旧版会因原始 Socket 缺少错误监听而退出。1.0.6 在认证判断前安装 Socket 错误处理，发生错误只销毁该连接。此问题与地图配置无关。

原项目 `D:\桌面\新建文件夹\adminlogger-controller` 已直接更新为 1.0.6。用户报错中的 `C:\Users\Administrator\Desktop\demo\adminlogger-controller\adminlogger-controller` 在当前环境未找到，因此该运行副本需要使用交付包覆盖更新。账号、地图配置、管理密钥和现有插件均可继续使用。

## 原因与修复

HTTP 连接转入 Upgrade 处理后，其原始 Socket 由升级处理代码负责。旧版 `src/hub.js` 的 `upgrade()` 先检查认证；不符合条件时直接 `socket.end(401...)`，没有安装 Socket 的 `error` 监听。`ws.handleUpgrade()` 的错误保护只有在认证通过后才会安装，因此覆盖不到被拒绝的分支。

普通 TCP 连接被对端重置是可恢复的连接错误。它变成进程退出，是因为 Node.js 的 EventEmitter 在没有监听器时抛出了该 Socket 的错误。`main.js` 已有的 HTTP Server 错误监听不能代替 Socket 自身的监听。修复位于 `src/hub.js` 的 `upgrade()` 入口，只处理这一连接层的错误，没有添加全局异常吞掉逻辑。

单凭用户给出的堆栈无法确定是哪一个客户端或中间节点发起重置。本次已使用实际 TCP RST 在本地复现相同崩溃，足以验证并修复上述缺漏；不据此推断原先对端的身份。

## 证据、发现与路径

授权和边界见 [scope.md](facepunch-1.0.6/scope.md)。测试全部使用回环地址、模拟数据或空账号目录。

| Evidence | source_ref | repro_command / 结果 | content_hash（SHA256） |
|---|---|---|---|
| E1 | work/repro-upgrade-reset-before-1.0.6.txt | 同一回环重置脚本在旧版退出 1，出现用户相同的未处理错误 | `2fe7e772957dd5bb5ea06c84d9dba418255da57ab193e75285c9dc0749d5e7e9` |
| E2 | work/repro-upgrade-reset-after-1.0.6.txt | 修复后同脚本退出 0，健康接口 200 | `04e8b4ebc231a118395a3698520b292ef9e28df8a8e62b03f6cc24f9e05863a4` |
| E3 | work/tests-1.0.6.txt | `node --test --test-reporter=spec`：54 通过，0 失败 | `24d36dd4f9a9f7eedd121bd2f8bc6bfd908c7db4ea955f7bac2991da6de9cbb2` |
| E4 | work/smoke-1.0.6.json | 启动真实 main，连续两次拒绝升级并重置，接口可用且正常退出 | `05ab242de8dbf913b6e247cbfe3cee3e2b107a70332ee6c014694f6c190519b9` |

F1：severity=n/a（稳定性缺陷）；evidence_ids=E1/E2/E3/E4；confidence=高；location=src/hub.js upgrade()；status=已修复。认证被拒后的原始 Socket 错误遗漏会把单条连接故障扩大成进程退出。

P1，path_type=callflow：TCP 接入 → 请求 WebSocket 升级 → 认证/路径/Origin 检查不通过 → 返回 401 → 对端 RST → 原始 Socket 发出 error → 旧版无监听而退出；1.0.6 关闭该连接后继续服务。关联 E1/E2、F1。

P2，path_type=solve：保留旧文件 → 旧版实际网络复现 → 安装连接级错误处理 → 新增回归测试 → 全套检查 → 空账号真实 main 重置检查 → 构建并校验发布包。关联 E1—E4、F1。

验证时间线（2026-10-31）：先记录旧版失败证据，再执行修复；随后完成同场景重放、完整测试和空账号进程验证。源码和证据哈希记录在独立交付的 `后端更新验证-1.0.6.json`。

## 验证结果

- 54 项测试全部通过，35 个 JavaScript 文件语法检查通过。
- 新回归测试覆盖缺少认证、错误路径、禁止的浏览器 Origin 三种拒绝分支，均使用真实 TCP reset；每次之后管理接口保持可用。
- 合法插件仍可建立连接并执行 ping；已认证连接重置后，插件可重连并再次执行 ping。
- 临时空账号目录启动真实 `main.js`，两次拒绝请求重置后健康和授权状态接口正常，标准错误为空，最终退出码 0；没有运行真实账号任务。
- 依赖版本未变。修改前文件在本次工作区 `work/backup-before-backend-1.0.6` 保留。

在项目目录可重新执行：

```powershell
node --test --test-reporter=spec
node scripts/check.mjs
```

## 更新正在运行的副本

1. 停止报错目录中的旧后端。
2. 解压 1.0.6 包，把包内 `adminlogger-controller` 文件夹的内容覆盖到原来能看到 `package.json`、`start.cmd` 的那层目录；不要再套一层文件夹。
3. 保留原来的 `data` 目录，其中有账号、管理密钥及地图配置。发布包没有 `data`，无需重新导入这些资料。
4. 使用原来的启动方式重新启动。依赖版本不变，原有 node_modules 可以继续使用。

发布包附带逐文件 SHA256SUMS 清单及外部 ZIP 校验文件。本修复消除了已复现的连接错误遗漏；如果更新后仍出现其他路径的错误，新的完整堆栈可用于继续定位。
