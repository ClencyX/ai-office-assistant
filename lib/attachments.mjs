import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { InputError } from './csv.mjs';

export const submissionTypes = ['文本', '表格', '演示文稿', 'PDF', '图片', '不限'];
const types = {
  '.txt': ['文本', 'text/plain; charset=utf-8'], '.md': ['文本', 'text/markdown; charset=utf-8'],
  '.doc': ['文本', 'application/msword'], '.docx': ['文本', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], '.rtf': ['文本', 'application/rtf'],
  '.csv': ['表格', 'text/csv; charset=utf-8'], '.xls': ['表格', 'application/vnd.ms-excel'], '.xlsx': ['表格', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.ppt': ['演示文稿', 'application/vnd.ms-powerpoint'], '.pptx': ['演示文稿', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.pdf': ['PDF', 'application/pdf'], '.png': ['图片', 'image/png'], '.jpg': ['图片', 'image/jpeg'], '.jpeg': ['图片', 'image/jpeg'], '.webp': ['图片', 'image/webp']
};
const MiB = 1024 * 1024;
export function acceptsFile(name, submissionType) { const entry = types[extname(name).toLowerCase()]; return Boolean(entry && (submissionType === '不限' || entry[0] === submissionType)); }
function invalid(name) { throw new InputError(`“${name}”的文件内容与格式不符，或文件已损坏，请重新选择有效文档。`); }
function validText(data) {
  let text;
  try {
    const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
    text = new TextDecoder(encoding, { fatal: true }).decode(data);
  } catch { try { text = new TextDecoder('gb18030', { fatal: true }).decode(data); } catch { return false; } }
  return Boolean(text.trim()) && !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text);
}
function crc32(data) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
// Read the central directory and decompress only bounded entries; renamed ZIPs are not Office documents.
function officeZip(data, extension) {
  if (data.readUInt32LE(0) !== 0x04034b50) return false;
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) return false;
  const count = data.readUInt16LE(end + 10); const directorySize = data.readUInt32LE(end + 12); let position = data.readUInt32LE(end + 16);
  if (!count || count > 4096 || position + directorySize !== end || data.readUInt16LE(end + 8) !== count) return false;
  const required = { '.docx': ['word/document.xml', 'document'], '.xlsx': ['xl/workbook.xml', 'workbook'], '.pptx': ['ppt/presentation.xml', 'presentation'] }[extension];
  const found = new Set(); let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || data.readUInt32LE(position) !== 0x02014b50) return false;
    const flags = data.readUInt16LE(position + 8); const method = data.readUInt16LE(position + 10); const checksum = data.readUInt32LE(position + 16);
    const packed = data.readUInt32LE(position + 20); const size = data.readUInt32LE(position + 24); const nameLength = data.readUInt16LE(position + 28);
    const name = data.subarray(position + 46, position + 46 + nameLength).toString('utf8'); const local = data.readUInt32LE(position + 42);
    expanded += size;
    if (expanded > 40 * MiB || (flags & 1) || ![0, 8].includes(method) || local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) return false;
    const localNameLength = data.readUInt16LE(local + 26); const start = local + 30 + localNameLength + data.readUInt16LE(local + 28);
    if (start + packed > data.length || data.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name) return false;
    if (name === '[Content_Types].xml' || name === required[0]) {
      if (found.has(name) || size > 20 * MiB) return false;
      const content = method === 0 ? data.subarray(start, start + packed) : inflateRawSync(data.subarray(start, start + packed), { maxOutputLength: Math.max(1, size) });
      if (content.length !== size || crc32(content) !== checksum) return false;
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(content);
      const root = name === '[Content_Types].xml' ? 'Types' : required[1];
      if (!new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${root}(?:\\s|>)`).test(xml)) return false;
      found.add(name);
    }
    position += 46 + nameLength + data.readUInt16LE(position + 30) + data.readUInt16LE(position + 32);
  }
  return position === end && found.size === 2;
}
// Validate the compound-document header and directory stream for classic Office formats.
function officeOle(data, extension) {
  if (data.length < 512 || data.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1' || data.readUInt16LE(28) !== 0xfffe) return false;
  const version = data.readUInt16LE(26); const shift = data.readUInt16LE(30);
  if (!((version === 3 && shift === 9) || (version === 4 && shift === 12)) || data.readUInt16LE(32) !== 6) return false;
  const sectorSize = 1 << shift; const sectorCount = Math.floor(data.length / sectorSize) - 1;
  const fatCount = data.readUInt32LE(44); const difatCount = data.readUInt32LE(72);
  if (data.length % sectorSize || !fatCount || fatCount + difatCount > sectorCount) return false;
  const sector = number => { if (number >= sectorCount) throw new Error('无效扇区'); return data.subarray((number + 1) * sectorSize, (number + 2) * sectorSize); };
  // FAT/DIFAT sectors must be unique physical sectors. Bound the list before
  // concatenating it so repeated IDs cannot multiply a small upload in memory.
  const fatIds = []; const seenFat = new Set();
  let difat = data.readUInt32LE(68); const seenDifat = new Set();
  const addFat = id => {
    if (id === 0xffffffff) return true;
    if (id >= sectorCount || seenFat.has(id) || seenDifat.has(id) || fatIds.length >= fatCount) return false;
    seenFat.add(id); fatIds.push(id); return true;
  };
  for (let i = 0; i < 109; i++) if (!addFat(data.readUInt32LE(76 + i * 4))) return false;
  for (let i = 0; i < difatCount; i++) {
    if (difat >= sectorCount || seenDifat.has(difat) || seenFat.has(difat)) return false; seenDifat.add(difat); const block = sector(difat);
    for (let j = 0; j < sectorSize - 4; j += 4) if (!addFat(block.readUInt32LE(j))) return false;
    difat = block.readUInt32LE(sectorSize - 4);
  }
  if (fatIds.length !== fatCount || (difatCount && difat !== 0xfffffffe)) return false;
  const fat = Buffer.concat(fatIds.map(sector)); const seen = new Set(); let next = data.readUInt32LE(48); const names = new Set();
  while (next !== 0xfffffffe) {
    if (seen.has(next) || seen.size > sectorCount || next * 4 + 4 > fat.length) return false;
    seen.add(next); const directory = sector(next);
    for (let offset = 0; offset < sectorSize; offset += 128) {
      const length = directory.readUInt16LE(offset + 64); const kind = directory[offset + 66];
      if (kind === 2 && length >= 2 && length <= 64 && length % 2 === 0) names.add(directory.subarray(offset, offset + length - 2).toString('utf16le'));
    }
    next = fat.readUInt32LE(next * 4);
  }
  return ({ '.doc': ['WordDocument'], '.xls': ['Workbook', 'Book'], '.ppt': ['PowerPoint Document'] }[extension]).some(name => names.has(name));
}
function signature(data, extension) {
  try {
    if (['.txt', '.md', '.csv'].includes(extension)) return validText(data);
    if (extension === '.rtf') return /^\{\\rtf[1-9]/.test(data.toString('ascii', 0, 12)) && /\}\s*$/.test(data.toString('latin1')) && !data.includes(0);
    if (['.docx', '.xlsx', '.pptx'].includes(extension)) return data.length >= 22 && officeZip(data, extension);
    if (['.doc', '.xls', '.ppt'].includes(extension)) return officeOle(data, extension);
    if (extension === '.pdf') return /^%PDF-1\.[0-9]|^%PDF-2\.[0-9]/.test(data.toString('ascii', 0, 8)) && /%%EOF\s*$/.test(data.subarray(-1024).toString('ascii')) && /\d+\s+\d+\s+obj\b/.test(data.toString('latin1'));
    if (extension === '.png') return data.length >= 45 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0 && data.subarray(-8).toString('hex') === '49454e44ae426082';
    if (extension === '.jpg' || extension === '.jpeg') {
      if (data.length < 20 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9) return false;
      let offset = 2; let dimensions = false;
      while (offset + 4 < data.length) {
        if (data[offset++] !== 0xff) return false; while (data[offset] === 0xff) offset++;
        const marker = data[offset++]; if (marker === 0xda) return dimensions;
        const size = data.readUInt16BE(offset); if (size < 2 || offset + size > data.length) return false;
        if ([0xc0, 0xc1, 0xc2].includes(marker)) { if (size < 8 || !data.readUInt16BE(offset + 3) || !data.readUInt16BE(offset + 5)) return false; dimensions = true; }
        offset += size;
      }
      return false;
    }
    if (extension === '.webp') return data.length >= 26 && data.toString('ascii', 0, 4) === 'RIFF' && data.readUInt32LE(4) + 8 === data.length && data.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16)) && data.readUInt32LE(16) > 0 && data.readUInt32LE(16) + 20 <= data.length;
  } catch { return false; }
  return false;
}

export function validateFiles(files, submissionType) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 5) throw new InputError('请上传 1 至 5 个交付文件。');
  let total = 0;
  return files.map(file => {
    if (!file || typeof file !== 'object' || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 180 || /[\\/\u0000-\u001f\u007f]/.test(file.name) || file.name !== file.name.trim() || /[. ]$/.test(file.name)) throw new InputError('文件名无效，请使用不含路径或控制字符的普通文件名（最多 180 个字符）。');
    const name = file.name; const extension = extname(name).toLowerCase();
    if (!acceptsFile(name, submissionType)) throw new InputError(`“${name}”不符合提交形式“${submissionType}”，请选择对应格式的文件。`);
    const encoded = file.contentBase64;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(10 * MiB / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new InputError(`“${name}”为空、超过 10 MB 或文件编码不正确。`);
    const content = Buffer.from(encoded, 'base64');
    if (!content.length || content.length > 10 * MiB || content.toString('base64') !== encoded) throw new InputError(`“${name}”为空、超过 10 MB 或文件编码不正确。`);
    total += content.length; if (total > 25 * MiB) throw new InputError('本次文件总大小不能超过 25 MB。');
    if (!signature(content, extension)) invalid(name);
    return { name, content, size: content.length, mimeType: types[extension][1], submissionType };
  });
}
