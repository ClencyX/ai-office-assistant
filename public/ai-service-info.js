export function modelService(settings = {}, target = 'text') {
  if (target === 'text') return { baseUrl: settings.baseUrl || '', model: settings.model || '', provider: 'text' };
  const provider = settings[`${target}Provider`] || 'shared';
  return { provider, baseUrl: provider === 'shared' ? settings.baseUrl || '' : settings[`${target}BaseUrl`] || '', model: settings[`${target}Model`] || (target === 'vision' && provider === 'shared' ? settings.model || '' : '') };
}

export function jobProgress(progress = {}) {
  if (progress.phase === 'preparing') return '正在本机转换并分段录音…';
  if (progress.phase === 'transcribing') return progress.total ? `正在转写录音：已完成 ${progress.completed} / ${progress.total} 段…` : '正在转写录音…';
  if (progress.phase === 'saving') return '正在保存识别文字…';
  return '正在后台识别资料，请稍候…';
}

export async function runAiJob(api, path, body, onProgress = () => {}) {
  let { job } = await api(path, { method: 'POST', body: JSON.stringify(body) });
  while (job.state === 'running') {
    onProgress(jobProgress(job.progress));
    await new Promise(resolve => setTimeout(resolve, 1000));
    try { ({ job } = await api(`/api/ai/jobs/${encodeURIComponent(job.id)}`)); }
    catch (error) { throw new Error(`读取转写进度失败，后台任务可能仍在处理。请返回任务后重新查看，避免重复上传。${error.message}`); }
  }
  if (job.state !== 'succeeded') {
    const error = new Error(job.error || '录音处理未完成，原件仍保留，请检查后手动重试。');
    error.partialText = job.partialText || '';
    throw error;
  }
  return job.result;
}
