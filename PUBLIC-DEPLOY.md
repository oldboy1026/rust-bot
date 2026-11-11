# 公网服务器部署

压缩包适用于 Windows 和 Linux，包含项目源码、中文网页、插件副本、依赖锁文件和部署示例。**不包含本机账号、管理密钥、配对密钥、日志、data 或 node_modules。** 服务器首次安装时需要联网下载 npm 依赖，并使用 Node.js 22 或更新版本。

## Windows 服务器

1. 安装 Node.js 22 或更新版本，将压缩包完整解压，进入 `adminlogger-controller`。
2. 如果先通过公网 IP 测试连接，双击 `start-network.cmd`；它会监听 `0.0.0.0:3220`，首次自动安装依赖。云安全组及 Windows 防火墙需允许相应的 TCP 端口。
3. 在自己的电脑打开 `http://服务器公网IP:3220`。在服务器上读取 `data/api-key.txt`，将其中密钥填入页面解锁框。服务器本机也可双击 `open-dashboard.cmd`。
4. 正式使用推荐 HTTPS：在同机部署 Caddy，将 `deploy/Caddyfile.example` 中的域名改为自己的域名并配置 DNS。反向代理模式可以停止现有实例，改用 `start.cmd` 仅监听本机，然后由 Caddy 暴露 HTTPS。
5. HTTPS 模式访问 `https://你的域名`；对外通常只需 TCP 80/443，不必再对外开放 3220。

不要同时启动 `start.cmd` 和 `start-network.cmd`；同一个数据目录只允许一个控制端实例。端口冲突时先停止已有实例。

## Linux 服务器：先运行

安装 Node.js 22+、npm 和 unzip，将包解压到希望使用的目录。以下在解压后的项目目录运行：

```bash
node --version
npm ci --registry=https://registry.npmjs.org --no-audit --no-fund
bash start-public.sh
```

此时监听 `0.0.0.0:3220`，通过 `http://服务器公网IP:3220` 访问。管理密钥首次启动后生成在 `data/api-key.txt`。前台测试完成后按 Ctrl+C 正常停止。需要长期运行时使用下面的 systemd 配置。

为避免通过 HTTP 传输登录信息和票据，日常使用请配置 HTTPS/WSS 反向代理。HTTPS 反向代理与控制端部署在同机时，用 `bash start.sh` 的回环监听即可，不需要 `start-public.sh`。

## Linux：systemd 长期运行

下面以 Ubuntu/Debian、安装到 `/opt/adminlogger-controller` 为例。先把解压后的完整项目放在该目录；如安装位置不同，需要同步修改 service 内的路径。

```bash
# 创建独立运行用户；已存在时不必重复执行。
sudo useradd --system --user-group --home-dir /var/lib/adminlogger-controller --no-create-home --shell /usr/sbin/nologin adminlogger

cd /opt/adminlogger-controller
sudo npm ci --registry=https://registry.npmjs.org --no-audit --no-fund

# 检查 node 的真实路径；若不是 /usr/bin/node，修改 service 的 ExecStart。
command -v node

sudo install -m 0644 deploy/adminlogger-controller.service /etc/systemd/system/adminlogger-controller.service
sudo install -m 0600 deploy/controller.env.example /etc/adminlogger-controller.env
sudo systemctl daemon-reload
sudo systemctl enable --now adminlogger-controller
sudo systemctl status adminlogger-controller --no-pager
curl http://127.0.0.1:3220/health
```

`StateDirectory` 会创建独立的 `/var/lib/adminlogger-controller` 存储。此模式的管理密钥位于：

```text
/var/lib/adminlogger-controller/api-key.txt
```

由服务器管理员读取该文件后，在管理页面输入；不要把它发到公开聊天或仓库。查看服务日志、停止或重启：

```bash
sudo journalctl -u adminlogger-controller -n 80 --no-pager
sudo systemctl stop adminlogger-controller
sudo systemctl restart adminlogger-controller
```

如果先前用普通用户前台测试过，前台的项目 `data/` 与 systemd 的 `/var/lib/adminlogger-controller` 是两个不同的存储，**不会自动迁移**。建议前台只做空账号连通测试，正式账号在 systemd 页面重新添加。不要将 Windows 的 DPAPI 数据目录直接复制给 Linux。

## HTTPS 与 WebSocket

将自己的域名解析到控制端公网服务器，使用 `deploy/Caddyfile.example` 的配置：

