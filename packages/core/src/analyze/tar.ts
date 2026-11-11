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
  let nextPaxSize: number | undefined;
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
    // A header we can't read must not silently end the scan: npm's tar may read past it and
    // install files we never looked at. Throw → the caller records an analysis failure (fail closed).
    if (!checksumOk(header)) throw new Error(`corrupt tar header at offset ${off}`);
    const paxSize = nextPaxSize;
    nextPaxSize = undefined;
    const name = str(off, 100);
    // a pax `size=` record overrides the ustar field (node-tar honours it, so must we)
    const size = paxSize ?? numField(header.subarray(124, 136));
    const type = String.fromCharCode(buf[off + 156] ?? 48);
    const prefix = str(off + 345, 155);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`unreadable tar entry size at offset ${off}`);
    if (dataEnd > buf.length) throw new Error("truncated tar archive");

    if (type === "x") {
      const pax = dec.decode(buf.subarray(dataStart, dataEnd));
      const m = /\d+ path=([^\n]*)\n/.exec(pax);
      if (m) paxPath = m[1];
      const sz = /\d+ size=(\d+)\n/.exec(pax);
      nextPaxSize = sz ? Number(sz[1]) : undefined;
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

/** Octal (NUL/space padded) or GNU base-256 numeric header field. */
function numField(f: Uint8Array): number {
  if ((f[0]! & 0x80) !== 0) {
    if ((f[0]! & 0x40) !== 0) return Number.NaN; // negative
    let n = f[0]! & 0x3f;
    for (let i = 1; i < f.length; i++) n = n * 256 + f[i]!;
    return n;
  }
  let txt = "";
  for (const b of f) {
    if (b === 0) break;
    txt += String.fromCharCode(b);
  }
  txt = txt.trim();
  if (txt === "") return 0;
  return /^[0-7]+$/.test(txt) ? parseInt(txt, 8) : Number.NaN;
}

function checksumOk(h: Uint8Array): boolean {
  const stored = numField(h.subarray(148, 156));
  if (!Number.isFinite(stored)) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 32 : h[i]!;
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

/** Strip the first path component (npm tarballs use "package/", sdists use "name-1.0/"). */
export function stripRoot(path: string): string {
  const i = path.indexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
