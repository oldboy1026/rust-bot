# 采样与验证时间线

以下采样时间均为 UTC；北京时间加 8 小时。

| 时间 | 记录 | 证据 |
|---|---|---|
| 2026-10-31 14:25:58 | 用户确认主菜单就绪，记录日志起点，analytics.log=True | baseline.json |
| 14:26:50 / 14:26:54 | 首次浏览与世界资源事件 | 02-inserver.log |
| 14:27:22 | 首次性能事件，server_index=1，connected_time 约 30 秒 | 02-inserver.log |
| 首次入服后、重连前 | 独立前进及静止采样，没有新增 input_telemetry | 03-waiting-input.json、04-forward.json |
| 14:35:16 / 14:35:21 | 断开后重连的浏览与世界资源事件 | 05-reconnected.log |
| 14:35:46 | 重连性能事件，客户端会话保留、连接标识更新、server_index=2 | 05-reconnected.log |
| 14:37:21 | 客户端输出 analytics.log=False；用户随后确认关闭 | 06-logging-disabled.log |
| 采样完成后 | 完整测试 53/53、35 个 JavaScript 文件语法检查、空账号启动及退出检查通过 | tests-1.0.5.txt、smoke-1.0.5.json |

私有日志和原始验证记录保存在本机工作区 work；交付报告只引用哈希和聚合结果。
