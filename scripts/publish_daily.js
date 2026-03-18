/**
 * Publixion Social Media Publisher
 * ─────────────────────────────────────────────────────────────────────
 * Runs on cron 4x/day at 04:00, 07:00, 11:00, 14:00 UTC.
 * Each run picks posts whose scheduled_date = today AND scheduled_time = current slot.
 * Never posts early. Never posts more than 2 per slot.
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const CONFIG = {
  QUEUE_PATH:  path.join(__dirname, '../posts/queue.json'),
  STATE_PATH:  path.join(__dirname, '../state/tracker.json'),

  LI_ACCESS_TOKEN:      process.env.LI_ACCESS_TOKEN,
  LI_PERSON_URN:        process.env.LI_PERSON_URN,
  LI_PAGE_URN:          process.env.LI_PAGE_URN,

  FB_PAGE_ACCESS_TOKEN: process.env.FB_PAGE_ACCESS_TOKEN,
  FB_PAGE_ID:           process.env.FB_PAGE_ID,

  IG_ACCESS_TOKEN:      process.env.IG_ACCESS_TOKEN,
  IG_ACCOUNT_ID:        process.env.IG_ACCOUNT_ID,

  GITHUB_TOKEN:         process.env.GITHUB_TOKEN,
  GITHUB_REPO_OWNER:    process.env.GITHUB_REPOSITORY_OWNER,
  GITHUB_REPO_NAME:     process.env.GITHUB_REPOSITORY_NAME,
};

function log(msg, level = 'INFO') {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Get current UTC date and time slot
function getCurrentSlot() {
  const now  = new Date();
  const date = now.toISOString().split('T')[0];
  const hour = now.getUTCHours();

  // Map current hour to nearest slot
  // Slots: 04:00, 07:00, 11:00, 14:00
  // Each cron run fires AT the slot time, so we match exactly
  const slotMap = { 4: '04:00', 7: '07:00', 11: '11:00', 14: '14:00' };
  const slot    = slotMap[hour] || '04:00';

  return { date, slot };
}

// Pick posts due for this slot — includes overdue past-dated posts
function pickPostsForSlot(queue, date, slot) {
  return queue.filter(post => {
    if (post.status === 'done') return false;
    if (post.scheduled_date > date) return false;
    if (post.scheduled_date === date && post.scheduled_time !== slot) return false;
    return Object.values(post.platforms).some(p => p.enabled && p.status === 'pending');
  }).sort((a, b) => {
    if (a.scheduled_date !== b.scheduled_date) return a.scheduled_date.localeCompare(b.scheduled_date);
    return a.priority - b.priority || a.post_number - b.post_number;
  }).slice(0, 2);
}

// ── LINKEDIN ──────────────────────────────────────────────────────────
async function postToLinkedIn(post) {
  const pl = post.platforms.linkedin;
  if (!pl.enabled || pl.status !== 'pending') return { success: false, skipped: true };

  const authorUrn = CONFIG.LI_PAGE_URN || CONFIG.LI_PERSON_URN;

  try {
    let mediaAsset;
    if (pl.image_url) mediaAsset = await uploadLinkedInImage(pl.image_url, authorUrn);

    const res = await axios.post('https://api.linkedin.com/v2/ugcPosts', {
      author: authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: pl.text },
          shareMediaCategory: mediaAsset ? 'IMAGE' : 'NONE',
          ...(mediaAsset ? { media: [{ status: 'READY', media: mediaAsset, title: { text: 'Publixion' } }] } : {}),
        }
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    }, {
      headers: {
        Authorization: `Bearer ${CONFIG.LI_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      }
    });

    const postId = res.headers['x-restli-id'] || res.data?.id || 'unknown';
    log(`LinkedIn OK: ${post.id} → ${postId}`);
    return { success: true, post_id: postId };
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log(`LinkedIn FAIL: ${post.id} → ${detail}`, 'ERROR');
    return { success: false, error: detail };
  }
}

async function uploadLinkedInImage(imageUrl, authorUrn) {
  const reg = await axios.post(
    'https://api.linkedin.com/v2/assets?action=registerUpload',
    { registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: authorUrn,
        serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }]
    }},
    { headers: { Authorization: `Bearer ${CONFIG.LI_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  const uploadUrl = reg.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
  const assetUrn  = reg.data.value.asset;
  const img = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  await axios.put(uploadUrl, img.data, {
    headers: { Authorization: `Bearer ${CONFIG.LI_ACCESS_TOKEN}`, 'Content-Type': 'image/jpeg' }
  });
  return assetUrn;
}

// ── FACEBOOK ──────────────────────────────────────────────────────────
async function postToFacebook(post) {
  const pl = post.platforms.facebook;
  if (!pl.enabled || pl.status !== 'pending') return { success: false, skipped: true };

  try {
    const endpoint = pl.image_url
      ? `https://graph.facebook.com/v19.0/${CONFIG.FB_PAGE_ID}/photos`
      : `https://graph.facebook.com/v19.0/${CONFIG.FB_PAGE_ID}/feed`;

    const res    = await axios.post(endpoint, {
      message: pl.text,
      access_token: CONFIG.FB_PAGE_ACCESS_TOKEN,
      ...(pl.image_url ? { url: pl.image_url } : {}),
    });
    const postId = res.data.id || res.data.post_id || 'unknown';
    log(`Facebook OK: ${post.id} → ${postId}`);
    return { success: true, post_id: postId };
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log(`Facebook FAIL: ${post.id} → ${detail}`, 'ERROR');
    return { success: false, error: detail };
  }
}

// ── INSTAGRAM ─────────────────────────────────────────────────────────
async function postToInstagram(post) {
  const pl = post.platforms.instagram;
  if (!pl.enabled || pl.status !== 'pending') return { success: false, skipped: true };

  try {
    if (pl.carousel_images && pl.carousel_images.length > 1) {
      return await postInstagramCarousel(post, pl);
    }
    return await postInstagramSingle(post, pl);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log(`Instagram FAIL: ${post.id} → ${detail}`, 'ERROR');
    return { success: false, error: detail };
  }
}

async function postInstagramSingle(post, pl) {
  const c = await axios.post(
    `https://graph.facebook.com/v19.0/${CONFIG.IG_ACCOUNT_ID}/media`,
    { image_url: pl.image_url, caption: pl.text, access_token: CONFIG.IG_ACCESS_TOKEN }
  );
  await sleep(3000);
  const p = await axios.post(
    `https://graph.facebook.com/v19.0/${CONFIG.IG_ACCOUNT_ID}/media_publish`,
    { creation_id: c.data.id, access_token: CONFIG.IG_ACCESS_TOKEN }
  );
  log(`Instagram OK (single): ${post.id} → ${p.data.id}`);
  return { success: true, post_id: p.data.id };
}

async function postInstagramCarousel(post, pl) {
  const childIds = [];
  for (const imgUrl of pl.carousel_images) {
    const r = await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.IG_ACCOUNT_ID}/media`,
      { image_url: imgUrl, is_carousel_item: true, access_token: CONFIG.IG_ACCESS_TOKEN }
    );
    childIds.push(r.data.id);
    await sleep(1500);
  }
  const car = await axios.post(
    `https://graph.facebook.com/v19.0/${CONFIG.IG_ACCOUNT_ID}/media`,
    { media_type: 'CAROUSEL', children: childIds.join(','), caption: pl.text, access_token: CONFIG.IG_ACCESS_TOKEN }
  );
  await sleep(3000);
  const p = await axios.post(
    `https://graph.facebook.com/v19.0/${CONFIG.IG_ACCOUNT_ID}/media_publish`,
    { creation_id: car.data.id, access_token: CONFIG.IG_ACCESS_TOKEN }
  );
  log(`Instagram OK (carousel): ${post.id} → ${p.data.id}`);
  return { success: true, post_id: p.data.id };
}

// ── STATE UPDATE ──────────────────────────────────────────────────────
function updatePostState(queue, postId, platformName, result) {
  const post = queue.find(p => p.id === postId);
  if (!post || result.skipped) return;
  const pl     = post.platforms[platformName];
  pl.status    = result.success ? 'posted' : 'failed';
  pl.posted_at = result.success ? new Date().toISOString() : null;
  pl.post_id   = result.post_id || null;
  if (!result.success) pl.error = result.error;

  const allDone = Object.values(post.platforms).every(
    p => !p.enabled || ['posted', 'failed', 'skipped'].includes(p.status)
  );
  if (allDone) { post.status = 'done'; post.posted_at = new Date().toISOString(); }
}

// ── GITHUB COMMIT ─────────────────────────────────────────────────────
async function commitToGitHub(repoPath, content, message) {
  if (!CONFIG.GITHUB_TOKEN) { log('No GITHUB_TOKEN — local mode', 'WARN'); return; }
  const apiUrl = `https://api.github.com/repos/${CONFIG.GITHUB_REPO_OWNER}/${CONFIG.GITHUB_REPO_NAME}/contents/${repoPath}`;
  let sha;
  try { sha = (await axios.get(apiUrl, { headers: { Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}` } })).data.sha; } catch (_) {}
  await axios.put(apiUrl, {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    sha,
    committer: { name: 'Publixion Bot', email: 'bot@publixion.com' }
  }, { headers: { Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}`, 'Content-Type': 'application/json' } });
  log(`GitHub committed: ${repoPath}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────
async function main() {
  const { date, slot } = getCurrentSlot();

  if (!slot) {
    log(`Current hour does not match any slot. Exiting. (Run at 04:00, 07:00, 11:00, or 14:00 UTC)`);
    return;
  }

  log(`=== Publixion Publisher — ${date} ${slot} UTC ===`);

  const queue = JSON.parse(fs.readFileSync(CONFIG.QUEUE_PATH, 'utf8'));
  const state = JSON.parse(fs.readFileSync(CONFIG.STATE_PATH, 'utf8'));
  const posts = pickPostsForSlot(queue, date, slot);

  // Report future posts
  const futureCount = queue.filter(p => p.status === 'pending' && p.scheduled_date > date).length;
  log(`Posts due this slot: ${posts.length} | Waiting on future dates: ${futureCount}`);

  if (posts.length === 0) { log('Nothing due this slot. Exiting.'); return; }

  const runLog = { started_at: new Date().toISOString(), date, slot, posts: [] };

  for (const post of posts) {
    log(`--- ${post.id} | ${post.post_type} ---`);
    const postLog = { id: post.id, platforms: {} };

    const li = await postToLinkedIn(post);
    updatePostState(queue, post.id, 'linkedin', li);
    postLog.platforms.linkedin = li;
    await sleep(2000);

    const fb = await postToFacebook(post);
    updatePostState(queue, post.id, 'facebook', fb);
    postLog.platforms.facebook = fb;
    await sleep(2000);

    const ig = await postToInstagram(post);
    updatePostState(queue, post.id, 'instagram', ig);
    postLog.platforms.instagram = ig;
    await sleep(2000);

    const ok   = [li, fb, ig].filter(r => r.success).length;
    const fail = [li, fb, ig].filter(r => !r.success && !r.skipped).length;
    state.total_posted += ok;
    state.total_failed += fail;
    runLog.posts.push(postLog);
    log(`${post.id}: ${ok} posted, ${fail} failed`);
  }

  runLog.completed_at = new Date().toISOString();
  state.last_run = runLog.completed_at;
  state.run_log.unshift(runLog);
  if (state.run_log.length > 120) state.run_log.pop();

  fs.writeFileSync(CONFIG.QUEUE_PATH, JSON.stringify(queue, null, 2));
  fs.writeFileSync(CONFIG.STATE_PATH, JSON.stringify(state, null, 2));

  await commitToGitHub('posts/queue.json',   queue, `[bot] ${date} ${slot} — queue`);
  await commitToGitHub('state/tracker.json', state, `[bot] ${date} ${slot} — state`);

  log(`=== Done. All-time: ${state.total_posted} posted, ${state.total_failed} failed ===`);
}

main().catch(err => { log(`FATAL: ${err.message}`, 'ERROR'); process.exit(1); });
