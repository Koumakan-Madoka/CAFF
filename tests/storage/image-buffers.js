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

module.exports = { pngBuffer, jpegBuffer };
