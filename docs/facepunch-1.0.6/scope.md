# 1.0.6 修复范围

- auth：用户报告 AdminLogger 后端出现未处理的 Socket read ECONNRESET；延续其更新并修复后端的请求。
- in_scope：分析已有源码和报错，在回环地址复现连接重置，修复 WebSocket 认证拒绝路径，回归测试并交付更新包。
- network_profile：仅本机回环测试和空账号启动；不使用真实 Steam 账号，不发送生产遥测请求。
- data：保留原项目 data；程序包不包含账号、密钥、日志或地图配置。
- target：直接更新原 D 盘项目；用户日志中的 Desktop/demo 运行副本在当前环境不存在，交付更新包供覆盖该副本。
