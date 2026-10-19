import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addDays } from './dates.mjs';
import { InputError } from './csv.mjs';

const defaults = { enabled: false, sendTime: '09:00', owner: '', sendKey: '' };
const minimumIntervalMs = 60_000;
const acceptedMessage = 'Server酱已受理，请在微信确认。';
const unknownMessage = '发送结果未知，请先在 Server酱控制台核实，再手动重试。';

function validateKey(value) {
  if (typeof value !== 'string') throw new InputError('SendKey 必须为文本。');
  const key = value.trim();
  if (/^sctp/i.test(key)) throw new InputError('当前支持 Server酱 Turbo 的 SCT SendKey；sctp 属于其他接口，请使用 Turbo 服务生成的 SendKey。');
  if (!/^SCT[A-Za-z0-9]{8,200}$/.test(key)) throw new InputError('请填写有效的 Server酱 Turbo SCT SendKey。');
  return key;
}

function validateSettings(value) {
  if (typeof value.enabled !== 'boolean') throw new InputError('微信推送启用状态必须为布尔值。');
  if (typeof value.sendTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.sendTime)) throw new InputError('每日推送时间必须是有效的 24 小时制时间，如 09:00。');
  if (typeof value.owner !== 'string' || value.owner.length > 80) throw new InputError('负责人最多 80 个字符，留空表示全部负责人。');
  if (typeof value.sendKey !== 'string') throw new InputError('SendKey 必须为文本。');
  return { enabled: value.enabled, sendTime: value.sendTime, owner: value.owner.trim(), sendKey: value.sendKey ? validateKey(value.sendKey) : '' };
}

function markdown(value) {
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
}

function digestText(tasks, day) {
  let body = `${day} 任务提醒\n\n共有 ${tasks.length} 项未完成任务需要关注。\n\n`;
  let shown = 0;
  for (const task of tasks.slice(0, 50)) {
    const kind = task.dueDate < day ? '逾期' : task.dueDate === day ? '到期' : '临期';
    const line = `- **${kind}**｜${markdown(task.title)}；负责人：${markdown(task.owner)}；截止：${task.dueDate}\n`;
    if (Buffer.byteLength(body + line, 'utf8') > 7400) break;
    body += line; shown++;
  }
  if (shown < tasks.length) body += `\n另有 ${tasks.length - shown} 项任务，请到电脑上的办公应用查看。\n`;
  body += '\n本消息仅含任务摘要，请到电脑上的办公应用处理任务。';
  return body;
}

function result(reason, record = null, { sent = false, skipped = true } = {}) {
  return { sent, skipped, reason, message: reason, record };
}

