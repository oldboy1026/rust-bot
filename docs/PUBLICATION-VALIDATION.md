# Public repository validation / 公开仓库验证

Date / 日期：2026-11-11. Controller / 控制端：1.0.12. Plugin / 插件：2.5.9.

## 中文

发布内容包含控制端、插件、前端、测试、启动/部署脚本及研究文档。保留目标仓库的原始 Apache 2.0 许可证和提交历史，以及源码的 NOTICE。历史 ZIP 的 SHA256SUMS.txt 没有沿用到已经更新的仓库；scripts/build-release.ps1 会为每次新发行包重新生成逐文件清单。

公开配置中的应用密钥为空，遥测支持从 FACEPUNCH_API_KEY 读取。未配置时，在申请上传专用票据或发送 HTTP 请求之前报告配置错误。模拟上传测试显式使用测试密钥，不依赖真实运行配置。对发布文件检查，未发现原本地应用密钥；data、node_modules、运行日志、环境配置和抓包不纳入版本控制。

验证结果：

- `node --test`：80 项，79 通过，0 失败，1 跳过。跳过项是需要 .NET SDK 8+ 的可选插件地图 helper 检查。
- `node scripts/check.mjs`：42 个 JavaScript 文件语法检查通过。
- `node scripts/browser-smoke.mjs`：启动、配对、WebSocket、公共人数/诊断、服务器一键停止、选中/全部退出、删除、对话框、手机布局及锁定验证通过。
- 新增缺少应用密钥的测试：确认不会申请上传票据或发送 HTTP 请求，并显示明确错误。

验证使用 Node.js 24.22.1、本机浏览器、临时数据、模拟 Steam/插件和本地 HTTP 接收端。没有以真实账号登录 Steam 或操作生产服务器。不将测试通过解释为已经修复 AuthTicketCanceled 的外部来源或 Facepunch 的公共计数行为。

正常客户端、Steam、Rust 服务器与 Facepunch 的联合研究步骤见 [研究计划](CLIENT-STEAM-FACEPUNCH-RESEARCH.md)。如果修复成功，请按 README 的中英文反馈清单解释根因、思路与复测证据，并联系 oldboy1026@gmail.com。

## English

The publication includes the controller, plugin, dashboard, tests, startup/deployment scripts and research documents. It preserves the destination repository's Apache 2.0 license/history and the source NOTICE. The historical ZIP manifest is not reused for modified repository contents; scripts/build-release.ps1 generates a fresh per-file manifest for each new archive.

The public application-key configuration is empty. Telemetry reads FACEPUNCH_API_KEY and reports missing configuration before requesting an upload ticket or sending HTTP. Mock-upload tests explicitly supply synthetic keys. The publication scan found no copy of the original local application key. Account data, node_modules, runtime logs, environment settings and captures are excluded from version control.

Results:

- `node --test`: 80 tests, 79 passed, 0 failed, 1 skipped. The skipped optional plugin map-helper check requires .NET SDK 8+.
- `node scripts/check.mjs`: syntax checks passed for 42 JavaScript files.
- `node scripts/browser-smoke.mjs`: startup, pairing, WebSocket, public-count diagnostics, server stop, selected/all-account logout, deletion, dialogs, mobile layout and locking passed.
- The new missing-key test verifies a clear error with no upload-ticket request or HTTP call.

Validation used Node.js 24.22.1, a local browser, temporary data, simulated Steam/plugin behavior and local HTTP receivers. No real Steam login or production-server operation was performed. Passing these checks does not prove that the external source of AuthTicketCanceled or Facepunch population behavior has been fixed.

See the [research plan, Chinese](CLIENT-STEAM-FACEPUNCH-RESEARCH.md) for the normal-client/Steam/Rust-server/Facepunch investigation. If a fix succeeds, follow the bilingual README checklist to explain the cause, successful approach and repeated verification, and contact oldboy1026@gmail.com.
