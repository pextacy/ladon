import { gzipSync } from "node:zlib";
import { emptyEvidence, type Evidence } from "../evidence.js";

export const NOW = new Date("2026-11-10T12:00:00Z");
export const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
export const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

export function ev(over: Partial<Evidence> = {}): Evidence {
  return { ...emptyEvidence("npm", "some-pkg", NOW), exists: true, ...over };
}

/** Build a .tar.gz in memory (ustar) for analyzer tests. */
export function makeTgz(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(path, 0, 100);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
