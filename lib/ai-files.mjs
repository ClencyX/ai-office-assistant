import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { InputError } from './csv.mjs';

const MiB = 1024 * 1024;
const maxTextLength = 20_000;
const xmlEscape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function fileBytes(file, limit) {
  if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name !== file.name.trim() || file.name.length > 180 || /[\\/\u0000-\u001f\u007f]/.test(file.name) || /[. ]$/.test(file.name)) throw new InputError('文件名无效，请选择不含路径的普通文件名（最多 180 字）。');
  const encoded = file.contentBase64;
  if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(limit / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new InputError(`文件为空、编码有误或超过 ${limit / MiB} MB。`);
  const content = Buffer.from(encoded, 'base64');
  if (!content.length || content.length > limit || content.toString('base64') !== encoded) throw new InputError(`文件为空、编码有误或超过 ${limit / MiB} MB。`);
  return content;
}

function checkedText(value) {
  const text = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new InputError('未能读取有效正文，请使用文本、表格文本或普通 Word 文档。');
  if (text.length > maxTextLength) throw new InputError('单份素材正文最多 20000 字，请拆分后导入。');
  return text;
}

function decodeText(content) {
  const encoding = content[0] === 0xff && content[1] === 0xfe ? 'utf-16le' : content[0] === 0xfe && content[1] === 0xff ? 'utf-16be' : 'utf-8';
  try { return new TextDecoder(encoding, { fatal: true }).decode(content); }
  catch {
    try { return new TextDecoder('gb18030', { fatal: true }).decode(content); }
    catch { throw new InputError('文件编码无法识别，请另存为万国码文本后导入。'); }
  }
}

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

// Only two bounded XML entries are read. No uploaded archive paths are written to disk.
function wordXml(content) {
  const invalid = () => { throw new InputError('Word 文档损坏、加密或结构不受支持，请另存为普通 .docx 后重试。'); };
  try {
    if (content.length < 22 || content.readUInt32LE(0) !== 0x04034b50) return invalid();
    let end = -1;
    for (let i = content.length - 22; i >= Math.max(0, content.length - 65557); i--) {
      if (content.readUInt32LE(i) === 0x06054b50 && i + 22 + content.readUInt16LE(i + 20) === content.length) { end = i; break; }
    }
    if (end < 0 || content.readUInt16LE(end + 4) || content.readUInt16LE(end + 6)) return invalid();
    const count = content.readUInt16LE(end + 10), directorySize = content.readUInt32LE(end + 12), directoryStart = content.readUInt32LE(end + 16);
    if (!count || count > 1024 || content.readUInt16LE(end + 8) !== count || directoryStart + directorySize !== end) return invalid();
    let position = directoryStart, expanded = 0;
    const entries = new Map(), names = new Set();
    for (let i = 0; i < count; i++) {
      if (position + 46 > end || content.readUInt32LE(position) !== 0x02014b50) return invalid();
      const flags = content.readUInt16LE(position + 8), method = content.readUInt16LE(position + 10), checksum = content.readUInt32LE(position + 16);
      const packed = content.readUInt32LE(position + 20), size = content.readUInt32LE(position + 24), nameLength = content.readUInt16LE(position + 28);
      const next = position + 46 + nameLength + content.readUInt16LE(position + 30) + content.readUInt16LE(position + 32);
      if (next > end) return invalid();
      const name = content.subarray(position + 46, position + 46 + nameLength).toString('utf8'), local = content.readUInt32LE(position + 42);
      expanded += size;
      if (names.has(name) || expanded > 20 * MiB || (flags & 1) || ![0, 8].includes(method) || local + 30 > directoryStart || content.readUInt32LE(local) !== 0x04034b50) return invalid();
      names.add(name);
      const localNameLength = content.readUInt16LE(local + 26), start = local + 30 + localNameLength + content.readUInt16LE(local + 28);
      if (content.readUInt16LE(local + 8) !== method || start + packed > directoryStart || content.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name) return invalid();
      if (name === 'word/document.xml' || name === '[Content_Types].xml') {
        if (size > 2 * MiB) return invalid();
        const bytes = method === 0 ? content.subarray(start, start + packed) : inflateRawSync(content.subarray(start, start + packed), { maxOutputLength: Math.max(1, size) });
        if (bytes.length !== size || crc32(bytes) !== checksum) return invalid();
        const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return invalid();
        entries.set(name, xml);
      }
      position = next;
    }
    const xml = entries.get('word/document.xml');
    if (position !== end || !entries.has('[Content_Types].xml') || !/<(?:[\w.-]+:)?document(?:\s|>)/.test(xml || '')) return invalid();
    return xml;
  } catch (error) { if (error instanceof InputError) throw error; return invalid(); }
}

