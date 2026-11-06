(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProEditArchive = api;
})(globalThis, function () {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const CHUNK_SIZE = 1024 * 1024;
  const MAX_ZIP32_SIZE = 0xffffffff;

  function crcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[n] = value >>> 0;
    }
    return table;
  }

  const CRC_TABLE = crcTable();

  async function checksum(blob, onProgress) {
    let crc = 0xffffffff;
    let loaded = 0;
    while (loaded < blob.size) {
      const end = Math.min(blob.size, loaded + CHUNK_SIZE);
      const bytes = new Uint8Array(await blob.slice(loaded, end).arrayBuffer());
      for (const byte of bytes) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      }
      loaded = end;
      if (onProgress) onProgress(loaded, blob.size);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function localHeader(name, crc, size) {
    const bytes = new Uint8Array(30);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(12, 0x21, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, name.length, true);
    return bytes;
  }

  function centralHeader(name, crc, size, offset) {
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(14, 0x21, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, name.length, true);
    view.setUint32(42, offset, true);
    return bytes;
  }

  async function createProjectArchive(state, media, onProgress) {
    if (media.length + 1 >= 0xffff) throw new Error('This project has too many media items to export.');

    const items = media.map((item) => {
      if (!(item.file instanceof Blob)) throw new Error(`Media file is unavailable: ${item.name}`);
      if (item.file.size > MAX_ZIP32_SIZE) throw new Error(`${item.name} is too large for a project archive.`);
      return {
        name: `media/${item.id}.bin`,
        blob: item.file,
        id: item.id,
        mime: item.file.type || '',
        size: item.file.size,
      };
    });
    const manifest = {
      format: 'ProEdit Studio Project',
      version: 2,
      state,
      blobs: items.map(({ id, name, mime, size }) => ({ id, path: name, mime, size })),
    };
    const entries = [
      {
        name: 'project.json',
        blob: new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
      },
      ...items,
    ];
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const totalBytes = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
    let processedBytes = 0;

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const crc = await checksum(entry.blob, (loaded) => {
        if (onProgress) onProgress(processedBytes + loaded, totalBytes);
      });
      if (offset + 30 + name.length + entry.blob.size > MAX_ZIP32_SIZE) {
        throw new Error('This project exceeds the 4 GB project archive limit.');
      }
      localParts.push(localHeader(name, crc, entry.blob.size), name, entry.blob);
      centralParts.push(centralHeader(name, crc, entry.blob.size, offset), name);
      offset += 30 + name.length + entry.blob.size;
      processedBytes += entry.blob.size;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
    if (offset + centralSize + 22 > MAX_ZIP32_SIZE) {
      throw new Error('This project exceeds the 4 GB project archive limit.');
    }
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    if (onProgress) onProgress(totalBytes, totalBytes);
    return new Blob([...localParts, ...centralParts, end], { type: 'application/vnd.proedit.project' });
  }

  function findEndRecord(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) return { view, offset };
    }
    throw new Error('Invalid ProEdit project archive: ZIP directory was not found.');
  }

  async function readProjectArchive(file, onProgress) {
    const tailStart = Math.max(0, file.size - 65557);
    const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
    const { view: endView, offset: endOffset } = findEndRecord(tail);
    const entriesOnDisk = endView.getUint16(endOffset + 8, true);
    const entryCount = endView.getUint16(endOffset + 10, true);
    const centralSize = endView.getUint32(endOffset + 12, true);
    const centralOffset = endView.getUint32(endOffset + 16, true);
    const commentLength = endView.getUint16(endOffset + 20, true);
    if (
      endView.getUint16(endOffset + 4, true) !== 0 ||
      endView.getUint16(endOffset + 6, true) !== 0 ||
      entriesOnDisk !== entryCount ||
      entryCount > 0xfffe ||
      centralSize > 64 * 1024 * 1024 ||
      centralOffset + centralSize > file.size ||
      endOffset + 22 + commentLength !== tail.length
    ) {
      throw new Error('Unsupported or invalid ProEdit project archive.');
    }

    const directory = new Uint8Array(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
    const directoryView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    const entries = new Map();
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (directoryView.getUint32(cursor, true) !== 0x02014b50) {
        throw new Error('Invalid ProEdit project archive directory.');
      }
      const method = directoryView.getUint16(cursor + 10, true);
      const flags = directoryView.getUint16(cursor + 8, true);
      const crc = directoryView.getUint32(cursor + 16, true);
      const compressedSize = directoryView.getUint32(cursor + 20, true);
      const size = directoryView.getUint32(cursor + 24, true);
      const nameLength = directoryView.getUint16(cursor + 28, true);
      const extraLength = directoryView.getUint16(cursor + 30, true);
      const commentLength = directoryView.getUint16(cursor + 32, true);
      const localOffset = directoryView.getUint32(cursor + 42, true);
      const nameStart = cursor + 46;
      const name = decoder.decode(directory.subarray(nameStart, nameStart + nameLength));
      if (flags !== 0x0800 || method !== 0 || compressedSize !== size || entries.has(name)) {
        throw new Error('Unsupported or invalid entry in ProEdit project archive.');
      }
      entries.set(name, { crc, size, localOffset });
      cursor = nameStart + nameLength + extraLength + commentLength;
    }
    if (cursor !== directory.length) throw new Error('Invalid ProEdit project archive directory size.');

    async function entryBlob(name, type) {
      const entry = entries.get(name);
      if (!entry || entry.localOffset + 30 > file.size) {
        throw new Error(`Project archive is missing ${name}.`);
      }
      const local = new DataView(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
      if (
        local.getUint32(0, true) !== 0x04034b50 ||
        local.getUint16(6, true) !== 0x0800 ||
        local.getUint16(8, true) !== 0
      ) {
        throw new Error(`Invalid project archive entry: ${name}`);
      }
      const dataOffset = entry.localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      if (dataOffset + entry.size > file.size) throw new Error(`Truncated project archive entry: ${name}`);
      const blob = file.slice(dataOffset, dataOffset + entry.size, type);
      const actualCrc = await checksum(blob, (loaded) => {
        if (onProgress) onProgress(loaded, file.size);
      });
      if (actualCrc !== entry.crc) throw new Error(`Project archive entry failed its integrity check: ${name}`);
      return blob;
    }

    const manifestBlob = await entryBlob('project.json', 'application/json');
    let manifest;
    try {
      manifest = JSON.parse(await manifestBlob.text());
    } catch (error) {
      throw new Error(`Project archive manifest is invalid: ${error.message}`);
    }
    if (
      !manifest ||
      manifest.format !== 'ProEdit Studio Project' ||
      !Array.isArray(manifest.blobs) ||
      !Array.isArray(manifest.state?.media)
    ) {
      throw new Error('Project archive manifest is missing required project data.');
    }

    const blobs = [];
    for (const item of manifest.blobs) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        typeof item.path !== 'string' ||
        !/^media\/[a-f0-9-]+\.bin$/i.test(item.path) ||
        item.path !== `media/${item.id}.bin`
      ) {
        throw new Error('Project archive contains invalid media metadata.');
      }
      blobs.push({ id: item.id, blob: await entryBlob(item.path, item.mime || '') });
    }
    return { ...manifest, blobs };
  }

  return { createProjectArchive, readProjectArchive };
});
