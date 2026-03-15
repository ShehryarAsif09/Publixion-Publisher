/**
 * Publixion Queue Status
 * Run: node scripts/status.js
 * Shows a live summary of the post queue — what's done, pending, failed.
 */

const fs   = require('fs');
const path = require('path');

const queue = JSON.parse(fs.readFileSync(path.join(__dirname, '../posts/queue.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, '../state/tracker.json'), 'utf8'));

const total   = queue.length;
const done    = queue.filter(p => p.status === 'done').length;
const pending = queue.filter(p => p.status === 'pending').length;
const failed  = queue.filter(p =>
  Object.values(p.platforms).some(pl => pl.status === 'failed')
).length;

console.log('\n═══════════════════════════════════════════');
console.log('  PUBLIXION SOCIAL — QUEUE STATUS');
console.log('═══════════════════════════════════════════');
console.log(`  Total posts in queue : ${total}`);
console.log(`  Published (done)     : ${done}`);
console.log(`  Pending              : ${pending}`);
console.log(`  Has failures         : ${failed}`);
console.log(`  Last run             : ${state.last_run || 'Never'}`);
console.log(`  Total ever posted    : ${state.total_posted}`);
console.log(`  Total ever failed    : ${state.total_failed}`);
console.log('═══════════════════════════════════════════');

// Break down by item
const byItem = {};
for (const post of queue) {
  if (!byItem[post.item_id]) byItem[post.item_id] = { done: 0, pending: 0, total: 0 };
  byItem[post.item_id].total++;
  if (post.status === 'done') byItem[post.item_id].done++;
  else byItem[post.item_id].pending++;
}

console.log('\n  BY ITEM:');
for (const [itemId, counts] of Object.entries(byItem)) {
  const bar = '█'.repeat(counts.done) + '░'.repeat(counts.pending);
  console.log(`  ${itemId.padEnd(40)} ${bar}  ${counts.done}/${counts.total}`);
}

// Show any failed posts
const failedPosts = queue.filter(p =>
  Object.values(p.platforms).some(pl => pl.status === 'failed')
);

if (failedPosts.length > 0) {
  console.log('\n  FAILED POSTS (need attention):');
  for (const post of failedPosts) {
    for (const [platform, pl] of Object.entries(post.platforms)) {
      if (pl.status === 'failed') {
        console.log(`  ✗ ${post.id} → ${platform}: ${pl.error || 'unknown error'}`);
      }
    }
  }
}

console.log('');
