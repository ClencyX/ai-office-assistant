import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync as readFileSyncSegment } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError } from './csv.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workRoot = join(projectDir, 'data', 'audio-work');
const toolsRoot = resolve(projectDir, '..', '工具', 'ffmpeg');
const maxDuration = 4 * 60 * 60;
const segmentSeconds = 180;

function binary(name) {
  const configured = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (configured) return configured;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (existsSync(join(toolsRoot, exe))) return join(toolsRoot, exe);
  if (existsSync(toolsRoot)) for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('ffmpeg-')) {
      const candidate = join(toolsRoot, entry.name, 'bin', exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}
function runTool(name, args, { signal, timeoutMs = 60000 } = {}) {
  return new Promise((resolveRun, reject) => {
    if (signal?.aborted) return reject(new InputError('录音处理已取消。', 503));
    const child = spawn(binary(name), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    const chunks = []; let bytes = 0, settled = false, stopError = null;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolveRun(value);
    };
    const abort = () => { stopError = new InputError('录音处理已取消。', 503); child.kill(); };
    const timer = setTimeout(() => { stopError = new InputError('本机录音处理超时，原件仍保留，请检查录音后重试。', 504); child.kill(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) { child.kill(); finish(new InputError('音频工具返回数据超过限制。', 502)); } else chunks.push(chunk); });
    child.on('error', error => finish(new InputError(error.code === 'ENOENT' ? '长录音处理需要 FFmpeg 和 FFprobe。请按使用说明安装音频工具后重试。' : '无法启动本机音频工具，请检查工具路径和文件权限。', 503)));
    child.on('close', code => finish(stopError || (code === 0 ? null : new InputError('无法读取或转换录音，请确认录音可正常播放且包含音轨。', 400)), Buffer.concat(chunks).toString('utf8')));
  });
}

function wavDuration(content) {
  if (content.length < 44 || content.toString('ascii', 0, 4) !== 'RIFF' || content.toString('ascii', 8, 12) !== 'WAVE') return null;
  if (content.readUInt32LE(4) + 8 !== content.length) return null;
  let offset = 12, rate = 0, data = 0, alignment = 0;
  while (offset + 8 <= content.length) {
    const size = content.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > content.length) return null;
    const kind = content.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ' && size >= 16) {
      const codec = content.readUInt16LE(start), channels = content.readUInt16LE(start + 2), sampleRate = content.readUInt32LE(start + 4), bits = content.readUInt16LE(start + 14);
      alignment = content.readUInt16LE(start + 12); rate = content.readUInt32LE(start + 8);
      if (codec !== 1 || channels < 1 || channels > 8 || !sampleRate || ![8,16,24,32].includes(bits) || alignment !== channels * bits / 8 || rate !== sampleRate * alignment) return null;
    }
    if (kind === 'data') data += size;
    offset = start + size + size % 2;
  }
  return rate > 0 && data > 0 && data % alignment === 0 ? data / rate : null;
}

// The CLI receives only a locally generated path and fixed options. Network protocols
// are disabled: uploaded media cannot instruct FFmpeg to fetch a remote resource.
export async function prepareAudioSegments(file, { signal, onProgress = () => {} } = {}) {
  if (signal?.aborted) throw new InputError('录音处理已取消。', 503);
  if (file.content.length > 100 * 1024 * 1024) throw new InputError('录音原件不能超过 100MB。');
  const knownDuration = file.mimeType === 'audio/wav' ? wavDuration(file.content) : null;
  if (knownDuration && knownDuration > maxDuration) throw new InputError('录音最长支持 4 小时，请先拆分较长会议。');
  if (knownDuration && knownDuration <= segmentSeconds && file.content.length <= 7 * 1024 * 1024) {
    return { durationSeconds: knownDuration, segments: [{ ...file, startSeconds: 0, endSeconds: knownDuration }], cleanup: async () => {} };
  }
  await mkdir(workRoot, { recursive: true });
  const directory = await mkdtemp(join(workRoot, 'meeting-'));
  const cleanup = async () => {
    const target = resolve(directory);
    if (!target.startsWith(resolve(workRoot) + sep) || !target.slice(resolve(workRoot).length + 1).startsWith('meeting-')) throw new Error('无效的录音临时目录。');
    await rm(target, { recursive: true, force: true });
  };
  try {
    onProgress({ phase: 'preparing', completed: 0, total: 0 });
    const input = join(directory, `input${extname(file.name).toLowerCase()}`);
    await writeFile(input, file.content);
    const format = { '.mp3': 'mp3', '.wav': 'wav', '.m4a': 'mov', '.mp4': 'mov', '.webm': 'matroska', '.ogg': 'ogg', '.flac': 'flac' }[extname(file.name).toLowerCase()];
    if (!format) throw new InputError('此录音格式暂不支持本机分段。');
    const probe = await runTool('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', format, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', input], { signal });
    let details; try { details = JSON.parse(probe); } catch { throw new InputError('无法读取录音时长。'); }
    const durationSeconds = Number(details.format?.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !details.streams?.some(s => s.codec_type === 'audio')) throw new InputError('录音时长无效，或文件没有可识别音轨。');
    if (durationSeconds > maxDuration) throw new InputError('录音最长支持 4 小时，请先拆分较长会议。');
    await runTool('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-f', format, '-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-af', 'aresample=16000,asetnsamples=n=16000:p=0', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', String(segmentSeconds), '-reset_timestamps', '1', join(directory, 'segment-%04d.wav')], { signal, timeoutMs: 10 * 60 * 1000 });
    const names = readdirSync(directory).filter(name => /^segment-\d{4}\.wav$/.test(name)).sort();
    if (!names.length || names.length > Math.ceil(maxDuration / segmentSeconds) + 1) throw new InputError('音频分段数量无效。');
    // Segment bytes are loaded lazily by the consumer, keeping long meetings off the heap.
    const segments = [];
    for (let i = 0; i < names.length; i++) {
      if (signal?.aborted) throw new InputError('录音处理已取消。', 503);
      segments.push({ name: names[i], mimeType: 'audio/wav', path: join(directory, names[i]), startSeconds: i * segmentSeconds, endSeconds: Math.min((i + 1) * segmentSeconds, durationSeconds), get content() { return readFileSyncSegment(this.path); } });
    }
    return { durationSeconds, segments, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
