import { randomInt } from 'node:crypto';
import { ApiError } from './errors.js';
import { AccountFeatures } from './features.js';
export { ApiError } from './errors.js';

const transientResults = new Set(['NoConnection', 'Busy', 'Timeout', 'ServiceUnavailable', 'ConnectFailed',
  'TryAnotherCM', 'RemoteCallFailed', 'ServiceReadOnly', 'RateLimitExceeded', 'BadResponse']);
const transientNetwork = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

export function validateId(id) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new ApiError(400, 'Account id must contain 1-64 letters, digits, _ or -.');
}

function requireString(value, name, max) {
  if (typeof value !== 'string' || !value.length || value.length > max) {
    throw new ApiError(400, `${name} must be a non-empty string (max ${max} characters).`);
  }
}

export class AccountManager {
  constructor({ store, createClient, onlinePersona, resultNames, currencyNames = {}, featureOptions = {}, log = () => {},
    retryDelay = (attempt, limited) => Math.min(300000, (limited ? 60000 : 5000) * 2 ** Math.min(6, attempt - 1)) + randomInt(0, 2000) }) {
    this.store = store;
    this.createClient = createClient;
    this.onlinePersona = onlinePersona;
    this.resultNames = resultNames;
    this.currencyNames = currencyNames;
    this.featureOptions = featureOptions;
    this.log = log;
    this.retryDelay = retryDelay;
    this.closed = false;
    this.accounts = new Map(store.read().map(saved => {
      validateId(saved.id);
      return [saved.id, {
        saved, client: null, state: 'offline', guard: null, guardCallback: null,
        lastError: null, lastConnectedAt: null, changedAt: new Date().toISOString(),
      }];
    }));
  }

  persist() { this.store.write([...this.accounts.values()].map(account => account.saved)); }

  change(account, state) {
    account.state = state;
    account.changedAt = new Date().toISOString();
    try { this.log({ accountId: account.saved.id, state, code: account.lastError?.code || null,
      eresult: account.lastError?.eresult ?? null, retryAt: account.retryAt || null }); } catch {}
  }

  view(account) {
    return {
      id: account.saved.id, accountName: account.saved.accountName,
      steamId: account.saved.steamId ?? null, state: account.state,
      autoConnect: account.saved.autoConnect, hasSavedLogin: Boolean(account.saved.refreshToken),
      retryAt: account.retryAt || null, loggingOut: account.loggingOut === true,
      nickname: account.features?.profile.nickname || null,
      avatarUrl: account.features?.profile.avatarUrl || null,
      idle: account.features?.snapshot().idle || { ...(account.saved.idle || { enabled: false, appIds: [] }), status: account.saved.idle?.enabled ? 'waiting_connection' : 'stopped' },
      guard: account.guard ? {
        type: account.guard.type, emailDomain: account.guard.emailDomain,
        lastCodeWrong: account.guard.lastCodeWrong,
        retryAfterSeconds: Math.max(0, Math.ceil((account.guard.notBefore - Date.now()) / 1000)),
      } : null,
      lastError: account.lastError, lastConnectedAt: account.lastConnectedAt, changedAt: account.changedAt,
    };
  }

  get(id) {
    validateId(id);
    const account = this.accounts.get(id);
    if (!account) throw new ApiError(404, 'Account not found.');
    return account;
  }

  list() { return [...this.accounts.values()].map(account => this.view(account)); }

