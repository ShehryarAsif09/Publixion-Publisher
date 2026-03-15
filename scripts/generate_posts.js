/**
 * Publixion Post Generator
 * Supports: book, guide, report, magazine
 * Each type has its own post schedule and platform rules.
 *
 * Usage:
 *   node scripts/generate_posts.js --input posts/templates/book-name.json
 */

const fs   = require('fs');
const path = require('path');

const args      = process.argv.slice(2);
const inputFlag = args.indexOf('--input');
if (inputFlag === -1 || !args[inputFlag + 1]) {
  console.error('Usage: node scripts/generate_posts.js --input posts/templates/YOUR-TEMPLATE.json');
  process.exit(1);
}

const TEMPLATE_PATH = path.join(__dirname, '..', args[inputFlag + 1]);
const QUEUE_PATH    = path.join(__dirname, '../posts/queue.json');

const tmpl  = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
const queue = fs.existsSync(QUEUE_PATH) ? JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')) : [];

// ── SCHEDULES PER PRODUCT TYPE ────────────────────────────────────────
// Each entry: { type, day, platforms }
// platforms: which are enabled for this post type

const SCHEDULES = {

  book: [
    { type: 'identity_hook',      day: 0,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'author_positioning', day: 3,  linkedin: true,  facebook: true,  instagram: false },
    { type: 'chapter_carousel',   day: 6,  linkedin: false, facebook: false, instagram: true  },
    { type: 'controversial_take', day: 9,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'excerpt',            day: 13, linkedin: true,  facebook: true,  instagram: true  },
    { type: 'comparison',         day: 17, linkedin: true,  facebook: true,  instagram: false },
    { type: 'faq',                day: 22, linkedin: true,  facebook: true,  instagram: true  },
    { type: 'final_push',         day: 28, linkedin: true,  facebook: true,  instagram: true  },
  ],

  guide: [
    { type: 'pain_hook',          day: 0,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'framework_breakdown',day: 2,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'who_this_is_for',    day: 4,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'case_scenario',      day: 6,  linkedin: true,  facebook: true,  instagram: false },
    { type: 'objection_killer',   day: 9,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'scarcity_push',      day: 12, linkedin: true,  facebook: true,  instagram: true  },
  ],

  report: [
    { type: 'big_insight',        day: 0,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'trend_breakdown',    day: 3,  linkedin: true,  facebook: true,  instagram: false },
    { type: 'opportunity_angle',  day: 7,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'authority_reminder', day: 12, linkedin: true,  facebook: true,  instagram: true  },
  ],

  magazine: [
    { type: 'edition_tease',      day: -7, linkedin: true,  facebook: true,  instagram: true  },
    { type: 'cover_reveal',       day: -5, linkedin: true,  facebook: true,  instagram: true  },
    { type: 'table_of_contents',  day: -3, linkedin: true,  facebook: false, instagram: true  },
    { type: 'article_spotlight_1',day: 0,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'article_spotlight_2',day: 2,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'article_spotlight_3',day: 4,  linkedin: true,  facebook: true,  instagram: false },
    { type: 'article_quote_1',    day: 6,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'article_quote_2',    day: 8,  linkedin: false, facebook: true,  instagram: true  },
    { type: 'behind_the_scenes',  day: 10, linkedin: true,  facebook: true,  instagram: true  },
    { type: 'launch_announcement',day: 0,  linkedin: true,  facebook: true,  instagram: true  },
    { type: 'mid_month_reminder', day: 14, linkedin: true,  facebook: true,  instagram: true  },
    { type: 'last_call',          day: 25, linkedin: true,  facebook: true,  instagram: true  },
  ],

};

// ── VALIDATE ──────────────────────────────────────────────────────────
const VALID_TYPES = Object.keys(SCHEDULES);
const required    = ['id', 'title', 'item_type', 'priority', 'publish_date', 'url', 'image_url', 'posts'];

for (const field of required) {
  if (!tmpl[field]) { console.error(`Missing required field: "${field}"`); process.exit(1); }
}
if (!VALID_TYPES.includes(tmpl.item_type)) {
  console.error(`item_type must be one of: ${VALID_TYPES.join(', ')}`); process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(tmpl.publish_date)) {
  console.error('publish_date must be YYYY-MM-DD'); process.exit(1);
}

const schedule      = SCHEDULES[tmpl.item_type];
const expectedPosts = schedule.length;

if (tmpl.posts.length < expectedPosts) {
  console.error(`"${tmpl.item_type}" needs ${expectedPosts} posts, found ${tmpl.posts.length}`);
  process.exit(1);
}

