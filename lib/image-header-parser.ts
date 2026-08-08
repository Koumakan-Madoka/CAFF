export type ParsedImageHeader = {
  mimeType: string;
  width: number;
  height: number;
  animated: boolean;
  pixelCount: number;
};

export type HeaderParseResult =
  | { ok: true; header: ParsedImageHeader }
  | { ok: false; reason: string };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_RIFF = Buffer.from('RIFF');
const WEBP_WEBP = Buffer.from('WEBP');
const GIF87 = Buffer.from('GIF87a');
const GIF89 = Buffer.from('GIF89a');

function readUInt16BE(buffer: Buffer, offset: number) {
  return buffer.readUInt16BE(offset);
}

function readUInt32BE(buffer: Buffer, offset: number) {
  return buffer.readUInt32BE(offset);
}

function matches(buffer: Buffer, offset: number, signature: Buffer) {
  if (offset + signature.length > buffer.length) {
    return false;
  }

  return signature.equals(buffer.subarray(offset, offset + signature.length));
}

function parsePng(buffer: Buffer): HeaderParseResult {
  if (!matches(buffer, 0, PNG_SIGNATURE)) {
    return { ok: false, reason: 'PNG_MAGIC_MISMATCH' };
  }

  if (buffer.length < 24) {
    return { ok: false, reason: 'PNG_HEADER_TRUNCATED' };
  }

  const length = readUInt32BE(buffer, 8);
  const chunkType = buffer.toString('ascii', 12, 16);

  if (chunkType !== 'IHDR') {
    return { ok: false, reason: 'PNG_IHDR_MISSING' };
  }

  const width = readUInt32BE(buffer, 16);
  const height = readUInt32BE(buffer, 20);

  if (width <= 0 || height <= 0) {
    return { ok: false, reason: 'PNG_INVALID_DIMENSIONS' };
  }

  return {
    ok: true,
    header: {
      mimeType: 'image/png',
      width,
      height,
      animated: false,
      pixelCount: width * height,
    },
  };
}

function parseJpeg(buffer: Buffer): HeaderParseResult {
  if (!matches(buffer, 0, JPEG_SIGNATURE)) {
    return { ok: false, reason: 'JPEG_MAGIC_MISMATCH' };
  }

  let offset = 2;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      return { ok: false, reason: 'JPEG_MARKER_MISSING' };
    }

    const marker = buffer[offset + 1];

    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    if (offset + 4 > buffer.length) {
      return { ok: false, reason: 'JPEG_HEADER_TRUNCATED' };
    }

    const segmentLength = readUInt16BE(buffer, offset + 2);

    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
      if (offset + 9 > buffer.length) {
        return { ok: false, reason: 'JPEG_SOF_TRUNCATED' };
      }

      const height = readUInt16BE(buffer, offset + 5);
      const width = readUInt16BE(buffer, offset + 7);

      if (width <= 0 || height <= 0) {
        return { ok: false, reason: 'JPEG_INVALID_DIMENSIONS' };
      }

      return {
        ok: true,
        header: {
          mimeType: 'image/jpeg',
          width,
          height,
          animated: false,
          pixelCount: width * height,
        },
      };
    }

    if (segmentLength < 2) {
      return { ok: false, reason: 'JPEG_BAD_SEGMENT_LENGTH' };
    }

    offset += 2 + 2 + segmentLength;
  }

  return { ok: false, reason: 'JPEG_SOF_NOT_FOUND' };
}

function parseWebp(buffer: Buffer): HeaderParseResult {
  if (
    !matches(buffer, 0, WEBP_RIFF) ||
    !matches(buffer, 8, WEBP_WEBP) ||
    buffer.length < 20
  ) {
    return { ok: false, reason: 'WEBP_MAGIC_MISMATCH' };
  }

  const chunkTag = buffer.toString('ascii', 12, 16);

  if (chunkTag === 'VP8X') {
    if (buffer.length < 30) {
      return { ok: false, reason: 'WEBP_VP8X_TRUNCATED' };
    }

    const widthMinus1 = buffer.readUIntLE(24, 3);
    const heightMinus1 = buffer.readUIntLE(27, 3);
    const width = widthMinus1 + 1;
    const height = heightMinus1 + 1;

    return {
      ok: true,
      header: {
        mimeType: 'image/webp',
        width,
        height,
        animated: false,
        pixelCount: width * height,
      },
    };
  }

  if (chunkTag === 'VP8L') {
    if (buffer.length < 25) {
      return { ok: false, reason: 'WEBP_VP8L_TRUNCATED' };
    }

    const bits = buffer.readUInt32LE(20);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;

    return {
      ok: true,
      header: {
        mimeType: 'image/webp',
        width,
        height,
        animated: false,
        pixelCount: width * height,
      },
    };
  }

  if (chunkTag === 'VP8 ') {
    if (buffer.length < 26) {
      return { ok: false, reason: 'WEBP_VP8_TRUNCATED' };
    }

    const width = readUInt16BE(buffer, 22) & 0x3fff;
    const height = readUInt16BE(buffer, 24) & 0x3fff;

    if (width <= 0 || height <= 0) {
      return { ok: false, reason: 'WEBP_INVALID_DIMENSIONS' };
    }

    return {
      ok: true,
      header: {
        mimeType: 'image/webp',
        width,
        height,
        animated: false,
        pixelCount: width * height,
      },
    };
  }

  return { ok: false, reason: 'WEBP_UNKNOWN_CHUNK' };
}

function parseGif(buffer: Buffer): HeaderParseResult {
  const animated = matches(buffer, 0, GIF89);

  if (!matches(buffer, 0, GIF87) && !animated) {
    return { ok: false, reason: 'GIF_MAGIC_MISMATCH' };
  }

  if (buffer.length < 10) {
    return { ok: false, reason: 'GIF_HEADER_TRUNCATED' };
  }

  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);

  if (width <= 0 || height <= 0) {
    return { ok: false, reason: 'GIF_INVALID_DIMENSIONS' };
  }

  if (animated) {
    return { ok: false, reason: 'ANIMATED_GIF_REJECTED' };
  }

  return {
    ok: true,
    header: {
      mimeType: 'image/gif',
      width,
      height,
      animated: false,
      pixelCount: width * height,
    },
  };
}

export function parseImageHeader(buffer: Buffer): HeaderParseResult {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: 'EMPTY_BUFFER' };
  }

  if (matches(buffer, 0, PNG_SIGNATURE)) {
    return parsePng(buffer);
  }

  if (matches(buffer, 0, JPEG_SIGNATURE)) {
    return parseJpeg(buffer);
  }

  if (matches(buffer, 0, WEBP_RIFF) && matches(buffer, 8, WEBP_WEBP)) {
    return parseWebp(buffer);
  }

  if (matches(buffer, 0, GIF87) || matches(buffer, 0, GIF89)) {
    return parseGif(buffer);
  }

  return { ok: false, reason: 'UNSUPPORTED_MAGIC' };
}
