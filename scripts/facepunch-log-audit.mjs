import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { auditLogs } from '../src/diagnostics/log-audit.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.CONTROLLER_DATA_DIR || join(root, 'data'));
const usage = '用法：node scripts/facepunch-log-audit.mjs [日志文件或目录] [--native 客户端日志路径] [--output 报告路径] [--json]';

async function save(path, report) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

try {
  const args = process.argv.slice(2);
  let input, nativePath, output, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(usage); process.exit(0); }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--native' || arg === '--output') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('arguments');
      if (arg === '--native') nativePath = resolve(value);
      else output = resolve(value);
    } else if (arg.startsWith('-') || input) throw new Error('arguments');
    else input = resolve(arg);
  }
  input ||= join(data, 'logs', 'facepunch');
  output ||= join(data, 'diagnostics', 'facepunch-log-audit.json');
  // Never replace a source file, even if an output path is supplied explicitly.
  if (output.toLowerCase() === resolve(input).toLowerCase()
    || (nativePath && output.toLowerCase() === nativePath.toLowerCase())
    || /\.(?:jsonl|log|txt)$/i.test(output)) throw new Error('output');
  const report = await auditLogs(input, { nativePath });
  await save(output, report);
  if (json) console.log(JSON.stringify({ ...report, reportFile: output }, null, 2));
  else {
    console.log(`本地日志核对完成：${report.summary.accounts} 个账号目录，${report.summary.files} 个文件。`);
    console.log(`请求 ${report.summary.requests} 次；日志中的 HTTP 2xx 响应 ${report.summary.httpAccepted} 次。`);
    for (let i = 0; i < report.accounts.length; i++) {
      const a = report.accounts[i];
      console.log(`\n账号目录 ${i + 1}：${a.directory}`);
      console.log(`日志问题：无效行 ${a.malformedLines}；未完整写入的末行 ${a.incompleteTailLines}；过长行 ${a.oversizedLines}；重复记录 ${a.duplicateRecords}。`);
      if (a.requestLimitReached) console.log('已达到关联数量上限，后续记录未计入请求统计。');
      if (a.uncorrelatedRecords) console.log(`缺少可用请求编号：${a.uncorrelatedRecords} 条，无法完整关联。`);
      for (const [name, t] of Object.entries(a.tables)) {
        console.log(`${name}：请求 ${t.requests}；响应 ${t.responses}；HTTP 2xx ${t.httpAccepted}；无响应记录 ${t.withoutResponse}。`);
        console.log(`  正文：完整记录 ${t.fullBodies}；哈希通过 ${t.jsonHashVerified}；哈希不匹配 ${t.jsonHashMismatch}；无法核验 ${t.jsonHashUnavailable}。`);
        console.log(`  接收前失败 ${t.failuresBeforeAcceptance}；接收后清理失败 ${t.cleanupFailuresAfterAcceptance}；清理未确认 ${t.cleanupUnconfirmed}；未记录清理结果 ${t.cleanupNotObserved}。`);
        for (const [type, e] of Object.entries(t.eventTypes)) {
          console.log(`  ${type}：${e.events} 条；Data 字段 ${e.dataFields.min}–${e.dataFields.max}；单事件 JSON ${e.eventBytes.min}–${e.eventBytes.max} 字节。`);
        }
      }
    }
    if (report.native) {
      console.log('\n原生客户端日志（支持逗号开头的后续追加事件）：');
      for (const [type, e] of Object.entries(report.native.eventTypes)) {
        console.log(`${type}：${e.events} 条；Data 字段 ${e.dataFields.min}–${e.dataFields.max}；单事件 JSON ${e.eventBytes.min}–${e.eventBytes.max} 字节。`);
      }
      console.log(`无法解析的追加行 ${report.native.malformedAppends}；过长行 ${report.native.oversizedLines}。`);
    }
    if (report.comparison) {
      console.log('\n事件覆盖对照（汇总样本，非会话级关联）：');
      for (const item of report.comparison.eventTypes) {
        const native = item.native, backend = item.backend;
        console.log(`${item.type} [${item.presence}]：原生日志 ${native.events} 条 / ${native.dataFields.min ?? '-'}–${native.dataFields.max ?? '-'} 字段 / ${native.eventBytes.min ?? '-'}–${native.eventBytes.max ?? '-'} 字节；后端请求 ${backend.events} 条 / ${backend.dataFields.min ?? '-'}–${backend.dataFields.max ?? '-'} 字段 / ${backend.eventBytes.min ?? '-'}–${backend.eventBytes.max ?? '-'} 字节。`);
      }
      console.log(report.comparison.note);
    }
    if (!report.summary.files) console.log('没有找到 events.jsonl 或轮换文件，请指定正确的日志文件/目录。');
    console.log(`\n摘要报告：${output}`);
    console.log('仅核对本地文件；不会登录 Steam 或发送 HTTP 请求。HTTP 2xx 不证明游戏连接或公共人数变化。');
  }
} catch (error) {
  const messages = { ENOENT: '找不到日志路径，请检查参数或 CONTROLLER_DATA_DIR。',
    EACCES: '无法读取日志或写入报告，请检查目录权限。', EPERM: '文件访问被拒绝，请检查目录权限或占用。' };
  console.error(messages[error.code] || '核对未完成，请检查参数、日志路径及报告目录。');
  console.error(usage);
  process.exitCode = 1;
}
