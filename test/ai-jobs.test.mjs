import test from 'node:test';
import assert from 'node:assert/strict';
import { AiJobs } from '../lib/ai-jobs.mjs';
import { InputError } from '../lib/csv.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('异步任务先返回再启动，相同运行标识复用、其他标识拒绝，成功快照不暴露内部对象', async t => {
  const jobs = new AiJobs(); t.after(() => jobs.close());
  const gate = deferred(); let started = 0, progress;
  const job = jobs.start({ key: 'private-key-do-not-publish', taskId: 'task-one', run: notify => { started++; progress = notify; return gate.promise; } });
  assert.equal(started, 0); assert.equal(job.state, 'running'); assert.equal(job.progress.phase, 'queued');
  const duplicate = jobs.start({ key: 'private-key-do-not-publish', taskId: 'task-one', run: () => { throw new Error('must not run'); } });
  assert.equal(duplicate.id, job.id);
  assert.throws(() => jobs.start({ key: 'other', run: async () => 'unused' }), error => error.status === 409);
  await tick(); assert.equal(started, 1);
  progress({ phase: 'transcribing', completed: 1, total: 2, text: '不可在运行轮询中返回的中间文字。' });
  const running = jobs.get(job.id);
  assert.equal(running.taskId, 'task-one'); assert.deepEqual(running.progress, { phase: 'transcribing', completed: 1, total: 2 });
  assert.equal(Object.hasOwn(running, 'partialText'), false);
  assert.doesNotMatch(JSON.stringify(running), /private-key|promise|must not run|中间文字/);
  running.progress.total = 999;
  assert.equal(jobs.get(job.id).progress.total, 2);
  gate.resolve({ text: '完整转写。', nested: { count: 2 } }); await tick();
  const done = jobs.get(job.id);
  assert.equal(done.state, 'succeeded'); assert.deepEqual(done.result, { text: '完整转写。', nested: { count: 2 } });
  assert.equal(Object.hasOwn(done, 'partialText'), false);
  done.result.nested.count = 100; assert.equal(jobs.get(job.id).result.nested.count, 2);
  const next = jobs.start({ key: 'other', run: async () => ({ text: '下一次。' }) });
  await tick(); assert.equal(jobs.get(next.id).state, 'succeeded');
});

test('失败保留已完成段文字，仅回显本地 InputError，普通异常不泄露堆栈请求或密钥', async t => {
  const jobs = new AiJobs(); t.after(() => jobs.close());
  const failed = jobs.start({ key: 'audio-one', run: async notify => {
    notify({ phase: 'transcribing', completed: 1, total: 3, text: '第一段已成功转写，可复制恢复。' });
    throw new InputError('语音服务请求未成功，请检查账户额度。', 502);
  } });
  await tick();
  const value = jobs.get(failed.id);
  assert.equal(value.state, 'failed'); assert.equal(value.error, '语音服务请求未成功，请检查账户额度。');
  assert.equal(value.partialText, '第一段已成功转写，可复制恢复。'); assert.equal(Object.hasOwn(value, 'result'), false);
  const secret = 'Bearer sk-synthetic-secret';
  const unknown = jobs.start({ key: 'audio-two', run: () => { const error = new Error(`${secret} request body details`); error.request = { token: secret }; throw error; } });
  await tick();
  const publicFailure = jobs.get(unknown.id);
  assert.equal(publicFailure.state, 'failed'); assert.match(publicFailure.error, /未能完成/);
  assert.doesNotMatch(JSON.stringify(publicFailure), /Bearer|sk-synthetic|request|stack|Error:/);
  assert.equal(Object.hasOwn(publicFailure, 'partialText'), false);
});

test('过期终态 get 返回404，运行任务不会被过期清理，最多保留20份记录', async t => {
  let now = 0;
  const jobs = new AiJobs({ now: () => now }); t.after(() => jobs.close());
  const first = jobs.start({ key: 'first', run: async () => ({ text: '完成' }) }); await tick();
  now = 60 * 60 * 1000;
  assert.throws(() => jobs.get(first.id), error => error.status === 404);
  const gate = deferred();
  const running = jobs.start({ key: 'still-running', run: () => gate.promise }); await tick();
  now += 2 * 60 * 60 * 1000;
  assert.equal(jobs.get(running.id).state, 'running');
  assert.equal(jobs.start({ key: 'still-running', run: async () => 'no' }).id, running.id);
  gate.resolve({ text: '稍后完成。' }); await tick();
  assert.equal(jobs.get(running.id).updatedAt, new Date(now).toISOString());
  const ids = [];
  for (let i = 0; i < 20; i++) {
    now++;
    ids.push(jobs.start({ key: `completed-${i}`, run: async () => ({ text: String(i) }) }).id);
    await tick();
  }
  assert.throws(() => jobs.get(running.id), error => error.status === 404);
  for (const id of ids) assert.equal(jobs.get(id).state, 'succeeded');
});

test('关闭等待运行结束，关闭期间的成功不发布，排队尚未启动的任务不调用模型', async () => {
  const jobs = new AiJobs();
  const gate = deferred();
  const job = jobs.start({ key: 'running', run: () => gate.promise }); await tick();
  let closed = false;
  const closing = jobs.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  assert.throws(() => jobs.start({ key: 'new', run: async () => 'no' }), error => error.status === 503);
  gate.resolve({ text: '不能在关闭后发布为成功。' }); await closing;
  const result = jobs.get(job.id);
  assert.equal(result.state, 'failed'); assert.match(result.error, /关闭|中断/); assert.equal(Object.hasOwn(result, 'result'), false);
  const immediate = new AiJobs(); let invoked = false;
  const queued = immediate.start({ key: 'queued', run: async () => { invoked = true; return {}; } });
  await immediate.close();
  assert.equal(invoked, false); assert.equal(immediate.get(queued.id).state, 'failed');
});

test('错误进度不污染公开结构，终态后回调无效，非 JSON 结果安全失败', async t => {
  const jobs = new AiJobs(); t.after(() => jobs.close());
  let notify;
  const job = jobs.start({ key: 'invalid-result', run: progress => {
    notify = progress;
    progress({ phase: 'Bearer secret', completed: -1, total: Infinity, text: '已完成段。', request: '不得回显' });
    const circular = {}; circular.self = circular; return circular;
  } });
  await tick();
  const failed = jobs.get(job.id);
  assert.equal(failed.state, 'failed'); assert.deepEqual(failed.progress, { phase: 'queued', completed: 0, total: 0 });
  assert.equal(failed.partialText, '已完成段。'); assert.doesNotMatch(JSON.stringify(failed), /Bearer|request|circular/);
  notify({ phase: 'transcribing', completed: 99, total: 99, text: '不应覆盖' });
  assert.deepEqual(jobs.get(job.id), failed);
  assert.throws(() => jobs.start({ key: '', run: async () => {} }), /标识/);
  assert.throws(() => jobs.start({ key: 'valid' }), /处理方法/);
});
