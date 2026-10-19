import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OfficeStore } from '../lib/office.mjs';
import { ServerChanService } from '../lib/serverchan.mjs';

const localKey = 'SCT1234567890localSecret0123456789';
const environmentKey = 'SCT9876543210environmentSecret0123456789';
const input = (overrides = {}) => ({ title: '到期任务', owner: '王晨', startDate: '2026-10-01', dueDate: '2026-10-19', deliverable: '不可发送的正文内容', description: '不可发送的详细说明', ...overrides });
const response = (body = { code: 0 }, status = 200) => new Response(JSON.stringify(body), { status });

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'office-serverchan-'));
  let current = new Date('2026-10-19T02:00:00Z');
  const store = new OfficeStore({ databasePath: join(dir, 'office.sqlite'), seedDemo: false, now: () => current });
  const requests = []; const services = [];
  const fetchImpl = options.fetchImpl || (async (url, request) => { requests.push({ url, ...request }); return response(); });
  function service(extra = {}) { const value = new ServerChanService({ store, dataDir: dir, fetchImpl, ...options, ...extra }); services.push(value); return value; }
  const client = service();
  t.after(async () => { for (const instance of services) await instance.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, client, requests, service, setNow: value => { current = new Date(value); }, advance: ms => { current = new Date(current.valueOf() + ms); } };
}

test('微信配置原子保存，密钥不返回、不进入 SQLite 备份，空输入保留，环境配置优先', async t => {
  const { dir, client, store, service } = await fixture(t);
  assert.deepEqual(client.snapshot(), { enabled: false, configured: false, keySource: 'none', sendTime: '09:00', owner: '', latest: null, history: [] });
  assert.throws(() => client.updateSettings({ enabled: true }), /SCT SendKey/);
  assert.throws(() => client.updateSettings({ sendKey: 'sctp0123456789', enabled: true }), /Turbo/);
  assert.equal(client.snapshot().enabled, false);
  client.updateSettings({ sendKey: localKey, enabled: true, owner: ' 王晨 ', sendTime: '08:35' });
  const original = await readFile(join(dir, 'serverchan.json'), 'utf8');
  assert.throws(() => client.updateSettings({ sendTime: '24:00', owner: '不应部分保存', sendKey: environmentKey }), /时间/);
  assert.equal(await readFile(join(dir, 'serverchan.json'), 'utf8'), original);
  assert.equal(client.updateSettings({ sendKey: '' }).configured, true);
  assert.equal(client.snapshot().owner, '王晨');
  assert.ok(!JSON.stringify(client.snapshot()).includes(localKey));
  const backup = join(dir, 'backup.sqlite'); store.createBackup(backup);
  assert.equal((await readFile(backup)).includes(Buffer.from(localKey)), false);
  const environment = service({ sendKey: environmentKey });
  assert.equal(environment.snapshot().keySource, 'environment');
  assert.throws(() => environment.updateSettings({ clearSendKey: true }), error => error.status === 409 && /环境变量/.test(error.message));
  assert.throws(() => environment.updateSettings({ owner: '不应保存', sendKey: localKey }), error => error.status === 409 && /环境变量/.test(error.message));
  assert.equal(environment.snapshot().owner, '王晨');
  await environment.sendTest();
  const cleared = client.updateSettings({ clearSendKey: true });
  assert.equal(cleared.enabled, false); assert.equal(cleared.configured, false);
  assert.equal(service({ sendKey: 'sctpInvalid' }).snapshot().configured, false);
});

test('测试消息允许停用时发送，固定 HTTPS 请求且不占当日摘要，发送结果只表示受理', async t => {
  const { client, requests, store, advance } = await fixture(t);
  client.updateSettings({ sendKey: localKey }); store.createTask(input());
  const testResult = await client.sendTest();
  assert.equal(testResult.sent, true); assert.equal(testResult.record.kind, 'test');
  assert.match(testResult.message, /已受理.*微信确认/);
  assert.equal(requests[0].url, `https://sctapi.ftqq.com/${localKey}.send`);
  assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].redirect, 'error');
  assert.match(requests[0].headers['Content-Type'], /form-urlencoded/);
  const testBody = new URLSearchParams(requests[0].body);
  assert.ok(Array.from(testBody.get('title')).length <= 32);
  assert.match(testBody.get('desp'), /虚构/); assert.doesNotMatch(testBody.get('desp'), /不可发送/);
  assert.equal((await client.sendToday()).skipped, true);
  client.updateSettings({ enabled: true }); advance(60_000);
  assert.equal((await client.sendToday()).sent, true);
  assert.deepEqual(client.snapshot().history.map(record => record.kind), ['digest', 'test']);
  advance(60_000);
  await client.send('test', 0, '测试标题'.repeat(20) + '🚆', '虚构内容');
  assert.equal(Array.from(new URLSearchParams(requests[2].body).get('title')).length, 32);
});

