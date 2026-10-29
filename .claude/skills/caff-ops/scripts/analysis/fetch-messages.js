// Fetch every message of a CAFF room (read-only) into a JSON file.
// usage: node fetch-messages.js <conversationId> <outFile>
const fs = require('fs');

const BASE = process.env.CAFF_BASE_URL || 'http://127.0.0.1:3100';
const [roomId, outFile] = process.argv.slice(2);

async function main() {
  const all = [];
  let before = '';
  for (let page = 0; page < 50; page += 1) {
    const url = `${BASE}/api/conversations/${encodeURIComponent(roomId)}/messages?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const body = await res.json();
    all.unshift(...(body.items || []));
    if (!body.hasMore || !body.nextCursor) break;
    before = body.nextCursor;
  }
  fs.writeFileSync(outFile, JSON.stringify(all));
  console.log(`saved ${all.length} messages`);
  const sample = all[all.length - 1] || {};
  console.log(`keys: ${Object.keys(sample).join(', ')}`);
  console.log(`metadata keys: ${Object.keys(sample.metadata || {}).join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
