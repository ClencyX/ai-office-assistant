import { randomUUID } from 'node:crypto';
import { InputError } from './csv.mjs';

const ttlMs = 60 * 60 * 1000;
const maxJobs = 20;
const phases = new Set(['queued', 'preparing', 'transcribing', 'recognizing', 'extracting', 'saving', 'processing']);
const closedMessage = 'AI 服务正在关闭，本次识别任务已中断。';
const failedMessage = '识别任务未能完成，请检查服务配置和文件后手动重试。';

// Only short-lived results and progress live here. Keys, callbacks and promises are
// private bookkeeping and are never included in the objects returned to the client.
export class AiJobs {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.jobs = new Map();
    this.running = null;
    this.closed = false;
  }

  milliseconds() { return Number(this.now()); }

  prune() {
    const current = this.milliseconds();
    for (const [id, job] of this.jobs) {
      if (job.state !== 'running' && current - job.updatedMs >= ttlMs) this.jobs.delete(id);
    }
  }

  snapshot(job) {
    const value = {
      id: job.id, state: job.state, progress: { ...job.progress },
      createdAt: job.createdAt, updatedAt: job.updatedAt,
      ...(job.taskId ? { taskId: job.taskId } : {})
    };
    if (job.state === 'succeeded' && job.result !== undefined) value.result = structuredClone(job.result);
    if (job.state === 'failed') {
      value.error = job.error;
      if (job.partialText) value.partialText = job.partialText;
    }
    return value;
  }

  get(id) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw new InputError('未找到识别任务，任务可能已过期，请重新提交。', 404);
    return this.snapshot(job);
  }

  start({ key, taskId, run } = {}) {
    if (this.closed) throw new InputError('AI 任务服务正在关闭，请稍后重试。', 503);
    if (typeof key !== 'string' || !key || key.length > 500 || /[\u0000-\u001f]/.test(key)) throw new InputError('识别任务标识无效。');
    if (typeof run !== 'function') throw new InputError('识别任务缺少处理方法。');
    if (taskId !== undefined && (typeof taskId !== 'string' || !taskId || taskId.length > 100 || /[\u0000-\u001f]/.test(taskId))) throw new InputError('关联任务标识无效。');
    this.prune();
    if (this.running) {
      if (this.running.key === key) return this.snapshot(this.running);
      throw new InputError('已有识别任务正在处理，请等待完成后再试。', 409);
    }
    while (this.jobs.size >= maxJobs) {
      const oldest = [...this.jobs.values()].find(job => job.state !== 'running');
      if (!oldest) throw new InputError('识别任务数量已达上限，请稍后重试。', 409);
      this.jobs.delete(oldest.id);
    }
    const current = this.milliseconds(), timestamp = new Date(current).toISOString();
    const job = {
      id: randomUUID(), key, taskId, state: 'running',
      progress: { phase: 'queued', completed: 0, total: 0 },
      createdAt: timestamp, updatedAt: timestamp, updatedMs: current,
      partialText: '', promise: null
    };
    this.jobs.set(job.id, job);
    this.running = job;
    const touch = () => { job.updatedMs = this.milliseconds(); job.updatedAt = new Date(job.updatedMs).toISOString(); };
    const onProgress = value => {
      if (this.closed || job.state !== 'running' || !value || typeof value !== 'object') return;
      const progress = { ...job.progress };
      if (phases.has(value.phase)) progress.phase = value.phase;
      for (const field of ['completed', 'total']) if (Number.isSafeInteger(value[field]) && value[field] >= 0) progress[field] = value[field];
      job.progress = progress;
      if (typeof value.text === 'string' && value.text.length <= 60000 && !value.text.includes('\u0000')) job.partialText = value.text;
      touch();
    };
    // The caller receives a running snapshot before any model call starts.
    job.promise = Promise.resolve().then(async () => {
      try {
        if (this.closed) throw new InputError(closedMessage, 503);
        const result = await run(onProgress);
        if (this.closed) throw new InputError(closedMessage, 503);
        // Reject non-JSON results before publishing a successful terminal state.
        job.result = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        job.state = 'succeeded';
        job.partialText = '';
      } catch (error) {
        job.state = 'failed';
        job.error = this.closed ? closedMessage : error instanceof InputError && typeof error.message === 'string' && error.message.length <= 2000 ? error.message : failedMessage;
      } finally {
        touch();
        if (this.running === job) this.running = null;
      }
    });
    return this.snapshot(job);
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise).filter(Boolean));
  }
}
