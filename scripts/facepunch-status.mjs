import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.CONTROLLER_DATA_DIR || join(root, 'data'));
const port = Number(process.env.PORT || 3220);
try {
  const key = readFileSync(join(data, 'api-key.txt'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('http');
  const state = await response.json();
  const statuses = { waiting_role: '等待服务器与角色信息', scheduled: '已启动，等待上传周期',
    waiting_context: '等待有效的游戏地址或角色信息', sending: '正在申请票据或上传',
    accepted: '最近一批收到 HTTP 成功响应', cleanup_error: '上传完成，票据清理异常',
    partial_error: '部分上传失败，请查看各类结果及日志',
    error: '最近一批失败，等待重试', stopped: '已停止' };
  if (!state.assignments.length) console.log('当前没有账号分配，请先在管理页面创建分配。');
  for (let index = 0; index < state.assignments.length; index++) {
    const assignment = state.assignments[index];
    const s = assignment.facepunch || { status: 'waiting_role' };
    console.log(`\n角色 ${index + 1}：${assignment.displayName}`);
    console.log(`上传状态：${statuses[s.status] || s.status}`);
    console.log(`本次任务启动：${s.startedAt ?? '尚未启动'}；运行 ${Math.floor((s.uptimeMs || 0) / 1000)} 秒`);
    console.log(`数据来源：模拟客户端事件；本次连接序号：${s.connectionIndex ?? '-'}；成功批数：${s.sentBatches ?? 0}`);
    if (s.lifecycle) {
      console.log(`连接事件：浏览 ${s.lifecycle.browserQueued ? '已生成' : '等待生成'}；世界资源 ${s.lifecycle.worldQueued ? '已生成' : '等待数据'}`);
      if (s.lifecycle.worldMetadataMissing) console.log('  等待插件自动同步地图资料；请确认服务端已更新 AdminLogger 2.5.8 或更新版本，插件会自动重试，无需手工配置。');
    }
    console.log(`最近类型：${s.lastTable ?? '尚未发送'}；HTTP：${s.lastHttpStatus ?? '暂无响应'}`);
    for (const [type, table] of Object.entries(s.tables || {})) {
      console.log(`${type}：成功 ${table.sentBatches} 批；最近 HTTP ${table.lastHttpStatus ?? '暂无'}；最近成功 ${table.lastSuccessAt ?? '暂无'}`);
      console.log(`  下次事件生成：${table.nextEventAt ?? '暂无'}；预计发送/重试：${table.nextAttemptAt ?? '暂无'}；等待事件 ${table.pendingEvents ?? 0} 条`);
      if (table.pendingEventTypes?.length) console.log(`  待发事件：${table.pendingEventTypes.join(', ')}`);
      if (table.error) console.log(`  ${table.error}`);
    }
    console.log(`最近尝试：${s.lastAttemptAt ?? '尚未尝试'}；最近成功：${s.lastSuccessAt ?? '尚未成功'}`);
    console.log(`最近请求编号：${s.lastRequestId ?? '尚未发送'}`);
    console.log(`下次计划：${s.nextAttemptAt ?? '暂无'}`);
    console.log(`Steam 确认：${s.steamAcknowledged === true ? '已收到' : s.steamAcknowledged === false ? '未在时限内收到' : '尚未申请'}；票据清理确认：${s.cleanupAcknowledged === true ? '已收到' : s.cleanupAcknowledged === false ? '未收到' : '暂无'}`);
    if (s.error) console.log(`失败原因：${s.error}`);
    console.log(`详细日志：${s.logFile ?? '任务尚未建立日志文件'}`);
    if (s.logError) console.log(`日志错误：${s.logError}`);
  }
  console.log('\n时间使用 UTC；HTTP 成功只表示请求被接受，不证明维持在线或公共人数变化。');
} catch {
  console.error('读取失败。请确认控制端已启动，并使用相同的 PORT 和 CONTROLLER_DATA_DIR。');
  process.exitCode = 1;
}
