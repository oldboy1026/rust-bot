# 分析范围

- auth：用户授权比较自己提供的两个项目快照，并修改“成功5个”目录里的后端与插件。
- in_scope：两份 data/logs/facepunch 的只读快照、原始 src/plugin 对比、服务端参考程序集的 PE/元数据/IL、自动地图与后端诊断更新、离线及本地空账号验证。
- modification_target：D:\桌面\adminlogger-controller成功5个\adminlogger-controller。
- read_only_target：D:\桌面\adminlogger-controller 5变成1\adminlogger-controller。
- network_profile：验证使用本地回环、合成插件和临时空账号目录；不登录用户保存账号，不向上游重放生产遥测，不改动正在运行的 Rust 客户端。
- evidence_handling：按打开时长度复制 JSONL，记录 SHA256；原始日志和保存凭据不随报告或发布包分发。
- not_verified：1.0.7 在远端实际服务器的加载与长时间运行、平台公共计数规则、完整插件在远端构建中的兼容性。
