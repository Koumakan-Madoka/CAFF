const assert = require('node:assert/strict');
const test = require('node:test');
const { parseImageHeader } = require('../../build/lib/image-header-parser');

function pngBuffer(width = 100, height = 50) {
  const buffer = Buffer.alloc(33);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  sig.copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(8, 24);
  buffer.writeUInt8(6, 25);
  buffer.writeUInt8(0, 26);
  buffer.writeUInt8(0, 27);
  buffer.writeUInt8(0, 28);
  return buffer;
}

function jpegBuffer(width = 800, height = 600) {
  const buffer = Buffer.alloc(20);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xe0;
  buffer.writeUInt16BE(4, 4);
  buffer[6] = 0x00;
  buffer[7] = 0x01;
  buffer[8] = 0x02;
  buffer[9] = 0x03;
  buffer[10] = 0xff;
  buffer[11] = 0xc0;
  buffer.writeUInt16BE(17, 12);
  buffer.writeUInt8(8, 14);
  buffer.writeUInt16BE(height, 15);
  buffer.writeUInt16BE(width, 17);
  return buffer;
}

function webpVp8xBuffer(width = 64, height = 48) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(0, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(0, 16);
  buffer[20] = 0;
  buffer[21] = 0;
  buffer[22] = 0;
  buffer[23] = 0;
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function webpVp8lBuffer(width = 32, height = 16) {
  const buffer = Buffer.alloc(25);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8L', 12, 'ascii');
  buffer.writeUInt32LE(0, 16);
  buffer.writeUInt32LE((height - 1) << 14 | (width - 1), 20);
  return buffer;
}

function gifBuffer(width = 40, height = 30, version = 'GIF89a') {
  const buffer = Buffer.alloc(13);
  buffer.write(version, 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  buffer.writeUInt8(0xf7, 10);
  buffer.writeUInt8(0, 11);
  buffer.writeUInt8(0, 12);
  return buffer;
}

test('parses valid PNG header with dimensions', () => {
  const result = parseImageHeader(pngBuffer(100, 50));
  assert.equal(result.ok, true);
  assert.equal(result.header.mimeType, 'image/png');
  assert.equal(result.header.width, 100);
  assert.equal(result.header.height, 50);
  assert.equal(result.header.pixelCount, 5000);
  assert.equal(result.header.animated, false);
});

test('parses valid JPEG header with dimensions', () => {
  const result = parseImageHeader(jpegBuffer(800, 600));
  assert.equal(result.ok, true);
  assert.equal(result.header.mimeType, 'image/jpeg');
  assert.equal(result.header.width, 800);
  assert.equal(result.header.height, 600);
});

test('parses WEBP VP8X and VP8L headers', () => {
  const vp8x = parseImageHeader(webpVp8xBuffer(64, 48));
  assert.equal(vp8x.ok, true);
  assert.equal(vp8x.header.mimeType, 'image/webp');
  assert.equal(vp8x.header.width, 64);
  assert.equal(vp8x.header.height, 48);

  const vp8l = parseImageHeader(webpVp8lBuffer(32, 16));
  assert.equal(vp8l.ok, true);
  assert.equal(vp8l.header.width, 32);
  assert.equal(vp8l.header.height, 16);
});

test('parses static GIF and rejects animated GIF', () => {
  const staticGif = parseImageHeader(gifBuffer(40, 30, 'GIF87a'));
  assert.equal(staticGif.ok, true);
  assert.equal(staticGif.header.mimeType, 'image/gif');
  assert.equal(staticGif.header.width, 40);
  assert.equal(staticGif.header.height, 30);

  const animated = parseImageHeader(gifBuffer(40, 30, 'GIF89a'));
  assert.equal(animated.ok, false);
  assert.equal(animated.reason, 'ANIMATED_GIF_REJECTED');
});

test('rejects unsupported magic bytes', () => {
  const result = parseImageHeader(Buffer.from('not-an-image-at-all'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'UNSUPPORTED_MAGIC');
});

test('rejects empty buffer', () => {
  const result = parseImageHeader(Buffer.alloc(0));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EMPTY_BUFFER');
});

test('rejects truncated PNG header', () => {
  const result = parseImageHeader(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
  assert.equal(result.ok, false);
});

test('rejects JPEG without SOF marker', () => {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04]);
  const result = parseImageHeader(buffer);
  assert.equal(result.ok, false);
});