```caddyfile
panel.example.com {
    reverse_proxy 127.0.0.1:3220
}
```

Caddy 自动处理证书和 WebSocket。需要满足域名解析和证书签发的网络条件，开放 TCP 80/443。若 Caddy 和控制端位于不同机器，需按实际内网地址修改上游及监听配置。

其他反向代理应保留 `Authorization` 和原始 `Host`，支持 WebSocket Upgrade，将根路径 `/`、`/api/` 和 `/ws` 一并转发。项目不支持部署在 `/panel` 等子路径下。

## 连接 Rust 插件

1. 在网页添加服务器，`控制端地址` 填公网可访问的控制端地址。例如 `https://panel.example.com`；临时直连测试则是 `http://控制端公网IP:3220`。
2. 上传项目 `plugin/AdminLogger.cs` 到 Rust 服务器的 `oxide/plugins/` 或 `carbon/plugins/`，确认加载成功。它是基于原始 2.5.5 的本地 2.5.6 集成修订；原始文件未修改。
3. 点击网页服务器卡片的“配对命令”，将整行命令粘贴到 **Rust 服务端控制台/RCON**，不加斜杠。HTTPS 地址会生成 `wss://.../ws`。
4. 等待网页显示已连接，再添加自己的 Steam 账号、输入需要的验证码并创建分配。
5. 停止机器人或服务时使用页面按钮或正常进程停止，给远程实体清理和票据取消留出时间。

这里填的是**控制端的地址**，不是游戏端口、RCON 端口或查询端口。公网服务器上的 `127.0.0.1` 不代表你当前的个人电脑。

## 从 1.0.0 升级到 1.0.1

1. 正常停止正在运行的控制端，备份原有 `data/`（systemd 模式是配置指定的数据目录）。
2. 用新版压缩包中的项目文件覆盖旧项目，保留原有数据目录和部署环境配置。不要用空数据目录替换已有账号数据。
3. 在同一台服务器上按原方式启动控制端，并刷新管理页面。

新版创建单个或批量分配时不再显示 IP 输入框，自动为每条记录生成不同的中国大陆网段公网格式 IPv4。旧记录的空地址或 `0.0.0.0` 会在启动时自动补齐，重新创建插件实体时使用新地址，无需删除账号或重新添加分配。地址持久化保存，重连和换票保持不变。原本手动填写的非空、非 `0.0.0.0` 地址保留。

这次只修改控制端，已部署的 2.5.6 集成版插件无需重新上传。随机地址仅用于插件展示，不是代理出口或真实客户端来源。

## 升级到 1.0.2：公共在线人数

按上述停止、备份数据、覆盖项目文件、重新启动的方式升级，刷新网页后，每张服务器卡片会显示“公共在线人数”。页面解锁且可见时每 3 秒查询一次，多台服务器共享同一次 Facepunch 接口请求。

如果显示“待配置”，打开服务器卡片的“设置”，填写游戏公网 IPv4 和游戏端口。例如当前目标填写 `61.147.247.25`、`40176`，不要填写查询端口或 RCON 端口。可留空使用插件上报/直连来源自动识别；反向代理或 NAT 映射下建议核对卡片显示的查询地址。

“未收录”表示该次响应没有服务器条目，人数未知；“0 人”表示接口明确返回零；“查询失败”时旧人数标记为过期。界面同时显示查询时间和接口数据时间，Facepunch 的数据更新可能晚于页面查询。此次升级无需更新 C# 插件。

## 压缩包校验

包内的 `SHA256SUMS.txt` 列出打包文件的 SHA256（不包含清单自身）。Linux 解压后在项目目录执行：

```bash
sha256sum -c SHA256SUMS.txt
```

Windows 可对整个 zip 执行 `Get-FileHash -Algorithm SHA256`，与压缩包旁的 `.sha256` 文件对照。所有密钥由新服务器首次启动生成。

## 已验证和待验证

控制端已完成本地 HTTP/WebSocket 协议、合成 Steam 票据生命周期、22 项自动测试和浏览器操作检查；包含随机中国 IPv4、旧占位地址迁移、持久化、注册协议、公共人数解析和共享请求检查。打包脚本会排除本机私密文件。本次改动尚未部署到目标公网服务器，也未在目标 Rust 环境编译加载 C# 副本。这些结果不能视为 EAC 或 Facepunch 公共人数已通过。

完整功能与 API 见 `README.md`，项目内验证记录见 `docs/VERIFICATION.md`。
