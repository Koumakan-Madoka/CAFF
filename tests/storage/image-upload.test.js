const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const { migrateChatSchema } = require('../../build/storage/sqlite/migrations');
const { withTempDir } = require('../helpers/temp-dir');

function listColumnNames(db, tableName) {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => String(column.name))
  );
}

function tableSql(db, tableName) {
  return String(
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(tableName)?.sql || ''
  );
}

test('image upload migrations create image_upload_batches and image_uploads tables', (t) => {
  const tempDir = withTempDir('caff-image-upload-');
  const sqlitePath = path.join(tempDir, 'image-upload.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  migrateChatSchema(db);

  const batchColumns = listColumnNames(db, 'image_upload_batches');
  for (const column of [
    'batch_id',
    'conversation_id',
    'client_request_id',
    'request_fingerprint',
    'expected_count',
    'status',
    'lease_token',
    'lease_expires_at',
    'rejected_reason',
    'created_at',
    'completed_at',
  ]) {
    assert.ok(batchColumns.has(column), `image_upload_batches missing column ${column}`);
  }

  const uploadColumns = listColumnNames(db, 'image_uploads');
  for (const column of [
    'image_id',
    'batch_id',
    'status',
    'slot',
    'file_name',
    'stored_path',
    'mime_type',
    'width',
    'height',
    'size_bytes',
    'attached_message_id',
    'attached_at',
    'integrity_status',
    'integrity_error',
    'created_at',
    'ttl_expires_at',
  ]) {
    assert.ok(uploadColumns.has(column), `image_uploads missing column ${column}`);
  }
});

test('image_upload_batches enforces UNIQUE(conversation_id, client_request_id)', (t) => {
  const tempDir = withTempDir('caff-image-upload-');
  const sqlitePath = path.join(tempDir, 'image-upload.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  migrateChatSchema(db);
  db.prepare(
    `INSERT INTO image_upload_batches (
      batch_id, conversation_id, client_request_id, request_fingerprint, expected_count, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('b1', 'c1', 'req-1', 'fp-1', 1, 'pending', new Date().toISOString());

  assert.throws(() => {
    db.prepare(
      `INSERT INTO image_upload_batches (
        batch_id, conversation_id, client_request_id, request_fingerprint, expected_count, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('b2', 'c1', 'req-1', 'fp-2', 1, 'pending', new Date().toISOString());
  });
});

test('image_upload_batches CHECK constraints enforce expected_count range and status enum', (t) => {
  const tempDir = withTempDir('caff-image-upload-');
  const sqlitePath = path.join(tempDir, 'image-upload.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  migrateChatSchema(db);
  const now = new Date().toISOString();

  assert.throws(() => {
    db.prepare(
      `INSERT INTO image_upload_batches (
        batch_id, conversation_id, client_request_id, request_fingerprint, expected_count, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('b-bad-count', 'c1', 'req-0', 'fp-0', 0, 'pending', now);
  }, /CHECK/i);

  assert.throws(() => {
    db.prepare(
      `INSERT INTO image_upload_batches (
        batch_id, conversation_id, client_request_id, request_fingerprint, expected_count, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('b-bad-status', 'c1', 'req-1', 'fp-1', 1, 'not-a-status', now);
  }, /CHECK/i);
});

test('image_uploads enforces UNIQUE(batch_id, slot) and status/integrity enums', (t) => {
  const tempDir = withTempDir('caff-image-upload-');
  const sqlitePath = path.join(tempDir, 'image-upload.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  migrateChatSchema(db);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO image_upload_batches (
      batch_id, conversation_id, client_request_id, request_fingerprint, expected_count, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('b1', 'c1', 'req-1', 'fp-1', 2, 'pending', now);

  const insertImage = db.prepare(
    `INSERT INTO image_uploads (
      image_id, batch_id, status, slot, stored_path, integrity_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  insertImage.run('i1', 'b1', 'staged', 0, '/uploads/i1.png', 'ok', now);

  assert.throws(() => {
    insertImage.run('i2', 'b1', 'staged', 0, '/uploads/i2.png', 'ok', now);
  }, /UNIQUE/i);

  assert.throws(() => {
    insertImage.run('i3', 'b1', 'not-a-status', 1, '/uploads/i3.png', 'ok', now);
  }, /CHECK/i);

  assert.throws(() => {
    insertImage.run('i4', 'b1', 'staged', 1, '/uploads/i4.png', 'broken', now);
  }, /CHECK/i);
});
