// Minimal ZIP writer (stored entries, no compression) so the UI can download a
// session's workspace without adding a dependency.
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  path: string; // relative, forward slashes
  data: Buffer;
}

/** Builds a valid .zip with stored (uncompressed) entries. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    header.writeUInt16LE(0, 8); // method: stored
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, entry.data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory header
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
    dir.writeUInt16LE(0, 10); // method: stored
    dir.writeUInt16LE(0, 12); // mod time
    dir.writeUInt16LE(0x21, 14); // mod date
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(entry.data.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra length
    dir.writeUInt16LE(0, 32); // comment length
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += header.length + name.length + entry.data.length;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, ...central, end]);
}
