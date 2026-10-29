#!/usr/bin/env node
// Block until a CAFF room has no active assistant turn and its latest message is
// from an assistant, then print one line and exit. Meant for Claude Code's Bash
// run_in_background: the exit wakes the session, so nobody has to poll.
//
// usage: node wait-turn.js <conversation UUID> [maxMinutes=60]
// exit:  0 = turn finished (prints sender, status, message id), 2 = timed out
// Read-only: it only GETs /api/conversations/:id/messages every 20 seconds.
const id = process.argv[2];
if (!id) {
  console.error('usage: node wait-turn.js <conversation UUID> [maxMinutes]');
  process.exit(1);
}
const maxMs = Number(process.argv[3] || 60) * 60000;
const base = process.env.CAFF_BASE_URL || 'http://127.0.0.1:3100';
const start = Date.now();

async function tick() {
  try {
    const res = await fetch(`${base}/api/conversations/${id}/messages?limit=10`);
    const body = await res.json();
    const items = body.items || [];
    const active = items.filter((m) => ['queued', 'running', 'streaming'].includes(m.status));
    const last = items[items.length - 1];
    if (!active.length && last && last.role === 'assistant') {
      console.log(`done: last=${last.senderName || last.agentId || '?'} status=${last.status} id=${last.id}`);
      process.exit(0);
    }
  } catch (error) {
    // transient fetch failure (instance restarting, etc.): keep polling
  }
  if (Date.now() - start > maxMs) {
    console.log(`timeout: room ${id} still has an active turn after ${Math.round(maxMs / 60000)} min`);
    process.exit(2);
  }
  setTimeout(tick, 20000);
}

tick();
