/**
 * GLB container reading and writing, shared by the asset scripts.
 *
 * These only touch the chunk envelope: the JSON chunk is parsed, the BIN chunk is
 * handed back as a raw Buffer. Nothing here interprets accessors or bufferViews, so
 * a caller that copies buffer views byte-for-byte keeps Draco-compressed primitives
 * intact without a decode/encode round trip.
 */
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const GLB_MAGIC = 0x46546c67;

export { JSON_CHUNK, BIN_CHUNK, GLB_MAGIC };

export function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB file');
  let offset = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) json = JSON.parse(chunk.toString('utf8'));
    else if (type === BIN_CHUNK) bin = chunk;
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

export function padTo4(length) {
  return (4 - (length % 4)) % 4;
}

export function writeGlb(json, bin) {
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc(padTo4(jsonBuffer.length), 0x20);
  const binPad = Buffer.alloc(padTo4(bin.length), 0);
  const jsonLength = jsonBuffer.length + jsonPad.length;
  const binLength = bin.length + binPad.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonLength + (binLength ? 8 + binLength : 0), 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonLength, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  const chunks = [header, jsonHeader, jsonBuffer, jsonPad];
  if (binLength) {
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binLength, 0);
    binHeader.writeUInt32LE(BIN_CHUNK, 4);
    chunks.push(binHeader, bin, binPad);
  }
  return Buffer.concat(chunks);
}