export class ServerChanService {
  constructor({ store, dataDir, sendKey = '', fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    this.store = store; this.path = join(resolve(dataDir), 'serverchan.json');
    this.environmentKey = typeof sendKey === 'string' ? sendKey.trim() : '';
    this.fetchImpl = fetchImpl; this.timeoutMs = Math.max(1, Number(timeoutMs) || 8000);
    this.closed = false; this.active = new Set();
    this.config = { ...defaults }; this.configError = null;
    if (existsSync(this.path)) {
      try { this.config = validateSettings({ ...defaults, ...JSON.parse(readFileSync(this.path, 'utf8')) }); }
      catch { this.configError = '微信推送本地配置无法读取，已安全停用。请检查配置后重新保存。'; }
    }
    store.db.exec(`CREATE TABLE IF NOT EXISTS serverchan_records (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      taskCount INTEGER NOT NULL, attempts INTEGER NOT NULL, attemptedAt TEXT NOT NULL,
      finishedAt TEXT, error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS serverchan_digest_day ON serverchan_records(day) WHERE kind='digest';
    CREATE INDEX IF NOT EXISTS serverchan_attempted ON serverchan_records(attemptedAt);`);
    this.recoverStale();
  }

  key() { return this.environmentKey || this.config.sendKey; }
  configured() { try { validateKey(this.key()); return true; } catch { return false; } }
  now() { return this.store.now(); }
  transaction(fn) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.store.db.exec('COMMIT'); return value; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  record(id) { return this.store.db.prepare('SELECT * FROM serverchan_records WHERE id=?').get(id) || null; }
  recoverStale() {
    const now = this.now();
    const before = new Date(now.valueOf() - Math.max(this.timeoutMs + 5000, minimumIntervalMs)).toISOString();
    this.store.db.prepare("UPDATE serverchan_records SET status='failed',finishedAt=?,error=? WHERE status='sending' AND attemptedAt<=?").run(now.toISOString(), `上次发送未确认完成。${unknownMessage}`, before);
  }

  snapshot() {
    this.recoverStale();
    const history = this.store.db.prepare('SELECT * FROM serverchan_records ORDER BY attemptedAt DESC,rowid DESC LIMIT 10').all();
    return { enabled: this.config.enabled, configured: this.configured(), keySource: this.environmentKey ? 'environment' : this.config.sendKey ? 'local' : 'none', sendTime: this.config.sendTime, owner: this.config.owner, latest: history[0] || null, history, ...(this.configError ? { configError: this.configError } : {}) };
  }

  updateSettings(input) {
    if (this.closed) throw new InputError('微信推送服务正在关闭，请稍后重试。', 503);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('微信推送配置必须是 JSON 对象。');
    if (Object.hasOwn(input, 'clearSendKey') && typeof input.clearSendKey !== 'boolean') throw new InputError('清除 SendKey 必须为布尔值。');
    if (input.clearSendKey && this.environmentKey) throw new InputError('当前 SendKey 来自环境变量，请在本机环境配置中修改，页面不能清除。', 409);
    const next = { ...this.config };
    for (const name of ['enabled', 'sendTime', 'owner']) if (Object.hasOwn(input, name)) next[name] = input[name];
    if (Object.hasOwn(input, 'sendKey')) {
      if (typeof input.sendKey !== 'string') throw new InputError('SendKey 必须为文本。');
      if (input.sendKey.trim() && this.environmentKey) throw new InputError('当前 SendKey 来自环境变量，请在本机环境配置中修改，页面不能覆盖。', 409);
      if (input.sendKey.trim()) next.sendKey = validateKey(input.sendKey);
    }
    if (input.clearSendKey) { next.sendKey = ''; next.enabled = false; }
    const valid = validateSettings(next);
    if (valid.enabled) validateKey(this.environmentKey || valid.sendKey);
    mkdirSync(resolve(this.path, '..'), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(valid, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }); renameSync(temporary, this.path); }
    catch { try { rmSync(temporary, { force: true }); } catch {} throw new InputError('微信推送配置保存失败，请检查本机数据目录的写入权限。', 500); }
    this.config = valid; this.configError = null;
    return this.snapshot();
  }

  tasks(day) {
    const settings = this.store.settings();
    const days = Number.isInteger(settings.reminderDays) ? settings.reminderDays : 1;
    return this.store.db.prepare("SELECT title,owner,dueDate FROM tasks WHERE deletedAt IS NULL AND status<>'已完成' AND dueDate<=? AND (?='' OR owner=?) ORDER BY dueDate,number").all(addDays(day, days), this.config.owner, this.config.owner);
  }

  claim(kind, taskCount, retry) {
    return this.transaction(() => {
      this.recoverStale();
      const day = this.store.today();
      const existing = kind === 'digest' ? this.store.db.prepare("SELECT * FROM serverchan_records WHERE day=? AND kind='digest'").get(day) : null;
      if (existing?.status === 'sent') return result('今日摘要已获 Server酱受理，无需重复发送。', existing);
      if (existing?.status === 'sending') return result('今日摘要正在发送，请稍候查看结果。', existing);
      if (existing && !retry) return result(`今日摘要尚未确认成功，不会自动重发。${unknownMessage}`, existing);
      const now = this.now();
      const latest = this.store.db.prepare('SELECT attemptedAt FROM serverchan_records ORDER BY attemptedAt DESC LIMIT 1').get();
      if (latest && now.valueOf() - Date.parse(latest.attemptedAt) < minimumIntervalMs) return result('推送请求至少间隔 60 秒，请稍后再试。', existing);
      const id = existing?.id || randomUUID();
      if (existing) this.store.db.prepare("UPDATE serverchan_records SET status='sending',taskCount=?,attempts=attempts+1,attemptedAt=?,finishedAt=NULL,error=NULL WHERE id=?").run(taskCount, now.toISOString(), id);
      else this.store.db.prepare("INSERT INTO serverchan_records(id,day,kind,status,taskCount,attempts,attemptedAt,finishedAt,error) VALUES(?,?,?,'sending',?,1,?,NULL,NULL)").run(id, day, kind, taskCount, now.toISOString());
      return { claimed: true, record: this.record(id) };
    });
  }

