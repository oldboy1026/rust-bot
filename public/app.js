const $ = id => document.getElementById(id);
let apiKey = sessionStorage.getItem('adminlogger-key') || '';
let snapshot = { accounts: [], servers: [], assignments: [], events: [] };
const selected = new Set();
let polling = false;
let publicCountPolling = false;
let batchLogoutRunning = false;
const stoppingServers = new Set();
const publicCounts = new Map();
let noticeTimer;
const phases = { waiting: '等待启动', waiting_server: '等待插件连接', waiting_steam: '等待 Steam 登录',
  issuing_ticket: '正在申请票据', registering: '正在创建实体', waiting_auth: '实体已创建 · 等待认证',
  authenticated: 'Steam 认证已通过', uncertain: '结果待核对', renewing: '正在更新会话',
  cleanup_pending: '等待远程清理', stopped: '已停止', error: '会话错误' };
const loginStates = { online: '在线', offline: '未登录', connecting: '正在登录', reconnecting: '重新连接',
  retry_wait: '等待自动重试', guard_required: '需要验证码', error: '登录失败' };
const eventNames = { plugin_init: '插件初始化', bot_registered: '实体已创建', bot_unregistered: '实体已移除',
  bot_killed: '机器人死亡', bot_respawned: '机器人已重生', bot_respawn_failed: '重生失败',
  steam_auth_ok: 'Steam 认证成功', steam_auth_lost: 'Steam 认证失效', auth_diagnostic: '认证操作审计', env_tick: '环境时间同步', fp_server_event: '服务器事件副本' };

