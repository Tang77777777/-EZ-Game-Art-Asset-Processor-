import { describe, expect, test } from "bun:test";
import { createZip } from "../apps/web/src/zip";

async function readZipEntries(blob: Blob): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const result = new Map<string, Uint8Array>();

  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    expect(view.getUint16(offset + 8, true) & 0x0800).toBe(0x0800);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    expect(view.getUint16(localOffset + 6, true) & 0x0800).toBe(0x0800);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    const data = compressed.length === 0
      ? new Uint8Array()
      : new Uint8Array(await new Response(new Response(compressed).body!.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    result.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

describe("ZIP 导出", () => {
  test("生成可解压的 ZIP，并保持 ASCII、Unicode 与空文件内容", async () => {
    const encoder = new TextEncoder();
    const zip = await createZip([
      { name: "hello.txt", data: encoder.encode("hello world") },
      { name: "素材/空.bin", data: new Uint8Array() },
    ]);
    expect(zip.type).toBe("application/zip");

    const entries = await readZipEntries(zip);
    expect(new TextDecoder().decode(entries.get("hello.txt"))).toBe("hello world");
    expect(entries.get("素材/空.bin")).toEqual(new Uint8Array());
  });
});