// ── SLOT CONFIG ───────────────────────────────────────────────────────
const TIME_SLOTS   = ['04:00', '07:00', '11:00', '14:00'];
const MAX_PER_SLOT = 2;
const MAX_PER_DAY  = 8;

// ── HELPERS ───────────────────────────────────────────────────────────
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function generatePostId(itemId, postNum) {
  const prefix = itemId.split('-').map(w => w[0]).join('').toUpperCase().slice(0, 4);
  return `${prefix}-${String(postNum).padStart(3, '0')}`;
}

const REPO_OWNER = process.env.GITHUB_REPOSITORY_OWNER || 'YOUR-ORG';
const REPO_NAME  = process.env.GITHUB_REPOSITORY_NAME  || 'publixion-social';

function resolveUrl(p) {
  if (!p) return null;
  if (p.startsWith('http')) return p;
  return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${p}`;
}

function buildSlotMap(existingQueue) {
  const map = {};
  for (const post of existingQueue) {
    if (!post.scheduled_date || !post.scheduled_time) continue;
    if (!map[post.scheduled_date]) map[post.scheduled_date] = {};
    map[post.scheduled_date][post.scheduled_time] = (map[post.scheduled_date][post.scheduled_time] || 0) + 1;
  }
  return map;
}

function assignSlot(date, slotMap) {
  if (!slotMap[date]) slotMap[date] = {};
  const dayTotal = Object.values(slotMap[date]).reduce((a, b) => a + b, 0);
  if (dayTotal >= MAX_PER_DAY) return assignSlot(addDays(date, 1), slotMap);
  for (const slot of TIME_SLOTS) {
    const used = slotMap[date][slot] || 0;
    if (used < MAX_PER_SLOT) { slotMap[date][slot] = used + 1; return { date, time: slot }; }
  }
  return assignSlot(addDays(date, 1), slotMap);
}

function buildPlatform(enabled, text, imageUrl, carouselImages) {
  return {
    enabled,
    status:    enabled ? 'pending' : 'skipped',
    posted_at: null,
    post_id:   null,
    text:      enabled ? (text || '') : '',
    image_url: enabled ? imageUrl : null,
    ...(carouselImages && carouselImages.length > 0 && enabled ? { carousel_images: carouselImages } : {}),
  };
}

// ── GENERATE ──────────────────────────────────────────────────────────
const coverUrl     = resolveUrl(tmpl.image_url);
const carouselUrls = (tmpl.carousel_images || []).map(resolveUrl);
const slotMap      = buildSlotMap(queue);
const generated    = [];

// Magazine has pre-launch posts (negative day offsets)
// For those, base date is publish_date. addDays handles negative values correctly.

for (let i = 0; i < expectedPosts; i++) {
  const postData  = tmpl.posts[i];
  const slot_def  = schedule[i];
  const postId    = generatePostId(tmpl.id, i + 1);
  const idealDate = addDays(tmpl.publish_date, slot_def.day);
  const assigned  = assignSlot(idealDate, slotMap);

  // Carousel images: use for chapter_carousel (book) and cover_reveal / table_of_contents (magazine)
  const useCarousel = ['chapter_carousel', 'cover_reveal', 'table_of_contents'].includes(slot_def.type);

  generated.push({
    id:             postId,
    item_id:        tmpl.id,
    item_type:      tmpl.item_type,
    post_number:    i + 1,
    post_type:      slot_def.type,
    priority:       tmpl.priority,
    publish_date:   tmpl.publish_date,
    scheduled_date: assigned.date,
    scheduled_time: assigned.time,
    ideal_date:     idealDate,
    status:         'pending',
    posted_at:      null,
    platforms: {
      linkedin:  buildPlatform(slot_def.linkedin,  postData.linkedin,  coverUrl),
      facebook:  buildPlatform(slot_def.facebook,  postData.facebook,  coverUrl),
      instagram: buildPlatform(slot_def.instagram, postData.instagram, coverUrl, useCarousel ? carouselUrls : null),
    }
  });
}

const updated = [...queue, ...generated];
fs.writeFileSync(QUEUE_PATH, JSON.stringify(updated, null, 2));

console.log(`\n✓ "${tmpl.title}" [${tmpl.item_type}] — ${generated.length} posts generated`);
console.log(`  Publish date : ${tmpl.publish_date}\n`);
console.log('  Scheduled slots:');
for (const p of generated) {
  const shifted = p.scheduled_date !== p.ideal_date ? ` ← shifted (was ${p.ideal_date})` : '';
  console.log(`  Post ${String(p.post_number).padStart(2)} — ${p.scheduled_date} ${p.scheduled_time} UTC  [${p.post_type}]${shifted}`);
}
console.log(`\n✓ Queue total: ${updated.length} posts\n`);
