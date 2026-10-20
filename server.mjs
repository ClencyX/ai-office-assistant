import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OfficeStore } from './lib/office.mjs';
import { InputError } from './lib/csv.mjs';
import { ServerChanService } from './lib/serverchan.mjs';
import { AiService } from './lib/ai.mjs';
import { createDocx, extractTextFile } from './lib/ai-files.mjs';

const projectDir = dirname(fileURLToPath(import.meta.url));
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

function json(response, status, payload) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(payload)); }
function safeEqual(expected, actual) { if (!expected || typeof actual !== 'string') return false; const a = Buffer.from(expected); const b = Buffer.from(actual); return a.length === b.length && timingSafeEqual(a, b); }
function checkWrite(request, automationKey, isAutomation) {
  if (isAutomation) {
    if (!automationKey) throw new InputError('工作流调度尚未配置密钥。', 403);
    if (!safeEqual(automationKey, request.headers['x-automation-key'])) throw new InputError('工作流调度密钥不正确。', 403);
  } else {
    const origin = request.headers.origin; const site = request.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') throw new InputError('不允许跨来源修改数据。', 403);
    if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) throw new InputError('不允许跨来源修改数据。', 403);
  }
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] || '')) throw new InputError('请使用 JSON 格式提交数据。', 415);
}

async function readJson(request, limit = 2 * 1024 * 1024) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > limit) throw new InputError(`请求内容过大，本接口每次不超过 ${limit / 1024 / 1024} MB。`, 413); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new InputError('JSON 内容格式不正确。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('请求内容必须是 JSON 对象。');
  return body;
}

