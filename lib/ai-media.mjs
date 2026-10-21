// Built-in non-sensitive fixtures are used only after explicit connection-test consent.
// They never read uploaded office material or send a file URL to another service.
export function connectionTestAudio() {
  const sampleRate = 16000, dataSize = sampleRate * 2;
  const content = Buffer.alloc(44 + dataSize);
  content.write('RIFF'); content.writeUInt32LE(content.length - 8, 4); content.write('WAVE', 8);
  content.write('fmt ', 12); content.writeUInt32LE(16, 16); content.writeUInt16LE(1, 20);
  content.writeUInt16LE(1, 22); content.writeUInt32LE(sampleRate, 24); content.writeUInt32LE(sampleRate * 2, 28);
  content.writeUInt16LE(2, 32); content.writeUInt16LE(16, 34); content.write('data', 36); content.writeUInt32LE(dataSize, 40);
  return { name: '连接测试静音.wav', contentBase64: content.toString('base64') };
}

export function connectionTestImage() {
  // A bundled 360 by 120 pixel PNG reading 连接测试 123, with no office data or remote resources.
  return { name: '连接测试图片.png', contentBase64: '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' };
}

export function audioDurationSeconds(file) {
  const content = file.content;
  if (file.mimeType === 'audio/wav' && content.length >= 44) {
    let offset = 12, bytesPerSecond = 0, dataSize = 0;
    while (offset + 8 <= content.length) {
      const type = content.toString('ascii', offset, offset + 4), size = content.readUInt32LE(offset + 4), start = offset + 8;
      if (start + size > content.length) return null;
      if (type === 'fmt ' && size >= 16) bytesPerSecond = content.readUInt32LE(start + 8);
      if (type === 'data') dataSize += size;
      offset = start + size + (size % 2);
    }
    return bytesPerSecond > 0 && dataSize > 0 ? dataSize / bytesPerSecond : null;
  }
  if (file.mimeType === 'audio/flac' && content.length >= 42 && (content[4] & 0x7f) === 0 && content.readUIntBE(5, 3) === 34) {
    const sampleRate = content.readUIntBE(18, 3) >>> 4;
    const samples = Number(content.readBigUInt64BE(18) & 0xfffffffffn);
    return sampleRate > 0 ? samples / sampleRate : null;
  }
  // Compressed containers without a reliable local duration stay subject to the upstream
  // five-minute limit. Do not mistake a byte-size estimate for a measured duration.
  return null;
}