  login(id, input = {}) {
    if (this.closed) throw new ApiError(503, 'Service is stopping.');
    validateId(id);
    const allowed = ['accountName', 'password', 'authCode', 'twoFactorCode'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new ApiError(400, 'Unknown login field.');
    let account = this.accounts.get(id);
    if (account?.client || account?.loggingOut || account?.retryTimer) {
      throw new ApiError(409, '此账号正在登录、等待重试或退出。');
    }

    const hasCredentials = input.accountName !== undefined || input.password !== undefined;
    let details;
    if (hasCredentials) {
      requireString(input.accountName, 'accountName', 64);
      requireString(input.password, 'password', 512);
      if (!/^[A-Za-z0-9_]+$/.test(input.accountName)) throw new ApiError(400, 'Invalid Steam account name.');
      if (account && account.saved.accountName.toLowerCase() !== input.accountName.toLowerCase()) {
        throw new ApiError(409, 'This id belongs to a different account; use a new id or delete the old one.');
      }
      if ([...this.accounts.values()].some(other => other !== account
        && other.saved.accountName.toLowerCase() === input.accountName.toLowerCase())) {
        throw new ApiError(409, 'This Steam account is already registered under another id.');
      }
      for (const field of ['authCode', 'twoFactorCode']) {
        if (input[field] !== undefined && (typeof input[field] !== 'string' || !/^[A-Za-z0-9]{5}$/.test(input[field]))) {
          throw new ApiError(400, `${field} must be a five-character Steam Guard code.`);
        }
      }
      details = { accountName: input.accountName, password: input.password };
      if (input.authCode) details.authCode = input.authCode.toUpperCase();
      if (input.twoFactorCode) details.twoFactorCode = input.twoFactorCode.toUpperCase();
    } else {
      if (Object.keys(input).length) throw new ApiError(400, 'Guard codes require an account name and password, or use /guard.');
      if (!account?.saved.refreshToken) throw new ApiError(400, 'No saved login; provide accountName and password.');
      details = { refreshToken: account.saved.refreshToken };
    }

    if (!account) {
      account = {
        saved: { id, accountName: input.accountName, autoConnect: true, logonId: randomInt(1, 0x100000000) },
        client: null, state: 'offline', guard: null, guardCallback: null,
        lastError: null, lastConnectedAt: null, changedAt: new Date().toISOString(),
      };
      this.accounts.set(id, account);
    }
    account.saved.autoConnect = true;
    // Explicit credential login replaces a potentially revoked or expired saved token.
    if (hasCredentials) delete account.saved.refreshToken;
    this.persist();
    if (hasCredentials && account.saved.machineAuthToken) details.machineAuthToken = account.saved.machineAuthToken;
    details.logonID = account.saved.logonId;
    details.machineName = `MultiAccount-${id}`;
    account.retryCount = 0;
    account.retryPassword = hasCredentials ? input.password : null;
    this.start(account, details);
    return this.view(account);
  }

  start(account, details) {
    const client = this.createClient();
    account.client = client;
    account.lastError = null;
    account.guard = null;
    account.guardCallback = null;
    this.change(account, 'connecting');
    const current = () => !this.closed && account.client === client;
    const loginError = error => {
      if (!current()) return;
      const name = this.resultNames[error?.eresult];
      const transport = [error?.code, error?.cause?.code].find(code => transientNetwork.has(code));
      const retry = transientResults.has(name) || (!name && (Boolean(transport)
        || ['No Steam servers available', 'Request timed out'].includes(error?.message)));
      const code = name || transport || 'SteamConnectionError';
      this.fail(account, client, { code, eresult: error?.eresult ?? null,
        message: retry ? 'Steam 暂时无法登录，将自动重试。'
          : `Steam 登录失败（${code}）。请检查账号凭据或验证要求。` }, retry);
    };
    account.features = new AccountFeatures({
      account, client, current, persist: () => this.persist(), resultNames: this.resultNames,
      currencyNames: this.currencyNames, ...this.featureOptions,
    });
    const saveSecret = (field, value) => {
      if (!current()) return;
      account.saved[field] = value;
      try { this.persist(); }
      catch { this.fail(account, client, { code: 'StorageError', message: 'Could not save login; check the data directory.' }); }
    };

    client.on('refreshToken', token => saveSecret('refreshToken', token));
    client.on('machineAuthToken', token => saveSecret('machineAuthToken', token));
    client.on('loggedOn', () => {
      if (!current()) return;
      this.clearRetry(account);
      account.saved.steamId = client.steamID.getSteamID64();
      account.lastConnectedAt = new Date().toISOString();
      account.lastError = null;
      account.guard = null;
      account.guardCallback = null;
      try {
        this.persist();
        client.setPersona(this.onlinePersona);
        this.change(account, 'online');
        account.features.onLoggedOn();
      } catch {
        this.fail(account, client, { code: 'SessionSetupError', message: 'Could not save or initialize the online session.' });
      }
    });
    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      if (!current()) return;
      account.guardCallback = callback;
      account.guard = {
        type: domain ? 'email' : 'totp', emailDomain: domain || null,
        lastCodeWrong: Boolean(lastCodeWrong), notBefore: Date.now() + (lastCodeWrong ? 30000 : 0),
      };
      this.change(account, 'guard_required');
    });
    client.on('disconnected', (eresult) => {
      if (!current() || account.state === 'guard_required') return;
      account.features.disconnect();
      account.lastError = { code: 'Disconnected', eresult, message: 'Connection lost; steam-user will reconnect automatically.' };
      this.change(account, 'reconnecting');
    });
    client.on('error', loginError);
    // A pending request can be cancelled before steam-user schedules its own next-tick login.
    setImmediate(() => {
      if (!current()) return;
      try { client.logOn(details); }
      catch (error) { loginError(error); }
    });
  }

  clearRetry(account) {
    clearTimeout(account.retryTimer);
    account.retryTimer = null;
    account.retryAt = null;
    account.retryCount = 0;
    account.retryPassword = null;
  }

  scheduleRetry(account, limited) {
    if (this.closed || account.loggingOut || !account.saved.autoConnect
      || (!account.saved.refreshToken && !account.retryPassword)) return false;
    const delay = this.retryDelay(++account.retryCount, limited);
    account.retryAt = new Date(Date.now() + delay).toISOString();
    account.retryTimer = setTimeout(() => {
      account.retryTimer = null;
      account.retryAt = null;
      if (this.closed || this.accounts.get(account.saved.id) !== account
        || account.client || account.loggingOut || !account.saved.autoConnect) return;
      const saved = account.saved;
      const details = saved.refreshToken ? { refreshToken: saved.refreshToken }
        : { accountName: saved.accountName, password: account.retryPassword, machineAuthToken: saved.machineAuthToken };
      try { this.start(account, { ...details, logonID: saved.logonId, machineName: `MultiAccount-${saved.id}` }); }
      catch {
        this.clearRetry(account);
        account.lastError = { code: 'LoginSetupError', message: '无法启动 Steam 登录，请检查控制端配置。' };
        this.change(account, 'error');
      }
    }, delay);
    account.retryTimer.unref();
    this.change(account, 'retry_wait');
    return true;
  }

  fail(account, client, error, retry = false) {
    if (account.client !== client) return;
    account.features?.disconnect();
    account.client = null;
    account.guard = null;
    account.guardCallback = null;
    account.lastError = error;
    if (!retry || !this.scheduleRetry(account, error.code === 'RateLimitExceeded')) {
      this.clearRetry(account);
      this.change(account, 'error');
    }
    // Keep the error listener attached, but ignore events from this retired client.
    setImmediate(() => { try { client.logOff(); } catch {} });
  }

  submitGuard(id, code) {
    const account = this.get(id);
    if (account.state !== 'guard_required' || !account.guardCallback) throw new ApiError(409, 'No pending Steam Guard request.');
    if (typeof code !== 'string' || !/^[a-zA-Z0-9]{5}$/.test(code)) throw new ApiError(400, 'code must be a five-character Steam Guard code.');
    if (Date.now() < account.guard.notBefore) throw new ApiError(429, 'Wait 30 seconds after an incorrect mobile code, then enter a new code.');
    const callback = account.guardCallback;
    account.guardCallback = null;
    account.guard = null;
    this.change(account, 'connecting');
    try { callback(code.toUpperCase()); }
    catch { this.fail(account, account.client, { code: 'GuardError', message: 'Could not submit Steam Guard code; login again.' }); }
    return this.view(account);
  }

  stopClient(account) {
    this.clearRetry(account);
    const client = account.client;
    account.client = null;
    account.guard = null;
    account.guardCallback = null;
    account.features?.disconnect();
    if (client) { try { client.logOff(); } catch {} }
  }

  async logout(id, beforeDisconnect = async () => {}) {
    const account = this.get(id);
    if (account.loggingOut) throw new ApiError(409, '此账号正在退出。');
    account.loggingOut = true;
    try {
      const previous = account.saved.autoConnect;
      account.saved.autoConnect = false;
      try { this.persist(); }
      catch (error) { account.saved.autoConnect = previous; throw error; }
      this.clearRetry(account);
      try { await beforeDisconnect(); }
      finally {
        this.stopClient(account);
        account.lastError = null;
        this.change(account, 'offline');
      }
    } finally { account.loggingOut = false; }
    return this.view(account);
  }

  remove(id) {
    const account = this.get(id);
    this.accounts.delete(id);
    try { this.persist(); }
    catch (error) { this.accounts.set(id, account); throw error; }
    this.stopClient(account);
  }

  details(id) {
    const account = this.get(id);
    return { ...this.view(account), ...(account.features?.snapshot() || { profile: {}, webReady: false, warnings: [], claims: [] }) };
  }

  features(id) {
    const account = this.get(id);
    if (!account.features) throw new ApiError(409, '请先登录该账号。');
    return account.features;
  }

  setIdle(id, ids) {
    const account = this.get(id);
    if (!account.features && Array.isArray(ids) && ids.length === 0) {
      account.saved.idle = { enabled: false, appIds: [], updatedAt: new Date().toISOString() };
      this.persist();
      return this.view(account).idle;
    }
    return this.features(id).setIdle(ids);
  }

  restore() {
    // Spread startup requests out; avoid sending all accounts to Steam at once.
    let delay = 0;
    for (const account of this.accounts.values()) {
      if (!account.saved.autoConnect || !account.saved.refreshToken) continue;
      const timer = setTimeout(() => {
        if (this.closed || !this.accounts.has(account.saved.id) || account.client || !account.saved.autoConnect) return;
        try { this.login(account.saved.id); }
        catch { account.lastError = { code: 'RestoreError', message: 'Could not restore saved login; login again.' }; this.change(account, 'error'); }
      }, delay);
      timer.unref();
      delay += 1000;
    }
  }

  close() {
    this.closed = true;
    for (const account of this.accounts.values()) this.stopClient(account);
    // Deliberately preserve autoConnect so these accounts resume next time.
  }
}
