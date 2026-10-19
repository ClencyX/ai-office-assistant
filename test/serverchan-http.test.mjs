import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server.mjs';

const fakeKey = 'SCTLOCALTEST1234567890';
const taskInput = owner => ({ title: `${owner}的待交付事项`, owner, startDate: '2026-10-19', dueDate: '2026-10-19', deliverable: '完成成果材料' });
const accepted = () => new Response(JSON.stringify({ code: 0, data: { pushid: 'test-only' } }), { headers: { 'Content-Type': 'application/json' } });

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'office-wechat-http-'));
  const calls = []; let now = new Date('2026-10-19T02:00:00Z');
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir: dir, seedDemo: false, scheduler: 'external', automationKey: 'only-local-test', serverChanSendKey: '', now: () => now, serverChanFetch: async (url, init) => { calls.push({ url, init }); return accepted(); }, ...options });
  const address = await app.start(); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const send = (path, body = {}, method = 'POST', headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  return { app, dir, base, calls, send, advance: ms => { now = new Date(now.getTime() + ms); } };
}

test('微信配置和发送接口沿用同源JSON校验，未配置时不发网络请求', async t => {
  const { base, send, calls } = await fixture(t);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.serverchan.enabled, false); assert.equal(state.serverchan.configured, false);
  for (const [path, method] of [['/api/serverchan/settings', 'PATCH'], ['/api/serverchan/test', 'POST'], ['/api/serverchan/send', 'POST']]) {
    assert.equal((await send(path, {}, method, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await send(path, {}, method, { 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await send(path, {}, method, { 'Content-Type': 'text/plain' })).status, 415);
  }
  assert.equal((await send('/api/serverchan/send', { retry: 'true' })).status, 400);
  const missing = await (await send('/api/serverchan/test')).json();
  assert.equal(missing.result.sent, false); assert.equal(missing.result.skipped, true); assert.equal(calls.length, 0);
  const invalid = await send('/api/serverchan/settings', { enabled: true }, 'PATCH');
  assert.equal(invalid.status, 400);
});

test('本机微信配置不会从状态接口回显密钥，调度筛选本人任务且已读不影响独立推送', async t => {
  const { app, base, calls, send } = await fixture(t);
  const alice = await (await send('/api/tasks', taskInput('甲负责人'))).json();
  await send('/api/tasks', taskInput('乙负责人'));
  const savedResponse = await send('/api/serverchan/settings', { sendKey: fakeKey, enabled: true, owner: '甲负责人', sendTime: '09:00' }, 'PATCH');
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json(); assert.equal(saved.serverchan.configured, true); assert.equal(saved.serverchan.keySource, 'local');
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(fakeKey));
  app.store.run(); await send('/api/reminders/read', { all: true });
  assert.equal((await send('/api/automation/run', {}, 'POST', { 'x-automation-key': 'wrong' })).status, 403);
  const run = await (await send('/api/automation/run', {}, 'POST', { 'x-automation-key': 'only-local-test' })).json();
  assert.equal(run.serverchan.sent, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://sctapi.ftqq.com/${fakeKey}.send`);
  const text = new URLSearchParams(calls[0].init.body).get('desp');
  assert.match(text, /甲负责人/); assert.doesNotMatch(text, /乙负责人|完成成果材料/);
  assert.equal((await (await send('/api/run')).json()).serverchan.sent, false); assert.equal(calls.length, 1);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.tasks.find(task => task.id === alice.task.id).status, '待办');
  assert.equal(state.serverchan.latest.status, 'sent'); assert.doesNotMatch(JSON.stringify(state), new RegExp(fakeKey));
  const snapshot = await (await fetch(base + '/api/serverchan')).json();
  assert.equal(snapshot.serverchan.latest.status, 'sent'); assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(fakeKey));
});

test('上游拒绝后站内提醒仍成功，只有显式手动重试才再次调用，失败原因不暴露密钥', async t => {
  let fail = true; let count = 0;
  const { app, base, send, advance } = await fixture(t, { serverChanFetch: async () => { count++; return fail ? new Response(JSON.stringify({ code: 40001, message: `https://sctapi.ftqq.com/${fakeKey}.send` }), { headers: { 'Content-Type': 'application/json' } }) : accepted(); } });
  await send('/api/tasks', taskInput('甲负责人'));
  assert.equal((await send('/api/serverchan/settings', { sendKey: fakeKey, enabled: true }, 'PATCH')).status, 200);
  const response = await send('/api/run'); assert.equal(response.status, 200);
  const run = await response.json(); assert.equal(run.reminded, 1); assert.equal(run.serverchan.sent, false);
  assert.equal(app.store.state().reminders.length, 1); assert.equal(count, 1);
  assert.doesNotMatch(JSON.stringify(run), new RegExp(fakeKey));
  advance(61_000); await send('/api/run'); assert.equal(count, 1);
  const status = await (await fetch(base + '/api/state')).json(); assert.equal(status.serverchan.latest.status, 'failed');
  fail = false;
  const retried = await (await send('/api/serverchan/send', { retry: true })).json();
  assert.equal(retried.result.sent, true); assert.equal(count, 2); assert.equal(retried.serverchan.latest.attempts, 2);
});

test('环境密钥优先，页面不能覆盖或清除，测试推送只发送固定测试内容', async t => {
  const { calls, send, base } = await fixture(t, { serverChanSendKey: fakeKey });
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.serverchan.keySource, 'environment'); assert.doesNotMatch(JSON.stringify(state), new RegExp(fakeKey));
  assert.equal((await send('/api/serverchan/settings', { sendKey: 'SCTANOTHER12345678' }, 'PATCH')).status, 409);
  assert.equal((await send('/api/serverchan/settings', { clearSendKey: true }, 'PATCH')).status, 409);
  const tested = await (await send('/api/serverchan/test')).json();
  assert.equal(tested.result.sent, true); assert.match(tested.result.message, /受理/); assert.equal(calls.length, 1);
  const body = new URLSearchParams(calls[0].init.body);
  assert.match(body.get('title'), /测试/); assert.doesNotMatch(body.get('desp'), /待交付事项/);
});
