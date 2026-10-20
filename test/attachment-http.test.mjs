import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';

const now = () => new Date('2026-10-20T03:00:00Z');
const contents = '虚构交付正文，仅用于材料删除验收。';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'office-attachment-http-'));
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir: dir, seedDemo: false, scheduler: 'external', serverChanSendKey: '', now });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const send = (path, body = {}, method = 'POST', headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  const { task } = await (await send('/api/tasks', { title: '材料管理验收', owner: '经办人', startDate: '2026-10-19', dueDate: '2026-10-20', deliverable: '提交经核对的文本。' })).json();
  const completed = await send(`/api/tasks/${task.id}/complete`, { confirmed: true, files: [{ name: '成果.txt', contentBase64: Buffer.from(contents).toString('base64') }] });
  const finished = (await completed.json()).task;
  const fileId = finished.attachments[0].id;
  return { app, base, send, taskId: task.id, fileId, filePath: `/api/attachments/${fileId}` };
}

test('材料删除与恢复使用同源 JSON 校验，错误请求不改变文件和任务', async t => {
  const { base, send, taskId, filePath } = await fixture(t);
  for (const [path, method] of [[filePath, 'DELETE'], [filePath + '/restore', 'POST']]) {
    assert.equal((await send(path, {}, method, { Origin: 'https://other.invalid' })).status, 403);
    assert.equal((await send(path, {}, method, { 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await send(path, {}, method, { 'Content-Type': 'text/plain' })).status, 415);
  }
  assert.equal((await send('/api/attachments/missing', {}, 'DELETE')).status, 404);
  assert.equal((await send('/api/attachments/missing/restore')).status, 404);
  assert.equal((await send(filePath + '/restore')).status, 409);
  assert.equal(await (await fetch(base + filePath)).text(), contents);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.tasks.find(value => value.id === taskId).status, '已完成');
  assert.equal(state.tasks[0].deletedAttachments.length, 0);
});

test('删除最后材料停止下载并重开任务，恢复文件不绕过重新提交，任务回收站隔离操作', async t => {
  const { base, send, taskId, fileId, filePath } = await fixture(t);
  const removed = await send(filePath, {}, 'DELETE');
  assert.equal(removed.status, 200);
  const result = await removed.json();
  assert.equal(result.deleted, true); assert.equal(result.attachmentId, fileId); assert.equal(result.reopened, true);
  assert.equal(result.task.status, '进行中'); assert.equal(result.task.completedAt, null);
  assert.equal(result.task.attachments.length, 0); assert.equal(result.task.deletedAttachments[0].id, fileId);
  assert.equal((await fetch(base + filePath)).status, 404);
  assert.equal((await send(filePath, {}, 'DELETE')).status, 409);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(contents), false); assert.equal(serialized.includes('contentBase64'), false);
  assert.equal(Object.hasOwn(result.task.deletedAttachments[0], 'content'), false);
  const restored = await send(filePath + '/restore');
  assert.equal(restored.status, 200);
  const restoredTask = (await restored.json()).task;
  assert.equal(restoredTask.status, '进行中'); assert.equal(restoredTask.deletedAttachments.length, 0);
  assert.equal((await send(`/api/tasks/${taskId}`, { status: '已完成' }, 'PATCH')).status, 400);
  const download = await fetch(base + filePath);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await download.text(), contents);
  assert.equal((await send(`/api/tasks/${taskId}`, {}, 'DELETE')).status, 200);
  assert.equal((await send(filePath, {}, 'DELETE')).status, 404);
  assert.equal((await send(filePath + '/restore')).status, 404);
  assert.equal((await send(`/api/tasks/${taskId}/restore`)).status, 200);
  assert.equal((await send(filePath, {}, 'DELETE')).status, 200);
  assert.equal((await send(`/api/tasks/${taskId}`, {}, 'DELETE')).status, 200);
  assert.equal((await send(filePath + '/restore')).status, 404);
  assert.equal((await send(`/api/tasks/${taskId}/restore`)).status, 200);
  const state = await (await fetch(base + '/api/state')).json();
  const task = state.tasks.find(value => value.id === taskId);
  assert.equal(task.attachments.length, 0); assert.equal(task.deletedAttachments[0].id, fileId);
  assert.ok(state.events.some(event => event.action === '删除材料'));
  assert.ok(state.events.some(event => event.action === '恢复材料'));
});