function unescapeXml(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, value) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[value]) return named[value];
    const code = value.toLowerCase().startsWith('#x') ? Number.parseInt(value.slice(2), 16) : Number(value.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

export function extractTextFile(file) {
  const content = fileBytes(file, MiB), extension = extname(file.name).toLowerCase();
  if (!['.txt', '.md', '.csv', '.docx'].includes(extension)) throw new InputError('素材导入支持 .txt、.md、.csv 和 .docx；其他材料请复制正文后粘贴。');
  let text;
  if (extension !== '.docx') text = decodeText(content);
  else {
    const xml = wordXml(content).replace(/<!--[\s\S]*?-->/g, '');
    const tokens = xml.match(/<(?:[\w.-]+:)?t(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.-]+:)?t\s*>|<(?:[\w.-]+:)?(?:tab|br)\b[^>]*\/\s*>|<\/(?:[\w.-]+:)?(?:p|tc|tr)\s*>/g) || [];
    text = tokens.map(token => /^<\//.test(token) ? /(?:^|:)tc\s*>$/.test(token) ? '\t' : '\n' : /<(?:[\w.-]+:)?tab\b/.test(token) ? '\t' : /<(?:[\w.-]+:)?br\b/.test(token) ? '\n' : unescapeXml(token.replace(/^<[^>]+>|<[^>]+>$/g, ''))).join('').replace(/\n{3,}/g, '\n\n');
  }
  return { title: file.name.slice(0, -extension.length).slice(0, 120), content: checkedText(text) };
}

export function decodeAudioFile(file, limit = 20 * MiB) {
  const content = fileBytes(file, limit), extension = extname(file.name).toLowerCase();
  const mimeTypes = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
  let valid = false;
  if (extension === '.mp3') valid = content.length > 10 && (content.toString('ascii', 0, 3) === 'ID3' || content[0] === 0xff && (content[1] & 0xe0) === 0xe0);
  if (extension === '.wav') valid = content.length >= 44 && content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WAVE';
  if (extension === '.m4a' || extension === '.mp4') valid = content.length >= 16 && content.toString('ascii', 4, 8) === 'ftyp';
  if (extension === '.webm') valid = content.length >= 16 && content.subarray(0, 4).toString('hex') === '1a45dfa3';
  if (extension === '.ogg') valid = content.length >= 27 && content.toString('ascii', 0, 4) === 'OggS';
  if (extension === '.flac') valid = content.length >= 42 && content.toString('ascii', 0, 4) === 'fLaC';
  if (!mimeTypes[extension] || !valid) throw new InputError('录音格式无效，支持 20 MB 以内的 mp3、wav、m4a、mp4、webm、ogg、flac；请确认文件可正常播放。');
  return { name: file.name, mimeType: mimeTypes[extension], content };
}

function validPng(content) {
  if (content.length < 57 || content.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
  let offset = 8, header = false, image = false;
  while (offset + 12 <= content.length) {
    const length = content.readUInt32BE(offset), end = offset + 12 + length;
    if (end > content.length) return false;
    const kind = content.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(kind) || crc32(content.subarray(offset + 4, end - 4)) !== content.readUInt32BE(end - 4)) return false;
    if (!header) {
      if (kind !== 'IHDR' || length !== 13) return false;
      const width = content.readUInt32BE(offset + 8), height = content.readUInt32BE(offset + 12);
      const depth = content[offset + 16], color = content[offset + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth) || content[offset + 18] || content[offset + 19] || content[offset + 20] > 1) return false;
      header = true;
    } else if (kind === 'IHDR') return false;
    if (kind === 'IDAT' && length) image = true;
    if (kind === 'IEND') return length === 0 && image && end === content.length;
    offset = end;
  }
  return false;
}

function validJpeg(content) {
  if (content.length < 20 || content.readUInt16BE(0) !== 0xffd8) return false;
  let offset = 2, frame = false, scan = false, scanData = false;
  while (offset < content.length) {
    if (content[offset++] !== 0xff) return false;
    while (content[offset] === 0xff) offset++;
    if (offset >= content.length) return false;
    const marker = content[offset++];
    if (marker === 0xd9) return frame && scan && scanData && offset === content.length;
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > content.length) return false;
    const length = content.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > content.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || !content.readUInt16BE(offset + 3) || !content.readUInt16BE(offset + 5) || !content[offset + 7] || length !== 8 + 3 * content[offset + 7]) return false;
      frame = true;
    }
    if (marker === 0xda) {
      if (!frame || length < 6 || !content[offset + 2] || length !== 6 + 2 * content[offset + 2]) return false;
      scan = true; offset = end;
      // Skip escaped image bytes and restart markers; subsequent scans use normal segments.
      while (offset < content.length) {
        if (content[offset] !== 0xff) { scanData = true; offset++; continue; }
        const start = offset;
        while (content[offset] === 0xff) offset++;
        if (offset >= content.length) return false;
        if (content[offset] === 0 || (content[offset] >= 0xd0 && content[offset] <= 0xd7)) { scanData = true; offset++; continue; }
        offset = start; break;
      }
    } else offset = end;
  }
  return false;
}

