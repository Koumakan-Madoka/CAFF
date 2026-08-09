const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMultipart } = require('../../build/server/http/multipart');

function buildMultipartBody(fields, boundary = '----testboundary') {
  const parts = [];
  const delim = `--${boundary}`;

  for (const field of fields) {
    parts.push(delim);
    parts.push(`Content-Disposition: form-data; name="${field.name}"${field.filename ? `; filename="${field.filename}"` : ''}`);
    if (field.type) {
      parts.push(`Content-Type: ${field.type}`);
    }
    parts.push('');
    parts.push(field.value);
  }

  parts.push(`${delim}--`);
  parts.push('');

  return Buffer.from(parts.join('\r\n'));
}

test('parses a single text field', () => {
  const body = buildMultipartBody([{ name: 'client_request_id', value: 'req-123' }]);
  const result = parseMultipart(body, 'multipart/form-data; boundary=----testboundary');
  assert.ok(result.ok);
  assert.equal(result.fields.client_request_id, 'req-123');
  assert.equal(result.files.length, 0);
});

test('parses a binary file part with content type', () => {
  const body = buildMultipartBody([
    { name: 'client_request_id', value: 'req-1' },
    {
      name: 'files',
      filename: 'photo.png',
      type: 'image/png',
      value: 'FAKE_PNG_BYTES',
    },
  ]);
  const result = parseMultipart(body, 'multipart/form-data; boundary=----testboundary');
  assert.ok(result.ok);
  assert.equal(result.fields.client_request_id, 'req-1');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].fieldName, 'files');
  assert.equal(result.files[0].fileName, 'photo.png');
  assert.equal(result.files[0].mimeType, 'image/png');
  assert.equal(result.files[0].content.toString('utf8'), 'FAKE_PNG_BYTES');
});

test('parses multiple file parts preserving order', () => {
  const body = buildMultipartBody([
    { name: 'files', filename: 'a.png', value: 'AAA' },
    { name: 'files', filename: 'b.png', value: 'BBB' },
  ]);
  const result = parseMultipart(body, 'multipart/form-data; boundary=----testboundary');
  assert.ok(result.ok);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].fileName, 'a.png');
  assert.equal(result.files[1].fileName, 'b.png');
  assert.equal(result.files[1].content.toString('utf8'), 'BBB');
});

test('rejects missing boundary in content-type header', () => {
  const body = buildMultipartBody([{ name: 'a', value: '1' }]);
  const result = parseMultipart(body, 'multipart/form-data');
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('rejects malformed multipart body without terminator', () => {
  const body = Buffer.from('--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1');
  const result = parseMultipart(body, 'multipart/form-data; boundary=x');
  assert.equal(result.ok, false);
});
