/**
 * 零依赖 ZIP 打包器：用浏览器内置 CompressionStream("deflate-raw") 压缩，
 * CRC32 查表，手写 local header + central directory + EOCD。
 */

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 用 deflate-raw 压缩单个数据块 */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(data as BufferSource);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** 把多个文件打包成 ZIP Blob */
export async function createZip(entries: ZipEntry[]): Promise<Blob> {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();

  for (const entry of entries) {
    const raw = entry.data;
    const crc = crc32(raw);
    const compressed = raw.length > 0 ? await deflateRaw(raw) : new Uint8Array(0);
    const nameBytes = enc.encode(entry.name);

    // — local file header (30 bytes) —
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); // signature
    lh.setUint16(4, 20, true); // version needed
    lh.setUint16(6, 0x0800, true); // flags: 文件名使用 UTF-8
    lh.setUint16(8, 8, true); // method: deflate
    lh.setUint16(10, 0, true); // mod time
    lh.setUint16(12, 0, true); // mod date
    lh.setUint32(14, crc, true);
    lh.setUint32(18, compressed.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true); // extra len

    localParts.push(new Uint8Array(lh.buffer), nameBytes, compressed);

    // — central directory header (46 bytes) —
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, 0x0800, true); // flags: 文件名使用 UTF-8
    cd.setUint16(10, 8, true); // method
    cd.setUint16(12, 0, true); // mod time
    cd.setUint16(14, 0, true); // mod date
    cd.setUint32(16, crc, true);
    cd.setUint32(20, compressed.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true); // extra len
    cd.setUint16(32, 0, true); // comment len
    cd.setUint16(34, 0, true); // disk start
    cd.setUint16(36, 0, true); // internal attrs
    cd.setUint32(38, 0, true); // external attrs
    cd.setUint32(42, offset, true); // local header offset

    centralParts.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + compressed.length;
  }

  // central directory size
  let cdSize = 0;
  for (const p of centralParts) cdSize += p.length;

  // — end of central directory (22 bytes) —
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true); // disk number
  eocd.setUint16(6, 0, true); // disk with CD
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true); // CD offset
  eocd.setUint16(20, 0, true); // comment len

  return new Blob(
    [...localParts, ...centralParts, new Uint8Array(eocd.buffer)].map((p) =>
      p instanceof Uint8Array ? p.buffer : p
    ) as BlobPart[],
    { type: "application/zip" }
  );
}
