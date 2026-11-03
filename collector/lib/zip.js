// Minimal ZIP reader (stored + deflate), enough for election-night result archives.
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

function findEOCD(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Not a zip file (no end-of-central-directory record)');
}

/** List entries: [{ name, method, compSize, size, offset }] */
export function listZip(buf) {
  const eocd = findEOCD(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOff = buf.readUInt32LE(eocd + 16);
  // ZIP64
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdSize = Number(buf.readBigUInt64LE(z64 + 40));
      cdOff = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count && p < cdOff + cdSize; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // ZIP64 extra field
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(buf.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    out.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function dataSlice(buf, entry) {
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`Bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  return buf.subarray(start, start + entry.compSize);
}

/** Extract one entry to a Buffer. `pick` is a name, a RegExp, or omitted for the first file. */
export function unzipEntry(buf, pick) {
  const entries = listZip(buf).filter((e) => !e.name.endsWith('/'));
  const entry =
    pick == null
      ? entries[0]
      : entries.find((e) => (pick instanceof RegExp ? pick.test(e.name) : e.name === pick));
  if (!entry) throw new Error(`Zip entry not found: ${pick}`);
  const data = dataSlice(buf, entry);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported zip compression method ${entry.method}`);
}

/** Stream one entry (for files too large to hold as a string). */
export function unzipStream(buf, pick) {
  const entries = listZip(buf).filter((e) => !e.name.endsWith('/'));
  const entry = pick == null ? entries[0] : entries.find((e) => (pick instanceof RegExp ? pick.test(e.name) : e.name === pick));
  if (!entry) throw new Error(`Zip entry not found: ${pick}`);
  const data = dataSlice(buf, entry);
  const src = Readable.from([data]);
  if (entry.method === 0) return src;
  if (entry.method === 8) return src.pipe(zlib.createInflateRaw());
  throw new Error(`Unsupported zip compression method ${entry.method}`);
}

export const isZip = (buf) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