test('损坏的本地配置安全停用并保留原文件，重新保存清除中文提示', async t => {
  const { dir, service } = await fixture(t);
  const damaged = '{"sendKey":"' + localKey + '","enabled":true,损坏';
  await writeFile(join(dir, 'serverchan.json'), damaged, 'utf8');
  const client = service(); const snapshot = client.snapshot();
  assert.equal(snapshot.enabled, false); assert.equal(snapshot.configured, false);
  assert.match(snapshot.configError, /安全停用/);
  assert.doesNotMatch(JSON.stringify(snapshot), /localSecret/);
  assert.equal(await readFile(join(dir, 'serverchan.json'), 'utf8'), damaged);
  assert.equal((await client.runScheduled()).skipped, true);
  assert.equal(client.updateSettings({ sendKey: localKey }).configError, undefined);
  assert.equal(service().snapshot().configured, true);
});

test('北京时间日界及时间阈值准确；无任务不占当天发送机会', async t => {
  const { client, store, setNow, requests } = await fixture(t);
  client.updateSettings({ sendKey: localKey, enabled: true, sendTime: '09:00' });
  setNow('2026-10-18T16:01:00Z');
  assert.equal(store.today(), '2026-10-19');
  assert.match((await client.runScheduled()).reason, /尚未到达/);
  setNow('2026-10-19T00:59:59Z');
  assert.match((await client.runScheduled()).reason, /尚未到达/);
  setNow('2026-10-19T01:00:00Z');
  assert.match((await client.runScheduled()).reason, /没有/);
  assert.equal(client.snapshot().history.length, 0);
  store.createTask(input());
  assert.equal((await client.runScheduled()).sent, true);
  assert.equal((await client.runScheduled()).skipped, true);
  setNow('2026-10-19T16:01:00Z');
  assert.match((await client.runScheduled()).reason, /尚未到达/);
  setNow('2026-10-20T01:00:00Z');
  assert.equal((await client.runScheduled()).sent, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(client.snapshot().history.map(record => record.day), ['2026-10-20', '2026-10-19']);
});

test('摘要按负责人和站内提醒天数筛选，排除已完成、回收站，已读仍推送且内容转义限长', async t => {
  const { client, store, requests } = await fixture(t);
  client.updateSettings({ sendKey: localKey, enabled: true, owner: '王晨' });
  store.updateSettings({ reminderDays: 2 });
  store.createTask(input({ title: '[点击](https://evil.test) **粗体** <script>\n新行', dueDate: '2026-10-18' }));
  store.createTask(input({ title: '今日项目' }));
  store.createTask(input({ title: '临期项目', dueDate: '2026-10-21' }));
  store.createTask(input({ title: '窗口外', dueDate: '2026-10-22' }));
  store.createTask(input({ title: '他人项目', owner: '王晨甲' }));
  const removed = store.createTask(input({ title: '已删除项目' })); store.deleteTask(removed.id);
  const complete = store.createTask(input({ title: '已完成项目' }));
  store.completeTask(complete.id, { confirmed: true, files: [{ name: '结果.txt', contentBase64: Buffer.from('已完成').toString('base64') }] });
  store.run(); store.readReminders({ all: true });
  for (let index = 0; index < 55; index++) store.createTask(input({ title: `${index}号` + '超长任务标题'.repeat(25) }));
  const sent = await client.sendToday();
  assert.equal(sent.record.taskCount, 58);
  const body = new URLSearchParams(requests[0].body).get('desp');
  assert.ok(body.includes('\\[点击\\]\\(https://evil\\.test\\)'));
  assert.ok(body.includes('&lt;script&gt;')); assert.doesNotMatch(body, /<script>/);
  assert.match(body, /逾期/); assert.match(body, /到期/);
  assert.doesNotMatch(body, /窗口外|他人项目|已删除项目|已完成项目|不可发送|localhost|127\.0\.0\.1/);
  assert.match(body, /另有 .* 项任务/); assert.ok(Buffer.byteLength(body) <= 8192);
});

test('每日摘要持久化去重，并发调用及独立数据库连接只能占位一次', async t => {
  let unblock; let calls = 0;
  const gate = new Promise(resolve => { unblock = resolve; });
  const { client, store, dir } = await fixture(t, { fetchImpl: async () => { calls++; await gate; return response(); } });
  client.updateSettings({ sendKey: localKey, enabled: true }); store.createTask(input());
  const otherStore = new OfficeStore({ databasePath: join(dir, 'office.sqlite'), seedDemo: false, now: store.now });
  const other = new ServerChanService({ store: otherStore, dataDir: dir, fetchImpl: async () => { calls++; return response(); } });
  try {
    const first = client.sendToday();
    assert.equal((await client.sendToday()).skipped, true);
    assert.equal((await other.sendToday()).skipped, true);
    unblock(); assert.equal((await first).sent, true);
    assert.equal((await other.sendToday({ retry: true })).skipped, true);
    assert.equal(calls, 1);
    assert.equal(other.snapshot().latest.attempts, 1);
  } finally { unblock(); await other.close(); otherStore.close(); }
});

test('发送失败不自动重试，手动重试也遵守 60 秒限频且重启不丢失记录', async t => {
  let calls = 0;
  const { client, store, service, advance } = await fixture(t, { fetchImpl: async () => { calls++; return calls === 1 ? response({ code: 40001, message: localKey }) : response(); } });
  client.updateSettings({ sendKey: localKey, enabled: true }); store.createTask(input());
  const failed = await client.runScheduled();
  assert.equal(failed.sent, false); assert.equal(failed.record.status, 'failed');
  assert.match(failed.record.error, /40001/); assert.doesNotMatch(JSON.stringify(client.snapshot()), new RegExp(localKey));
  const reopened = service();
  assert.match((await reopened.sendToday()).reason, /不会自动重发/);
  assert.match((await reopened.sendToday({ retry: true })).reason, /60 秒/);
  advance(60_000);
  assert.equal((await reopened.runScheduled()).skipped, true);
  const retried = await reopened.sendToday({ retry: true });
  assert.equal(retried.sent, true); assert.equal(retried.record.attempts, 2); assert.equal(calls, 2);
  assert.equal((await reopened.sendToday({ retry: true })).skipped, true);
});

test('响应体读取也受超时限制，结果未知时保留失败状态且不自动重试', async t => {
  const { client, store, advance } = await fixture(t, { timeoutMs: 20, fetchImpl: async () => ({ ok: true, text: () => new Promise(() => {}) }) });
  client.updateSettings({ sendKey: localKey, enabled: true }); store.createTask(input());
  const start = Date.now(); const value = await client.sendToday();
  assert.ok(Date.now() - start < 2000);
  assert.equal(value.sent, false); assert.equal(value.record.status, 'failed');
  assert.match(value.record.error, /超时.*结果未知/);
  advance(120_000);
  assert.equal((await client.runScheduled()).skipped, true);
});

test('崩溃遗留发送记录超过保护期后可手动恢复，调度绝不自动重发', async t => {
  const { client, store, service, advance } = await fixture(t);
  client.updateSettings({ sendKey: localKey, enabled: true }); store.createTask(input());
  const claimed = client.claim('digest', 1, false);
  assert.equal(claimed.record.status, 'sending');
  assert.match((await client.sendToday({ retry: true })).reason, /正在发送/);
  advance(60_001);
  const reopened = service();
  assert.equal(reopened.snapshot().latest.status, 'failed');
  assert.match(reopened.snapshot().latest.error, /未确认.*结果未知/);
  assert.equal((await reopened.runScheduled()).skipped, true);
  assert.equal((await reopened.sendToday({ retry: true })).sent, true);
  assert.equal(reopened.snapshot().latest.attempts, 2);
});

test('上游 HTTP、非零及字符串 code、异常和恶意回应均不作为成功，不泄露密钥或原始回应', async t => {
  const malicious = `${localKey} https://sctapi.ftqq.com/${localKey}.send 上游私密原文`;
  const cases = [
    async () => response({ secret: malicious }, 403),
    async () => response({ code: '0', message: malicious }),
    async () => new Response(malicious),
    async () => { throw new Error(malicious); },
    async () => response({ code: malicious }),
    async () => response({ code: 1000, message: malicious })
  ];
  for (const fetchImpl of cases) {
    const { client } = await fixture(t, { fetchImpl });
    client.updateSettings({ sendKey: localKey });
    const value = await client.sendTest();
    assert.equal(value.sent, false); assert.equal(value.skipped, false);
    assert.equal(value.record.status, 'failed');
    assert.doesNotMatch(JSON.stringify(value), /localSecret|sctapi|上游私密原文/);
    assert.doesNotMatch(JSON.stringify(client.snapshot()), /localSecret|sctapi|上游私密原文/);
  }
});

test('关闭服务中止并等待活动发送，之后不再访问网络；历史只返回最近十条', async t => {
  let aborted = false;
  const { client, advance, service } = await fixture(t, { fetchImpl: async (_url, request) => new Promise((_, reject) => { request.signal.addEventListener('abort', () => { aborted = true; reject(new Error(localKey)); }); }) });
  client.updateSettings({ sendKey: localKey });
  const sending = client.sendTest();
  await client.close();
  assert.equal(aborted, true);
  assert.equal((await sending).record.status, 'failed');
  assert.match((await client.sendTest()).reason, /正在关闭/);
  const next = service({ fetchImpl: async () => response() });
  for (let index = 0; index < 12; index++) { advance(60_000); assert.equal((await next.sendTest()).sent, true); }
  assert.equal(next.snapshot().history.length, 10);
});

test('SQLite 备份保留每日去重，恢复备份不包含本地 SendKey', async t => {
  const { client, store, dir } = await fixture(t);
  client.updateSettings({ sendKey: localKey, enabled: true }); store.createTask(input());
  assert.equal((await client.sendToday()).sent, true);
  const backup = join(dir, 'after-send.sqlite'); store.createBackup(backup);
  const db = new DatabaseSync(backup);
  try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM serverchan_records WHERE kind='digest' AND status='sent'").get().count, 1); }
  finally { db.close(); }
  assert.equal((await readFile(backup)).includes(Buffer.from(localKey)), false);
});