function validWebp(content) {
  if (content.length < 26 || content.toString('ascii', 0, 4) !== 'RIFF' || content.readUInt32LE(4) !== content.length - 8 || content.toString('ascii', 8, 12) !== 'WEBP') return false;
  let offset = 12, image = false, extended = false;
  while (offset + 8 <= content.length) {
    const kind = content.toString('ascii', offset, offset + 4), length = content.readUInt32LE(offset + 4), start = offset + 8, end = start + length;
    if (end + (length % 2) > content.length || (length % 2 && content[end] !== 0)) return false;
    if (kind === 'VP8 ') {
      if (length < 11 || (content[start] & 1) || content.toString('hex', start + 3, start + 6) !== '9d012a' || !(content.readUInt16LE(start + 6) & 0x3fff) || !(content.readUInt16LE(start + 8) & 0x3fff)) return false;
      image = true;
    } else if (kind === 'VP8L') {
      if (length < 6 || content[start] !== 0x2f || (content[start + 4] & 0xe0)) return false;
      image = true;
    } else if (kind === 'VP8X') {
      if (offset !== 12 || extended || length !== 10 || (content[start] & 0xc1) || content[start + 1] || content[start + 2] || content[start + 3]) return false;
      extended = true;
    } else if (!extended) return false;
    offset = end + (length % 2);
  }
  return offset === content.length && image;
}

// Validate the container before it is sent to a compatible vision model. No image is executed or written to disk here.
export function decodeImageFile(file) {
  const content = fileBytes(file, 10 * MiB), extension = extname(file.name).toLowerCase();
  const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const valid = extension === '.png' ? validPng(content) : extension === '.jpg' || extension === '.jpeg' ? validJpeg(content) : extension === '.webp' ? validWebp(content) : false;
  if (!valid) throw new InputError('图片格式无效或文件已损坏，支持 10 MB 以内的 png、jpg、jpeg、webp；请另存为普通图片后重试。');
  return { name: file.name, mimeType: mimeTypes[extension], content };
}

function zipFiles(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), content = Buffer.from(text), crc = crc32(content);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(content.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, content); central.push(directory, filename); offset += header.length + filename.length + content.length;
  }
  const directories = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directories.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directories, end]);
}

function paragraph(text, style = '') {
  const clean = String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\*\*([^*]+)\*\*/g, '$1');
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xmlEscape(clean)}</w:t></w:r></w:p>`;
}

// A small native OOXML writer keeps export local and avoids HTML renamed as Word.
export function createDocx(title, content) {
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n'), blocks = [];
  if (lines[0]?.replace(/^#+\s*/, '').trim() !== String(title).trim()) blocks.push(paragraph(title, 'Title'));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      const rows = [line]; i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(lines[i++]);
      i--;
      const cells = rows.map(row => row.trim().replace(/^\||\|$/g, '').split('|'));
      const columnCount = Math.max(...cells.map(row => row.length));
      if (columnCount > 30) { blocks.push(...rows.map(row => paragraph(row))); continue; }
      const columnWidth = Math.floor(9000 / columnCount);
      const grid = `<w:tblGrid>${Array.from({ length: columnCount }, () => `<w:gridCol w:w="${columnWidth}"/>`).join('')}</w:tblGrid>`;
      const tableRows = cells.map((row, index) => `<w:tr>${index === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: columnCount }, (_, column) => `<w:tc><w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/>${index === 0 ? '<w:shd w:fill="EEF2F6"/>' : ''}</w:tcPr>${paragraph((row[column] || '').trim())}</w:tc>`).join('')}</w:tr>`).join('');
      blocks.push(`<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="CCD3DC"/>`).join('')}</w:tblBorders></w:tblPr>${grid}${tableRows}</w:tbl>`);
    } else {
      const heading = line.match(/^(#{1,3})\s+(.+)/);
      blocks.push(heading ? paragraph(heading[2], `Heading${heading[1].length}`) : paragraph(line.replace(/^\s*[-*]\s+/, '• ')));
    }
  }
  return zipFiles({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr></w:body></w:document>`,
    'word/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="正文"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="标题"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="300"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="一级标题"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="二级标题"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="140"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="三级标题"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>'
  });
}