  async send(kind, taskCount, title, desp, retry = false) {
    if (this.closed) return result('微信推送服务正在关闭，请稍后重试。');
    if (!this.configured()) return result('请先配置有效的 Server酱 Turbo SCT SendKey。');
    const claim = this.claim(kind, taskCount, retry);
    if (!claim.claimed) return claim;
    const controller = new AbortController();
    const activity = { controller, promise: null };
    const perform = async () => {
      let timedOut = false; let timer; let error = null;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('timeout')); }, this.timeoutMs); });
        const request = (async () => {
          const response = await this.fetchImpl(`https://sctapi.ftqq.com/${this.key()}.send`, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ title: Array.from(title).slice(0, 32).join(''), desp }).toString()
          });
          if (!response.ok) return `Server酱请求未成功（HTTP ${Number.isInteger(response.status) ? response.status : 0}）。请检查服务配置及额度。`;
          let payload;
          try { payload = JSON.parse(await response.text()); }
          catch { return `Server酱返回格式异常。${unknownMessage}`; }
          if (!payload || typeof payload !== 'object' || payload.code !== 0) {
            const code = Number.isInteger(payload?.code) && Math.abs(payload.code) <= 1_000_000_000 ? `（错误码 ${payload.code}）` : '';
            return `Server酱未受理本次推送${code}，请检查 SendKey、服务通道及额度。`;
          }
          return null;
        })();
        error = await Promise.race([request, timeout]);
      } catch {
        error = timedOut ? `推送请求超时。${unknownMessage}` : this.closed ? `服务关闭中断发送。${unknownMessage}` : `无法确认 Server酱的处理结果。${unknownMessage}`;
      } finally { clearTimeout(timer); }
      const record = claim.record;
      this.store.db.prepare("UPDATE serverchan_records SET status=?,finishedAt=?,error=? WHERE id=? AND status='sending' AND attemptedAt=?").run(error ? 'failed' : 'sent', this.now().toISOString(), error, record.id, record.attemptedAt);
      return result(error || acceptedMessage, this.record(record.id), { sent: !error, skipped: false });
    };
    this.active.add(activity);
    activity.promise = perform();
    try { return await activity.promise; }
    finally { this.active.delete(activity); }
  }

  async sendTest() {
    return this.send('test', 0, 'AI辅助办公应用 · 微信推送测试', '这是一条连接测试消息，使用虚构示例，不含真实任务资料。\n\n示例任务：核对办公室用品清单\n示例负责人：测试人员\n\nServer酱受理后，请在微信服务号中确认消息。');
  }

  async sendToday({ retry = false } = {}) {
    if (retry !== true && retry !== false) throw new InputError('重试标识必须为布尔值。');
    if (!this.config.enabled) return result('微信推送尚未启用，请先保存并启用配置。');
    const day = this.store.today(); const tasks = this.tasks(day);
    if (!tasks.length) return result('今日没有需要推送的未完成任务。');
    return this.send('digest', tasks.length, `任务提醒 ${day}（${tasks.length}项）`, digestText(tasks, day), retry);
  }

  async runScheduled() {
    try {
      if (this.closed || !this.config.enabled) return result('微信推送尚未启用。');
      const shanghaiTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(this.now());
      if (shanghaiTime < this.config.sendTime) return result('尚未到达每日推送时间。');
      return await this.sendToday();
    } catch { return result('微信推送处理失败，请在提醒服务中检查配置及推送记录。', null, { skipped: false }); }
  }

  async close() {
    this.closed = true;
    for (const activity of this.active) activity.controller.abort();
    await Promise.allSettled([...this.active].map(activity => activity.promise));
  }
}
