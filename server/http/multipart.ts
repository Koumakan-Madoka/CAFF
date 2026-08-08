export type MultipartFilePart = {
  fieldName: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
};

export type MultipartParseResult =
  | { ok: true; fields: Record<string, string>; files: MultipartFilePart[] }
  | { ok: false; reason: string };

function extractBoundary(contentType: string) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return match ? match[1] || match[2] : '';
}

function parseContentDisposition(value: string) {
  const nameMatch = value.match(/name="([^"]*)"/);
  const filenameMatch = value.match(/filename="([^"]*)"/);
  const typeMatch = value.match(/content-type:\s*([^\r\n;]+)/i);

  return {
    name: nameMatch ? nameMatch[1] : '',
    fileName: filenameMatch ? filenameMatch[1] : '',
    mimeType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
  };
}

export function parseMultipart(body: Buffer, contentType: string): MultipartParseResult {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return { ok: false, reason: 'EMPTY_BODY' };
  }

  const boundary = extractBoundary(contentType);

  if (!boundary) {
    return { ok: false, reason: 'MISSING_BOUNDARY' };
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const terminator = Buffer.from(`--${boundary}--`);

  const terminatorIndex = body.indexOf(terminator);

  if (terminatorIndex < 0) {
    return { ok: false, reason: 'MISSING_TERMINATOR' };
  }

  const fields: Record<string, string> = {};
  const files: MultipartFilePart[] = [];
  let cursor = 0;

  while (cursor < body.length) {
    const nextDelimiterIndex = body.indexOf(delimiter, cursor);

    if (nextDelimiterIndex < 0) {
      break;
    }

    const partStart = nextDelimiterIndex + delimiter.length;

    if (body.subarray(partStart, partStart + 2).toString() === '--') {
      break;
    }

    const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), partStart);

    if (headersEnd < 0) {
      return { ok: false, reason: 'MISSING_HEADER_TERMINATOR' };
    }

    const headersText = body.subarray(partStart, headersEnd).toString('utf8');
    const contentStart = headersEnd + 4;
    const nextPartIndex = body.indexOf(delimiter, contentStart);

    if (nextPartIndex < 0) {
      return { ok: false, reason: 'UNCLOSED_PART' };
    }

    let contentEnd = nextPartIndex;

    if (body.subarray(contentEnd - 2, contentEnd).toString() === '\r\n') {
      contentEnd -= 2;
    }

    const content = body.subarray(contentStart, contentEnd);
    const disposition = parseContentDisposition(headersText);

    if (!disposition.name) {
      return { ok: false, reason: 'PART_WITHOUT_NAME' };
    }

    if (disposition.fileName) {
      files.push({
        fieldName: disposition.name,
        fileName: disposition.fileName,
        mimeType: disposition.mimeType,
        content: Buffer.from(content),
      });
    } else {
      fields[disposition.name] = content.toString('utf8');
    }

    cursor = nextPartIndex;
  }

  return { ok: true, fields, files };
}
