# Facepunch 后端 1.0.5

1.0.5 更新事件生成、批次合并和重连会话逻辑。原来的遥测模拟模式继续保留；本轮验证使用真实客户端日志和本地测试接收端，没有把本地通过等同于新版生产接口已接受。

## 升级

1. 正常停止现有控制端，保存现有目录副本。
2. 用 1.0.5 包覆盖项目程序文件，保留原来的 `data`。依赖版本不变；现有插件可继续使用。
3. 若需要世界资源事件，把含 `world_prop_usage` 的原生 `output_log.txt` 拖到 `facepunch-import-world.cmd`，或执行下方导入命令。
4. 启动控制端并建立分配，用 `facepunch-status.cmd` 查看浏览、世界资源、性能和输入的状态。

```powershell
node scripts/facepunch-import-world.mjs 'E:\SteamLibrary\steamapps\common\Rust\output_log.txt'
```

导入程序合并更新 `data/facepunch-client-profile.json`，保留已有的其他配置，只提取游戏地址、地图文件名、资源数组和后续性能记录中的世界时间戳。账号、会话 GUID、票据、原始请求头及其他事件不会写入配置。控制端启动时读取这份配置，修改后需要重启。本轮当前测试服务器的地图配置已在本机项目中导入；发布包不包含 `data`，异机部署需另行复制这份配置或重新导入。

## 新行为

| 项目 | 1.0.5 行为 |
|---|---|
| `server_browser` | 每次逻辑游戏连接生成一条；过滤、搜索及六个布尔选项使用观测到的字符串格式，优先发送 |
| `world_prop_usage` | 使用匹配当前游戏地址的真实地图文件名与资源数组，排入后续游戏表批次；缺数据时显示等待地图配置 |
| 首次性能 | 约 30 秒生成；默认不附带尚无采样的地图统计组，等待游戏表窗口上传 |
| 后续性能 | 每 10 分钟生成；支持条件性的地图、背包、主菜单统计，以及修改过的设置、GC 次数和加载耗时 |
| 游戏表 | 默认每 5 分钟检查；连接事件保留，新的性能样本只替换旧性能，最多 64 条、512 KiB |
| 会话 | 临时重连保留客户端标识与运行起点；每次重新注册游戏连接更新连接标识、递增连接序号、重新计算连接时长 |
| 插件连接 | WebSocket 重连且原角色仍存在时，不重建遥测任务和游戏连接标识 |
| 显式停止 | 清理任务；再次启动创建新的模拟客户端会话，连接序号重新从 1 开始 |
| 世界时间 | `world_ts` 使用观测或插件提供的世界时间戳；未知时为 `"0"`，不再使用客户端启动时间 |
| 输入来源 | 默认保留原来的中性占位模拟；可关闭或通过 `inputSource` 接入原始打包记录，无记录时不发空事件 |

正常顺序为：任务就绪 → 浏览事件请求 → 世界资源入队 → 首次性能入队 → 下一次游戏表窗口合并发送。失败时保留待发事件和重试时间；HTTP 429 继续共同遵守 Retry-After。若浏览请求在本地数据就绪前未执行，首批会包含当时已经生成的性能事件。

`session_id`、`server_session_id` 在本实现中仍为本地生成的模拟标识。本轮真实客户端两次连接的观测支持上述生命周期区分，但没有恢复官方连接标识的分配算法。每个账号独立持有标识，多个账号不再因连接同一插件而共用 `server_session_id`。

## 可选数据配置

`browser` 可填写 `filter`、`search`、`search_tags`，以及 `show_full`、`show_empty`、`use_cache`、`prio_premium`、`prio_secure`、`prio_favourites`；六个开关接受布尔值或字符串 `"true"` / `"false"`，发送时统一保留字符串类型。

`performance` 支持 `modifiedConvars`、`hardware`、`graphicsSettings`、`application`、`gcCount`、`loadTimes`、`scenes`。普通设置值转为字符串，`loadTimes` 保留原生整数类型。配置中的加载耗时只用于每次连接的首次性能记录。`scenes` 只输出提供的统计组，支持 `map`、`inventory`、`mainmenu`；空对象会移除默认地图组。示例用于本地模拟，不代表实际渲染测量：

```json
{
  "inputMode": "none",
  "browser": { "show_empty": false },
  "performance": {
    "modifiedConvars": { "graphics.fov": "90" },
    "gcCount": 0,
    "scenes": { "inventory": { "frames": "180", "total_time": "3" } }
  }
}
```

输入适配器 `FacepunchTelemetry({ inputSource })` 可异步返回 `{ baseTicks, inputs }`，或在无新记录时返回 `null`。`baseTicks` 是 .NET ticks 十进制字符串；`inputs` 每四个有符号 int32 一组，首列为非负、单调的相对 ticks。后端校验格式后保留其余三列，不重新解释或复制其他账号的历史输入。后三列的完整业务语义仍未恢复。本轮前进操作没有产生新 `input_telemetry`，因此没有声称它按移动动作无条件触发。

## 核对

新测试覆盖浏览优先发送、世界与性能合批、连接事件重试保留、地图数据延迟到达、队列上限、条件性能字段、原始输入适配器、导入排除凭据，以及插件重连与游戏重连的会话差别。命令：

```powershell
node --test
node scripts/check.mjs
```

本地测试使用伪造票据和本地接收端，不向 Facepunch 发送测试请求。部署后的接收结果需检查当前账号日志中的 `http_request`、`http_response` 和 `ticket_cleanup`。这些结果分别反映请求、HTTP 响应和票据清理，不等同于真实游戏网络连接或公共在线人数。
