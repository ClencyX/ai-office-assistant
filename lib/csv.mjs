export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function parseCsv(source) {
  if (typeof source !== 'string' || !source.trim()) throw new InputError('请提供非空的 CSV 内容。');
  const text = source.replace(/^\uFEFF/, '');
  const rows = []; let row = []; let field = ''; let quoted = false; let closed = false; let startLine = 1; let line = 1;
  const finishField = () => { row.push(field); field = ''; closed = false; };
  const finishRow = () => { finishField(); if (row.some(value => value.trim())) rows.push({ values: row, line: startLine }); row = []; startLine = line + 1; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else { field += c; if (c === '\n') line++; }
      continue;
    }
    if (c === '"') {
      if (field || closed) throw new InputError(`第 ${line} 行引号格式不正确。`);
      quoted = true;
    } else if (c === ',') finishField();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      finishRow(); line++;
    } else {
      if (closed) throw new InputError(`第 ${line} 行引号后存在多余字符。`);
      field += c;
    }
  }
  if (quoted) throw new InputError(`第 ${startLine} 行的引号未闭合。`);
  if (field || row.length || closed) finishRow();
  return rows;
}

export function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Excel can interpret leading whitespace followed by a formula as executable content.
  if (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(rows) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