export function createApplication(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT || 3080);
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? join(projectDir, 'data'));
  const scheduler = options.scheduler ?? process.env.SCHEDULER ?? 'internal';
  const automationKey = options.automationKey ?? process.env.AUTOMATION_KEY ?? '';
  const publicDir = resolve(options.publicDir ?? join(projectDir, 'public'));
  const store = new OfficeStore({ databasePath: join(dataDir, 'office.sqlite'), seedDemo: options.seedDemo ?? process.env.SEED_DEMO !== '0', scheduler, ...(options.now ? { now: options.now } : {}) });
  const serverchan = new ServerChanService({ store, dataDir, sendKey: options.serverChanSendKey ?? process.env.SERVERCHAN_SENDKEY ?? '', ...(options.serverChanFetch ? { fetchImpl: options.serverChanFetch } : {}), ...(options.serverChanTimeoutMs ? { timeoutMs: options.serverChanTimeoutMs } : {}) });
  const ai = new AiService({ store, dataDir, ...(options.aiFetch ? { fetchImpl: options.aiFetch } : {}), ...(options.aiTimeoutMs ? { timeoutMs: options.aiTimeoutMs } : {}) });
  let timer; let closed = false;
  const runTasks = async actor => ({ ...store.run(actor), serverchan: await serverchan.runScheduled() });
  const localNames = new Set(['localhost', '127.0.0.1', '[::1]', ...(host === '0.0.0.0' || host === '::' ? [] : [host])]);
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      let url; try { url = new URL(request.url, `http://${request.headers.host || 'localhost'}`); } catch { throw new InputError('请求地址格式不正确。'); }
      const pathname = url.pathname; const method = request.method; const isAutomation = pathname === '/api/automation/run';
      // Local browser routes do not accept arbitrary Host values, preventing DNS rebinding.
      if (!isAutomation && !localNames.has(url.hostname)) throw new InputError('请通过本机地址访问平台。', 403);
      if (pathname.startsWith('/api/')) {
        if (method === 'GET') {
          if (pathname === '/api/health') return json(response, 200, { ok: true });
          if (pathname === '/api/state') return json(response, 200, { ...store.state(), serverchan: serverchan.snapshot() });
          if (pathname === '/api/serverchan') return json(response, 200, { serverchan: serverchan.snapshot() });
          if (pathname === '/api/ai') return json(response, 200, ai.state());
          const aiMaterial = pathname.match(/^\/api\/ai\/materials\/([^/]+)$/);
          if (aiMaterial) return json(response, 200, { material: ai.getMaterial(decodeURIComponent(aiMaterial[1])) });
          const aiDocument = pathname.match(/^\/api\/ai\/documents\/([^/]+)(\/export)?$/);
          if (aiDocument) {
            const id = decodeURIComponent(aiDocument[1]);
            if (!aiDocument[2]) return json(response, 200, { document: ai.getDocument(id) });
            const format = url.searchParams.get('format') || 'docx';
            if (!['docx', 'md'].includes(format)) throw new InputError('成稿支持 Word 和 Markdown 格式。');
            const document = ai.exportDocument(id);
            const name = `${document.title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '已确认文档'}.${format}`;
            const content = format === 'docx' ? createDocx(document.title, document.content) : Buffer.from(document.content, 'utf8');
            response.writeHead(200, { 'Content-Type': format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown; charset=utf-8', 'Content-Length': content.length, 'Content-Disposition': `attachment; filename="document.${format}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`, 'Cache-Control': 'no-store' });
            return response.end(content);
          }
          if (pathname === '/api/trash') return json(response, 200, store.trash());
          const attachmentMatch = pathname.match(/^\/api\/attachments\/([^/]+)$/);
          if (attachmentMatch) {
            const file = store.getAttachment(decodeURIComponent(attachmentMatch[1]));
            response.writeHead(200, { 'Content-Type': file.mimeType, 'Content-Length': file.size, 'Content-Disposition': `attachment; filename="download${extname(file.name).toLowerCase()}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`, 'Cache-Control': 'no-store' });
            return response.end(file.content);
          }
          if (pathname === '/api/export/tasks') {
            response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tasks.csv"; filename*=UTF-8''${encodeURIComponent('任务台账.csv')}`, 'Cache-Control': 'no-store' }); return response.end(store.exportTasks());
          }
          if (pathname === '/api/backup') {
            const temporary = await mkdtemp(join(tmpdir(), 'office-backup-'));
            try {
              const backupPath = join(temporary, 'office.sqlite'); store.createBackup(backupPath); const data = await readFile(backupPath);
              response.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': `attachment; filename="office-backup.sqlite"; filename*=UTF-8''${encodeURIComponent('办公平台备份.sqlite')}`, 'Cache-Control': 'no-store' }); response.end(data);
            } finally { await rm(temporary, { recursive: true, force: true }); }
            return;
          }
          throw new InputError('未找到该接口。', 404);
        }
        if (!['POST', 'PATCH', 'DELETE'].includes(method)) throw new InputError('不支持该请求方式。', 405);
        const completeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/complete$/);
        checkWrite(request, automationKey, isAutomation); const body = await readJson(request, method === 'POST' && completeMatch ? 36 * 1024 * 1024 : method === 'POST' && pathname === '/api/ai/transcribe' ? 29 * 1024 * 1024 : 2 * 1024 * 1024);
        if (method === 'PATCH' && pathname === '/api/ai/settings') return json(response, 200, { settings: ai.updateSettings(body) });
        if (method === 'POST' && pathname === '/api/ai/test') return json(response, 200, await ai.testConnection(body));
        if (method === 'POST' && pathname === '/api/ai/import') return json(response, 200, extractTextFile(body.file));
        if (method === 'POST' && pathname === '/api/ai/transcribe') return json(response, 200, await ai.transcribe(body));
        if (method === 'POST' && pathname === '/api/ai/templates/analyze') return json(response, 200, { suggestion: await ai.analyzeTemplate(body) });
        if (method === 'POST' && pathname === '/api/ai/templates') return json(response, 201, { template: ai.saveTemplate(body) });
        const aiTemplateMatch = pathname.match(/^\/api\/ai\/templates\/([^/]+)$/);
        if (method === 'PATCH' && aiTemplateMatch) return json(response, 200, { template: ai.saveTemplate(body, decodeURIComponent(aiTemplateMatch[1])) });
        if (method === 'POST' && pathname === '/api/ai/materials') return json(response, 201, { material: ai.saveMaterial(body) });
        const aiMaterialMatch = pathname.match(/^\/api\/ai\/materials\/([^/]+)$/);
        if (method === 'PATCH' && aiMaterialMatch) return json(response, 200, { material: ai.saveMaterial(body, decodeURIComponent(aiMaterialMatch[1])) });
        if (method === 'DELETE' && aiMaterialMatch) return json(response, 200, ai.deleteMaterial(decodeURIComponent(aiMaterialMatch[1])));
        if (method === 'POST' && pathname === '/api/ai/documents') return json(response, 201, { document: await ai.generate(body) });
        const aiDocumentMatch = pathname.match(/^\/api\/ai\/documents\/([^/]+)(\/review)?$/);
        if (aiDocumentMatch && !aiDocumentMatch[2] && method === 'PATCH') return json(response, 200, { document: ai.updateDocument(decodeURIComponent(aiDocumentMatch[1]), body) });
        if (aiDocumentMatch?.[2] && method === 'POST') return json(response, 200, { document: ai.reviewDocument(decodeURIComponent(aiDocumentMatch[1]), body) });
        if (method === 'POST' && completeMatch) return json(response, 200, { task: store.completeTask(decodeURIComponent(completeMatch[1]), body) });
        const attachmentMutationMatch = pathname.match(/^\/api\/attachments\/([^/]+)(\/restore)?$/);
        if (method === 'DELETE' && attachmentMutationMatch && !attachmentMutationMatch[2]) return json(response, 200, store.deleteAttachment(decodeURIComponent(attachmentMutationMatch[1])));
        if (method === 'POST' && attachmentMutationMatch?.[2]) return json(response, 200, store.restoreAttachment(decodeURIComponent(attachmentMutationMatch[1])));
        if (method === 'PATCH' && pathname === '/api/serverchan/settings') return json(response, 200, { serverchan: serverchan.updateSettings(body) });
        if (method === 'POST' && pathname === '/api/serverchan/test') return json(response, 200, { result: await serverchan.sendTest(), serverchan: serverchan.snapshot() });
        if (method === 'POST' && pathname === '/api/serverchan/send') {
          if (Object.hasOwn(body, 'retry') && typeof body.retry !== 'boolean') throw new InputError('重试参数必须为布尔值。');
          return json(response, 200, { result: await serverchan.sendToday({ retry: body.retry === true }), serverchan: serverchan.snapshot() });
        }
        if (method === 'POST' && pathname === '/api/tasks') return json(response, 201, { task: store.createTask(body) });
        const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if (method === 'PATCH' && taskMatch) return json(response, 200, { task: store.updateTask(decodeURIComponent(taskMatch[1]), body) });
        if (method === 'DELETE' && taskMatch) return json(response, 200, store.deleteTask(decodeURIComponent(taskMatch[1])));
        const restoreMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/restore$/);
        if (method === 'POST' && restoreMatch) return json(response, 200, { task: store.restoreTask(decodeURIComponent(restoreMatch[1])) });
        if (method === 'POST' && pathname === '/api/templates') return json(response, 201, { template: store.createTemplate(body) });
        if (method === 'POST' && pathname === '/api/templates/import') return json(response, 200, store.importTemplates(body));
        const templateMatch = pathname.match(/^\/api\/templates\/([^/]+)$/);
        if (method === 'PATCH' && templateMatch) return json(response, 200, { template: store.updateTemplate(decodeURIComponent(templateMatch[1]), body) });
        if (method === 'POST' && pathname === '/api/reminders/read') return json(response, 200, store.readReminders(body));
        if (method === 'PATCH' && pathname === '/api/settings') return json(response, 200, store.updateSettings(body));
        if (method === 'POST' && (pathname === '/api/run' || isAutomation)) return json(response, 200, await runTasks(isAutomation ? '工作流调度' : store.settings().adminName));
        throw new InputError('未找到该接口。', 404);
      }
      if (!['GET', 'HEAD'].includes(method)) throw new InputError('不支持该请求方式。', 405);
      let decoded; try { decoded = decodeURIComponent(pathname); } catch { throw new InputError('请求地址编码不正确。'); }
      if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) throw new InputError('无法访问该路径。', 404);
      let target = resolve(publicDir, `.${decoded === '/' ? '/index.html' : decoded}`);
      const inside = relative(publicDir, target); if (inside.startsWith('..') || isAbsolute(inside)) throw new InputError('无法访问该路径。', 404);
      let info;
      try {
        const actualRoot = await realpath(publicDir); const actualPath = await realpath(target); const actualRelative = relative(actualRoot, actualPath);
        if (actualRelative.startsWith('..') || isAbsolute(actualRelative)) throw new InputError('无法访问该路径。', 404);
        target = actualPath; info = await stat(target);
      } catch { throw new InputError('未找到页面或文件。', 404); }
      if (!info.isFile()) throw new InputError('未找到页面或文件。', 404);
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (method === 'HEAD') return response.end();
      createReadStream(target).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof InputError) return json(response, error.status, { error: error.message });
      console.error('请求处理失败：', error); json(response, 500, { error: '服务处理失败，请稍后重试或查看本地日志。' });
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  return {
    server, store, serverchan, ai, host, port, dataDir,
    async start() {
      store.run();
      await new Promise((resolveStart, rejectStart) => { server.once('error', rejectStart); server.listen(port, host, () => { server.removeListener('error', rejectStart); resolveStart(); }); });
      await serverchan.runScheduled();
      if (scheduler !== 'external') { timer = setInterval(() => { runTasks().catch(error => console.error('自动检查失败：', error instanceof InputError ? error.message : '请检查本地服务状态。')); }, 60_000); timer.unref(); }
      return server.address();
    },
    async close() {
      if (closed) return; closed = true; clearInterval(timer);
      const closingServer = server.listening ? new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())) : Promise.resolve();
      await Promise.all([serverchan.close(), ai.close()]);
      await closingServer;
      store.close();
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let application;
  try {
    application = createApplication();
    const address = await application.start();
    console.log(`AI 辅助办公应用平台已启动：http://127.0.0.1:${address.port}`);
    console.log(`数据目录：${application.dataDir}`);
    console.log(`调度方式：${application.store.scheduler === 'external' ? '工作流调度' : '本地定时器'}`);
    let exiting = false;
    const stop = async () => { if (exiting) return; exiting = true; await application.close(); process.exitCode = 0; };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请关闭重复运行的平台或修改 PORT。' : `启动失败：${error.message}`);
    await application?.close(); process.exitCode = 1;
  }
}
