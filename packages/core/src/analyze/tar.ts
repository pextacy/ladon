import { gunzipSync } from "node:zlib";

export interface TarFile {
  path: string;
  data: Uint8Array;
}

/**
 * In-memory .tar.gz reader. Never writes to disk, never executes. Only regular files are returned,
 * filtered by `want(path, size)`, until `maxTotal` bytes have been collected.
 */
export function readTarGz(
  gz: Uint8Array,
  want: (path: string, size: number) => boolean,
  maxTotal = 2 * 1024 * 1024,
  maxUnpacked = 64 * 1024 * 1024,
): TarFile[] {
  const buf = gunzipSync(gz, { maxOutputLength: maxUnpacked });
  const files: TarFile[] = [];
  let total = 0;
  let off = 0;
  let paxPath: string | undefined;
  let longName: string | undefined;
  const dec = new TextDecoder();

  const str = (start: number, len: number) => {
    const slice = buf.subarray(start, start + len);
    const nul = slice.indexOf(0);
    return dec.decode(nul >= 0 ? slice.subarray(0, nul) : slice);
  };

  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = str(off, 100);
    const sizeField = str(off + 124, 12).trim();
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    const type = String.fromCharCode(buf[off + 156] ?? 48);
    const prefix = str(off + 345, 155);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (!Number.isFinite(size) || size < 0 || dataEnd > buf.length) break;

    if (type === "x") {
      const pax = dec.decode(buf.subarray(dataStart, dataEnd));
      const m = /\d+ path=([^\n]*)\n/.exec(pax);
      if (m) paxPath = m[1];
    } else if (type === "L") {
      longName = str(dataStart, size);
    } else if (type === "0" || type === "\0" || type === "7") {
      const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
      paxPath = undefined;
      longName = undefined;
      if (total + size <= maxTotal && want(path, size)) {
        files.push({ path, data: buf.subarray(dataStart, dataEnd) });
        total += size;
      }
    } else {
      paxPath = undefined;
      longName = undefined;
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Strip the first path component (npm tarballs use "package/", sdists use "name-1.0/"). */
export function stripRoot(path: string): string {
  const i = path.indexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