function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
function button(text, action, cls = 'small') { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', () => action(node)); return node; }
function notify(message, bad = false) {
  $('notice').textContent = message; $('notice').className = `notice${bad ? ' bad' : ''}`; $('notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 12000);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, { method, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) lock(); throw new Error(result.error || '请求失败。'); }
  return result;
}
function lock() { apiKey = ''; publicCounts.clear(); sessionStorage.removeItem('adminlogger-key'); $('workspace').hidden = true; $('unlock').hidden = false; $('dialog').close(); }
async function perform(action, node) {
  if (node) node.disabled = true;
  try { await action(); await refresh(); }
  catch (error) { notify(error.message || '网络请求失败。', true); }
  finally { if (node) node.disabled = false; }
}
async function refresh() {
  if (!apiKey || polling) return;
  polling = true;
  try {
    snapshot = await api('/state');
    $('workspace').hidden = false; $('unlock').hidden = true;
    $('poll-dot').className = 'dot'; $('poll-state').textContent = `已同步 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    render();
    refreshPublicCounts();
  } catch (error) {
    $('poll-dot').className = 'dot off'; $('poll-state').textContent = '连接中断';
    if (!$('unlock').hidden) $('unlock-error').textContent = error.message;
    else notify(error.message, true);
  } finally { polling = false; }
}
function emptyTable(body, columns, message) { const row = el('tr'); const cell = el('td', 'empty', message); cell.colSpan = columns; row.append(cell); body.append(row); }
function badge(text, style = '') { return el('span', `badge ${style}`, text); }
function nameCell(name, sub) { const cell = el('td'); cell.append(el('div', 'cell-name', name)); if (sub) cell.append(el('div', 'cell-sub', sub)); return cell; }
const localTime = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const sessionEndReasons = {
  assignment_stopped: '手动停止分配', server_stopped: '服务器一键停止', assignment_disabled: '分配已停用', assignment_deleted: '删除分配', service_shutdown: '控制端关闭', account_logout: '退出 Steam 账号',
  steam_auth_lost: 'Steam 认证失效', steam_auth_timeout: '等待 Steam 最终认证超时',
  plugin_offline_timeout: '插件断线超过宽限期', plugin_register_rejected: '插件拒绝注册',
  game_ticket_aborted: 'Steam 票据会话中止',
};
function populationPanel(server) {
  const panel = el('div', 'population');
  const counts = server.population;
  if (counts?.pluginEntities == null) {
    panel.append(el('div', 'public-count-note', server.connected ? '等待插件核对角色名单。' : '插件未连接，当前角色和认证人数未知。'));
    return panel;
  }
  const grid = el('dl', 'population-grid');
  for (const [label, value] of [
    ['插件角色', counts.pluginEntities],
    ['已出现的分配', `${counts.presentAssignments} / ${counts.enabledAssignments}`],
    ['最终 Steam 认证', `${counts.steamAuthenticated} / ${counts.presentAssignments}`],
  ]) {
    const metric = el('div');
    metric.append(el('dt', '', label), el('dd', '', String(value)));
    grid.append(metric);
  }
  panel.append(grid, el('div', 'public-count-note', `角色名单核对于 ${localTime(counts.reconciledAt)} · 公共人数为全服总数`));
  if (counts.presentAssignments < counts.enabledAssignments || counts.steamAuthenticated < counts.presentAssignments) {
    panel.append(el('div', 'public-count-note',
      `未出现在角色名单：${counts.enabledAssignments - counts.presentAssignments}；名单中未确认认证：${counts.presentAssignments - counts.steamAuthenticated}。查看下方分配详情。`));
  }
  return panel;
}
async function refreshPublicCounts() {
  if (!apiKey || publicCountPolling || !snapshot.servers.length) return;
  publicCountPolling = true;
  const requestKey = apiKey;
  try {
    const result = await api('/public-player-counts');
    if (apiKey !== requestKey) return;
    publicCounts.clear();
    for (const item of result.servers) publicCounts.set(item.id, item);
  } catch {
    if (apiKey !== requestKey) return;
    for (const server of snapshot.servers) {
      const previous = publicCounts.get(server.id);
      publicCounts.set(server.id, { ...previous, status: 'error', count: null,
        lastKnownCount: previous?.status === 'ok' ? previous.count : previous?.lastKnownCount });
    }
  } finally {
    publicCountPolling = false;
    if (apiKey) renderServers();
  }
}
function publicCountPanel(server) {
  const item = publicCounts.get(server.id);
  const panel = el('div', `public-count ${item?.status || 'loading'}`);
  panel.dataset.serverId = server.id;
  const headline = el('div', 'public-count-heading');
  const value = item?.status === 'ok' ? `${item.count} 人`
    : ({ not_listed: '未收录', error: '查询失败', waiting_address: '待配置' }[item?.status] || '查询中…');
  headline.append(el('span', '', '公共在线人数'), el('strong', '', value));
  panel.append(headline);
  if (item?.endpoint) panel.append(el('div', 'mono', item.endpoint));
  if (item?.status === 'waiting_address') panel.append(el('div', 'public-count-note', '在“设置”中填写游戏公网 IP 和游戏端口，或等待插件上报。'));
  if (item?.status === 'not_listed') panel.append(el('div', 'public-count-note', '本次公共列表没有该服务器条目，人数未知。'));
  if (item?.status === 'error') {
    const previous = Number.isSafeInteger(item.lastKnownCount) ? `上次成功：${item.lastKnownCount} 人（已过期）。` : '';
    panel.append(el('div', 'public-count-note', `${previous}稍后自动重试。`));
  }
  const times = ['每 3 秒查询'];
  if (item?.checkedAt) times.push(`最近查询 ${new Date(item.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}`);
  panel.append(el('div', 'public-count-note', times.join(' · ')));
  if (item?.sourceUpdatedAt) panel.append(el('div', 'public-count-note', `接口数据时间 ${new Date(item.sourceUpdatedAt).toLocaleString('zh-CN', { hour12: false })}`));
  if (item?.cacheAge != null && item.status === 'ok') panel.append(el('div', 'public-count-note', `上游报告缓存年龄 ${item.cacheAge} 秒`));
  if (server.info?.query_port) panel.append(el('div', 'public-count-note', `插件报告的 UDP 查询端口：${server.info.query_port}`));
  return panel;
}
function diagnosticPanel(server) {
  const panel = el('div', 'meta'), capture = server.diagnostics;
  const result = capture?.latest?.a2s;
  const count = result?.status === 'ok' ? `${result.players} 人（Bots 字段 ${result.bots}）`
    : result?.status === 'waiting_address' ? '待配置公网 IP / UDP 查询端口'
      : result?.status === 'error' ? `查询失败（${result.code}）` : '等待采样';
  panel.append(el('div', '', `人数诊断：${capture?.enabled ? '后台采集中，每 10 秒记录' : '未开启'} · A2S ${count}`));
  if (result?.sampledAt) panel.append(el('div', '', `A2S 采样 ${localTime(result.sampledAt)}`));
  if (capture?.logError) panel.append(el('div', 'bad', capture.logError));
  return panel;
}
function renderServers() {
  const servers = snapshot.servers;
  $('server-list').replaceChildren();
  if (!servers.length) $('server-list').append(el('div', 'empty', '还没有服务器。先添加一台服务器并执行配对命令。'));
  for (const server of servers) {
    const card = el('article', 'server-card'), title = el('div', 'card-title');
    title.append(el('h3', '', server.name), badge(server.connected ? '已连接' : '等待连接', server.connected ? 'good' : 'wait'));
    const info = server.info || {};
    const meta = el('div', 'meta', server.connected ? `${info.hostname || 'Rust server'} · ${info.map || '地图未知'}\n协议 ${info.protocol || '未知'}` : '执行配对命令后，这里会显示插件连接状态。');
    meta.style.whiteSpace = 'pre-line';
    if (server.connected) {
      const mapStatus = info.world_metadata_status === 'ready' && Array.isArray(info.required_props)
        ? '地图资料已自动同步'
        : info.world_metadata_status === 'unavailable'
          ? '地图资料暂未读取成功，插件会自动重试'
          : info.world_metadata_status ? '等待插件自动同步地图资料' : '自动同步地图资料需要更新服务端插件';
      meta.append(document.createTextNode(`\n${mapStatus}`));
    }
    const actions = el('div', 'actions');
    actions.append(button('配对命令', node => perform(() => showPair(server), node)),
      button('核对状态', node => perform(() => api(`/servers/${server.id}/sync`, 'POST', {}), node)),
      button('设置', () => serverForm(server)));
    actions.append(button(server.diagnostics?.enabled ? '停止人数诊断' : '开启人数诊断', node => perform(async () => {
      const enabled = !server.diagnostics?.enabled;
      await api(`/servers/${server.id}/diagnostics`, 'POST', { enabled });
      notify(enabled ? '后台采集已开启，关闭网页仍会继续；请持续运行至少 30 分钟。' : '人数诊断已停止，已采集日志会保留。');
    }, node)));
    const active = snapshot.assignments.filter(item => item.serverId === server.id
      && (item.enabled || item.ticketActive || item.needsCleanup));
    const stop = button(stoppingServers.has(server.id) ? '正在停止…' : `一键停止（${active.length}）`,
      () => stopServer(server), 'small danger');
    stop.dataset.action = 'stop-server';
    stop.disabled = !active.length || stoppingServers.has(server.id);
    stop.title = '停止本服务器的全部机器人会话，保留分配记录和 Steam 登录。';
    actions.append(stop);
    const assigned = snapshot.assignments.filter(item => item.serverId === server.id && !item.deletePending).length;
    if (assigned) {
      const removal = button(`删除全部分配（${assigned}）`, node => {
        if (confirm(`停止并删除「${server.name}」的全部机器人分配？Steam 账号会保留。`)) {
          perform(() => deleteAssignments(`/servers/${server.id}/assignments`), node);
        }
      }, 'small danger');
      actions.append(removal);
    }
    actions.classList.add('wrap-actions');
    card.append(title, el('div', 'url', server.publicUrl), meta, populationPanel(server), publicCountPanel(server), diagnosticPanel(server), actions); $('server-list').append(card);
  }
}
function render() {
  const { accounts, servers, assignments, events } = snapshot;
  for (const id of selected) if (!accounts.some(account => account.id === id)) selected.delete(id);
  $('metric-online').textContent = accounts.filter(account => account.state === 'online').length;
  $('metric-total').textContent = `共 ${accounts.length} 个账号`;
  $('metric-servers').textContent = servers.filter(server => server.connected).length;
  $('metric-leases').textContent = assignments.filter(item => item.ticketActive).length;
  $('metric-auth').textContent = assignments.filter(item => item.steamAuthenticated).length;
  renderServers();
  $('account-list').replaceChildren();
  if (!accounts.length) emptyTable($('account-list'), 5, '尚未添加 Steam 账号。');
  for (const account of accounts) {
    const row = el('tr'), checkCell = el('td'), check = el('input'); check.type = 'checkbox'; check.checked = selected.has(account.id); check.setAttribute('aria-label', `选择 ${account.accountName}`);
    check.addEventListener('change', () => { if (check.checked) selected.add(account.id); else selected.delete(account.id); updateSelection(); }); checkCell.append(check);
    const stateCell = el('td'); stateCell.append(badge(account.loggingOut ? '正在退出' : loginStates[account.state] || account.state,
      account.state === 'online' && !account.loggingOut ? 'good' : account.state === 'error' ? 'bad' : 'wait'));
    if (account.retryAt && !account.loggingOut) stateCell.append(el('div', 'cell-sub', `预计 ${localTime(account.retryAt)} 重试`));
    const actions = el('td'), bar = el('div', 'actions');
    if (!account.loggingOut && !batchLogoutRunning) {
      if (account.state === 'guard_required') bar.append(button('输入验证码', () => guardForm(account)));
      if (!['online', 'connecting', 'guard_required', 'reconnecting', 'retry_wait'].includes(account.state)) {
        bar.append(button('登录', node => account.hasSavedLogin
          ? perform(() => api(`/accounts/${account.id}/login`, 'POST', {}), node) : accountForm(account)));
        if (account.state === 'error' && account.hasSavedLogin) bar.append(button('用密码登录', () => accountForm(account)));
      } else bar.append(button('退出', node => perform(() => api(`/accounts/${account.id}/logout`, 'POST', {}), node)));
      bar.append(button('删除', node => { if (confirm(`删除账号 ${account.accountName}？关联会话会先停止。`)) perform(() => api(`/accounts/${account.id}`, 'DELETE', {}), node); }, 'small danger'));
    }
    actions.append(bar);
    const steamCell = el('td', 'mono', account.steamId || '—');
    row.append(checkCell, nameCell(account.accountName, account.lastError?.message || account.nickname), steamCell, stateCell, actions); $('account-list').append(row);
  }
  updateSelection();
  $('assignment-list').replaceChildren();
  if (!assignments.length) emptyTable($('assignment-list'), 5, '登录 Steam、连接插件后，即可分配机器人会话。');
  for (const item of assignments) {
    const row = el('tr'), stateCell = el('td');
    stateCell.append(badge(item.deletePending ? '删除中 · 等待清理' : phases[item.phase] || item.phase,
      item.phase === 'authenticated' && !item.deletePending ? 'good' : item.phase === 'error' ? 'bad' : 'wait'));
    if (item.error) stateCell.append(el('div', 'cell-sub', item.error));
    if (item.retryAt) stateCell.append(el('div', 'cell-sub', `下次自动尝试 ${localTime(item.retryAt)}`));
    const credential = el('td'); credential.append(el('div', '', item.ticketActive ? '票据保持中' : '无活动票据'),
      el('div', 'cell-sub', item.steamAuthenticated ? `已收到成功回调${item.steamAuthenticatedAt ? ` · ${localTime(item.steamAuthenticatedAt)}` : ''}` : '未确认认证成功'));
    if (item.lastSessionEnd) {
      const { reason, authResponse, at } = item.lastSessionEnd;
      const description = sessionEndReasons[reason] || '会话已结束';
      credential.append(el('div', 'cell-sub', `上次结束 ${localTime(at)}：${description}${authResponse ? `（${authResponse}）` : ''}`));
    }
    const actions = el('td'), bar = el('div', 'actions');
    if (!item.deletePending && !batchLogoutRunning) bar.append(button(item.enabled ? '停止' : '启动', node => perform(() => api(`/assignments/${item.id}/${item.enabled ? 'stop' : 'start'}`, 'POST', {}), node)),
      button('删除', node => { if (confirm('停止并删除这条分配记录？')) perform(() => deleteAssignments(`/assignments/${item.id}`), node); }, 'small danger'));
    actions.append(bar);
    row.append(nameCell(accounts.find(account => account.id === item.accountId)?.accountName || '账号已移除', item.displayName),
      el('td', '', servers.find(server => server.id === item.serverId)?.name || '未知'), stateCell, credential, actions); $('assignment-list').append(row);
  }
  $('event-list').replaceChildren();
  if (!events.length) $('event-list').append(el('div', 'empty', '等待插件发送事件。'));
  for (const event of events) {
    const row = el('div', 'event-row');
    row.append(el('span', 'mono', new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false })),
      el('span', 'event-name', eventNames[event.event] || event.event),
      el('span', '', servers.find(server => server.id === event.serverId)?.name || '—'), el('span', 'mono', event.steamId === '0' ? '服务器事件' : event.steamId)); $('event-list').append(row);
  }
}
function updateSelection() {
  $('selected-count').textContent = `已选 ${selected.size} 个`;
  $('select-all').checked = snapshot.accounts.length > 0 && selected.size === snapshot.accounts.length;
  $('selected-logout').disabled = !selected.size || batchLogoutRunning;
  $('logout-all').disabled = !snapshot.accounts.some(account => !account.loggingOut) || batchLogoutRunning;
  $('logout-all').textContent = batchLogoutRunning ? '正在退出…' : '一键退出全部';
  $('selected-login').disabled = batchLogoutRunning;
  $('selected-assign').disabled = batchLogoutRunning;
  $('add-assignment').disabled = batchLogoutRunning;
  $('add-account').disabled = batchLogoutRunning;
  $('import-accounts').disabled = batchLogoutRunning;
}
async function stopServer(server) {
  if (stoppingServers.has(server.id)) return;
  stoppingServers.add(server.id);
  renderServers();
  try {
    const { stopped, pending } = await api(`/servers/${server.id}/stop`, 'POST', {});
    notify(pending ? `已停用 ${stopped} 条分配；其中 ${pending} 条等待插件恢复后清理。`
      : `已停止 ${stopped} 条会话，分配记录和 Steam 登录已保留。`);
  } catch (error) { notify(error.message || '停止失败，请核对会话状态。', true); }
  finally { stoppingServers.delete(server.id); await refresh(); renderServers(); }
}
async function logoutAccounts(ids) {
  if (!ids.length || batchLogoutRunning) return;
  batchLogoutRunning = true;
  render();
  const results = [];
  try {
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const batch = await api('/accounts/batch-logout', 'POST', { ids: ids.slice(offset, offset + 1000) });
      results.push(...batch.results);
    }
    const failed = results.filter(item => !item.ok);
    notify(`已退出 ${results.length - failed.length} 个账号${failed.length ? `；未完成：${failed.map(item => snapshot.accounts.find(account => account.id === item.id)?.accountName || item.id).join('、')}` : ''}。`, failed.length > 0);
  } catch (error) {
    const completed = results.filter(item => item.ok).length;
    notify(`${completed ? `已确认退出 ${completed} 个账号；` : ''}${error.message || '请求中断，请核对账号状态。'}`, true);
  } finally { batchLogoutRunning = false; await refresh(); render(); }
}
async function deleteAssignments(path) {
  const { deleted, pending } = await api(path, 'DELETE', {});
  notify(pending ? `已删除 ${deleted} 条；另有 ${pending} 条会在确认远程清理后自动删除。` : `已停止并删除 ${deleted} 条分配。`);
}
function dialog(title, content) { $('dialog-title').textContent = title; $('dialog-content').replaceChildren(content); if (!$('dialog').open) $('dialog').showModal(); }
function field(text, type = 'text', value = '') { const label = el('label', '', text), input = el('input'); input.type = type; input.value = value; input.required = true; input.autocomplete = 'off'; label.append(input); return { label, input }; }
function formDialog(title, fields, submitText, action, note) {
  const form = el('form'); for (const item of fields) form.append(item.label || item);
  if (note) form.append(el('div', 'dialog-note', note));
  const error = el('div', 'dialog-error'), submit = el('button', 'primary', submitText); submit.type = 'submit'; form.append(error, submit);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; error.textContent = '';
    try { await action(); $('dialog').close(); await refresh(); }
    catch (problem) { error.textContent = problem.message || '操作失败。'; }
    finally { submit.disabled = false; }
  }); dialog(title, form);
}
function serverForm(server) {
  const name = field('服务器名称', 'text', server?.name || 'Rust 服务器');
  const url = field('服务器可访问的控制端地址', 'url', server?.publicUrl || location.origin);
  const gameIp = field('游戏服务器公网 IPv4（可留空自动识别）', 'text', server?.gameIp || ''); gameIp.input.required = false;
  const gamePort = field('游戏端口（可留空使用插件上报值）', 'number', server?.gamePort || ''); gamePort.input.required = false;
  const queryPort = field('UDP 查询端口（人数诊断用，留空使用插件上报值）', 'number', server?.queryPort || ''); queryPort.input.required = false;
  queryPort.input.name = 'queryPort'; queryPort.input.min = '1'; queryPort.input.max = '65535'; queryPort.input.step = '1';
  gameIp.input.name = 'gameIp'; gamePort.input.name = 'gamePort';
  gamePort.input.min = '1'; gamePort.input.max = '65535'; gamePort.input.step = '1';
  formDialog(server ? '服务器设置' : '添加服务器', [name, url, gameIp, gamePort, queryPort], '保存', async () => {
    const body = { name: name.input.value, publicUrl: url.input.value, gameIp: gameIp.input.value, gamePort: gamePort.input.value, queryPort: queryPort.input.value };
    if (server) await api(`/servers/${server.id}`, 'PATCH', body);
    else { const result = await api('/servers', 'POST', body); notify('服务器已添加，请点击“配对命令”完成连接。'); return result; }
  }, '公共人数按游戏公网 IP 和游戏端口查询，请勿填写查询或 RCON 端口。控制端地址须能被插件访问；修改控制端地址后需重新配对。');
  if (server) $('dialog-content').append(button('删除服务器', node => { if (confirm('删除此服务器？需先删除关联分配记录。')) perform(async () => { await api(`/servers/${server.id}`, 'DELETE', {}); $('dialog').close(); }, node); }, 'quiet danger'));
}
async function showPair(server) {
  const result = await api(`/servers/${server.id}/pair`), box = el('div'), text = el('textarea', 'command');
  text.readOnly = true; text.value = result.command;
  box.append(el('p', 'dialog-note', '在目标 Rust 服务器的管理员控制台或 RCON 执行下面这条命令，然后等待“已连接”。这条命令包含服务器配对密钥。'), text,
    button('复制命令', async node => { try { await navigator.clipboard.writeText(result.command); node.textContent = '已复制'; } catch { text.select(); node.textContent = '请按 Ctrl+C 复制'; } }, 'primary'));
  dialog(`配对 · ${server.name}`, box);
}
function accountForm(account) {
  const name = field('Steam 登录账号名', 'text', account?.accountName || ''), password = field('Steam 密码', 'password');
  formDialog('添加并登录 Steam', [name, password], '登录', async () => {
    const value = password.input.value; password.input.value = '';
    await api('/accounts', 'POST', { id: account?.id, accountName: name.input.value, password: value });
  }, '临时登录失败时会自动重试。密码只在本次登录期间留在内存，不写入账号存储。需要 Steam Guard 时，请在账号列表完成验证。');
}
function guardForm(account) {
  const code = field(account.guard?.type === 'email' ? '邮件验证码' : '手机令牌验证码'); code.input.maxLength = 5;
  formDialog(`验证 · ${account.accountName}`, [code], '提交验证码', async () => { const value = code.input.value; code.input.value = ''; await api(`/accounts/${account.id}/guard`, 'POST', { code: value }); });
}
function importForm() {
  const label = el('label', '', '每行 账号:密码（最多 100 行）'), input = el('textarea'); input.required = true; input.spellcheck = false; label.append(input);
  formDialog('批量导入账号', [label], '导入并登录', async () => {
    const text = input.value; input.value = '';
    const result = await api('/accounts/import', 'POST', { text });
    const failed = result.results.filter(item => !item.ok);
    notify(`已受理 ${result.results.length - failed.length} 个账号${failed.length ? `；失败行：${failed.map(item => item.line).join('、')}` : ''}。需要验证码的账号请逐个完成验证。`, failed.length > 0);
  });
}
function assignmentForm(ids) {
  if (!snapshot.accounts.length || !snapshot.servers.length) { notify('请先添加账号和服务器。', true); return; }
  const accountLabel = el('label', '', ids?.length ? `分配 ${ids.length} 个选中账号` : 'Steam 账号'), accountSelect = el('select');
  const available = snapshot.accounts.filter(account => !snapshot.assignments.some(item => item.accountId === account.id));
  for (const account of available) { const option = el('option', '', account.accountName); option.value = account.id; accountSelect.append(option); }
  accountLabel.append(accountSelect); if (ids?.length) accountSelect.hidden = true;
  if (!ids?.length && !available.length) { notify('所有账号都已有分配记录。', true); return; }
  const serverLabel = el('label', '', '目标服务器'), serverSelect = el('select');
  for (const server of snapshot.servers) { const option = el('option', '', `${server.name} · ${server.connected ? '已连接' : '未连接'}`); option.value = server.id; serverSelect.append(option); } serverLabel.append(serverSelect);
  const name = field('显示名称（可留空，使用昵称或账号名）'); name.input.required = false;
  formDialog('新建机器人分配', [accountLabel, serverLabel, ...(ids?.length ? [] : [name])], '创建分配', async () => {
    const targets = ids?.length ? ids : [accountSelect.value]; const failures = [];
    for (const id of targets) {
      try { await api('/assignments', 'POST', { accountId: id, serverId: serverSelect.value, displayName: ids?.length ? undefined : name.input.value }); }
      catch (error) { failures.push(`${snapshot.accounts.find(account => account.id === id)?.accountName}: ${error.message}`); }
    }
    if (failures.length) throw new Error(failures.join('\n'));
    notify('分配已保存。账号在线且插件连接后，会自动申请票据并创建实体。');
  }, '一个账号同时只分配给一台服务器。');
}
$('unlock-form').addEventListener('submit', async event => { event.preventDefault(); apiKey = $('key').value.trim(); $('key').value = ''; sessionStorage.setItem('adminlogger-key', apiKey); await refresh(); });
$('key-file').addEventListener('change', async event => { const file = event.target.files[0]; if (file) $('key').value = (await file.text()).trim(); event.target.value = ''; });
$('lock').addEventListener('click', lock);
$('refresh').addEventListener('click', refresh);
$('dialog-close').addEventListener('click', () => $('dialog').close());
$('dialog').addEventListener('close', () => $('dialog-content').replaceChildren());
$('add-server').addEventListener('click', () => serverForm());
$('add-account').addEventListener('click', () => accountForm());
$('import-accounts').addEventListener('click', importForm);
$('add-assignment').addEventListener('click', () => assignmentForm());
$('selected-assign').addEventListener('click', () => selected.size ? assignmentForm([...selected]) : notify('请先勾选账号。', true));
$('selected-logout').addEventListener('click', async () => {
  const ids = [...selected];
  if (!ids.length || batchLogoutRunning || !confirm(`退出选中的 ${ids.length} 个 Steam 账号？关联会话会先停止，分配记录会保留。`)) return;
  await logoutAccounts(ids);
});
$('logout-all').addEventListener('click', () => logoutAccounts(snapshot.accounts.filter(account => !account.loggingOut).map(account => account.id)));
$('selected-login').addEventListener('click', () => perform(async () => {
  if (!selected.size) throw new Error('请先勾选账号。');
  const errors = [];
  for (const id of selected) { const account = snapshot.accounts.find(item => item.id === id); if (!account || account.loggingOut || !['offline', 'error'].includes(account.state)) continue;
    try { await api(`/accounts/${id}/login`, 'POST', {}); } catch { errors.push(account.accountName); } }
  if (errors.length) throw new Error(`以下账号暂时无法登录，请逐个检查：${errors.join('、')}`);
}));
$('select-all').addEventListener('change', event => { selected.clear(); if (event.target.checked) snapshot.accounts.forEach(account => selected.add(account.id)); render(); });
$('shutdown').addEventListener('click', () => { if (confirm('停止控制端服务？将尝试先清理机器人实体并取消票据。')) perform(async () => { await api('/shutdown', 'POST', {}); notify('服务正在停止，请等待实体和票据清理完成。'); }); });
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('key')) { apiKey = fragment.get('key'); sessionStorage.setItem('adminlogger-key', apiKey); history.replaceState(null, '', location.pathname); }
if (apiKey) refresh();
setInterval(() => { if (!document.hidden && apiKey) refresh(); }, 3000);
