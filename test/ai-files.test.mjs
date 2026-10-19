import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocx, decodeAudioFile, extractTextFile } from '../lib/ai-files.mjs';
import { validateFiles } from '../lib/attachments.mjs';

const file = (name, content) => ({ name, contentBase64: Buffer.from(content).toString('base64') });

test('文本素材识别中文、万国码编码与行尾，并限制扩展名、正文和编码', () => {
  assert.deepEqual(extractTextFile(file('会议记录.txt', '\uFEFF会议日期：2026年10月20日\r\n参会：甲、乙')), { title: '会议记录', content: '会议日期：2026年10月20日\n参会：甲、乙' });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('会议记录：不得虚构结论', 'utf16le')]);
  assert.match(extractTextFile(file('转写稿.md', utf16)).content, /不得虚构/);
  assert.throws(() => extractTextFile(file('旧文档.doc', '普通文本')), /支持/);
  assert.throws(() => extractTextFile(file('../资料.txt', '正文')), /文件名/);
  assert.throws(() => extractTextFile(file('空记录.txt', '  \r\n ')), /有效正文/);
  assert.throws(() => extractTextFile(file('二进制.txt', Buffer.alloc(12))), /有效正文/);
  assert.throws(() => extractTextFile(file('过长.txt', '字'.repeat(20001))), /20000/);
  assert.throws(() => extractTextFile(file('过大.txt', Buffer.alloc(1024 * 1024 + 1))), /1 MB/);
  assert.throws(() => extractTextFile({ name: '损坏.txt', contentBase64: 'YQ=' }), /编码/);
});

test('本地导出真实 Word，标题、表格、特殊字符可重新作为素材和任务交付材料', () => {
  const body = '# 月度纪要\n\n## 一、决定\n材料包含 <标签>、&符号和“中文”。\n\n| 事项 | 负责人 |\n| --- | --- |\n| 核对数据 | 甲 |\n\n## 待核实事项\n- 日期待核实。';
  const output = createDocx('月度纪要', body);
  assert.equal(output.readUInt32LE(0), 0x04034b50);
  assert.equal(validateFiles([file('月度纪要.docx', output)], '文本')[0].size, output.length);
  const imported = extractTextFile(file('月度纪要.docx', output));
  assert.match(imported.content, /月度纪要/);
  assert.match(imported.content, /<标签>、&符号和“中文”/);
  assert.match(imported.content, /核对数据/);
  assert.match(imported.content, /负责人/);
  assert.match(imported.content, /日期待核实/);
  assert.doesNotMatch(imported.content, /w:tbl|&amp;|&lt;/);
});

test('损坏 ZIP、伪 Word 和放大的解压声明均拒绝，不产生磁盘文件', () => {
  assert.throws(() => extractTextFile(file('伪装.docx', '会议记录')), /损坏/);
  const output = createDocx('纪要', '正文');
  const truncated = output.subarray(0, output.length - 12);
  assert.throws(() => extractTextFile(file('损坏.docx', truncated)), /损坏/);
  const wrongChecksum = Buffer.from(output); wrongChecksum[50] ^= 0xff;
  assert.throws(() => extractTextFile(file('校验错误.docx', wrongChecksum)), /损坏/);
  const huge = Buffer.from(output), directory = huge.readUInt32LE(huge.length - 6);
  huge.writeUInt32LE(100 * 1024 * 1024, directory + 24);
  assert.throws(() => extractTextFile(file('巨大声明.docx', huge)), /损坏/);
});

test('录音仅在文件名、大小和基本签名通过时进入真实转写请求', () => {
  const wave = Buffer.alloc(44); wave.write('RIFF'); wave.write('WAVE', 8);
  const audio = decodeAudioFile(file('例会.wav', wave));
  assert.equal(audio.name, '例会.wav'); assert.equal(audio.mimeType, 'audio/wav'); assert.deepEqual(audio.content, wave);
  assert.throws(() => decodeAudioFile(file('伪装.mp3', '普通文字冒充音频')), /格式无效/);
  assert.throws(() => decodeAudioFile(file('程序.exe', wave)), /格式无效/);
  assert.throws(() => decodeAudioFile(file('过大.mp3', Buffer.alloc(20 * 1024 * 1024 + 1))), /20 MB/);
});
