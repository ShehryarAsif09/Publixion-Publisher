/**
 * Publixion Batch Post Generator
 * Loops through ALL .json files in posts/templates/ and generates queue entries.
 *
 * Usage:
 *   node scripts/generate_all.js
 *   node scripts/generate_all.js --dry-run
 *   node scripts/generate_all.js --force
 *   node scripts/generate_all.js --skip-image-check
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const args    = process.argv.slice(2);
const FORCE   = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');
const SKIP_IMAGE_CHECK = args.includes('--skip-image-check');

const TEMPLATES_DIR = path.join(__dirname, '../posts/templates');
const QUEUE_PATH    = path.join(__dirname, '../posts/queue.json');

const REPO_OWNER = process.env.GITHUB_REPOSITORY_OWNER || 'ShehryarAsif09';
const REPO_NAME  = process.env.GITHUB_REPOSITORY_NAME  || 'Publixion-Publisher';

// ── SCHEDULES ─────────────────────────────────────────────────────────
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

const TIME_SLOTS   = ['04:00', '07:00', '11:00', '14:00'];
const MAX_PER_SLOT = 2;
const MAX_PER_DAY  = 8;

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function generatePostId(itemId, postNum) {
  const prefix = itemId.split('-').map(w => w[0]).join('').toUpperCase().slice(0, 4);
  return `${prefix}-${String(postNum).padStart(3, '0')}`;
}

function resolveUrl(p) {
  if (!p) return null;
  if (p.startsWith('http')) return p;
  return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${p}`;
}

function buildSlotMap(q) {
  const map = {};
  for (const post of q) {
    if (!post.scheduled_date || !post.scheduled_time) continue;
    if (!map[post.scheduled_date]) map[post.scheduled_date] = {};
    map[post.scheduled_date][post.scheduled_time] = (map[post.scheduled_date][post.scheduled_time] || 0) + 1;
  }
  return map;
}

function assignSlot(date, slotMap) {
  if (!slotMap[date]) slotMap[date] = {};
  const total = Object.values(slotMap[date]).reduce((a, b) => a + b, 0);
  if (total >= MAX_PER_DAY) return assignSlot(addDays(date, 1), slotMap);
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

function validateTemplate(tmpl) {
  const required = ['id', 'title', 'item_type', 'priority', 'publish_date', 'url', 'image_url', 'posts'];
  const missing  = required.filter(f => !tmpl[f]);
  if (missing.length > 0) return `Missing fields: ${missing.join(', ')}`;
  if (!SCHEDULES[tmpl.item_type]) return `item_type must be: ${Object.keys(SCHEDULES).join(', ')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tmpl.publish_date)) return `publish_date must be YYYY-MM-DD`;
  const needed = SCHEDULES[tmpl.item_type].length;
  if (tmpl.posts.length < needed) return `"${tmpl.item_type}" needs ${needed} posts, found ${tmpl.posts.length}`;
  return null;
}

function generateForTemplate(tmpl, slotMap) {
  const schedule     = SCHEDULES[tmpl.item_type];
  const coverUrl     = resolveUrl(tmpl.image_url);
  const carouselUrls = (tmpl.carousel_images || []).map(resolveUrl);
  const generated    = [];

  for (let i = 0; i < schedule.length; i++) {
    const slot_def   = schedule[i];
    const postData   = tmpl.posts[i];
    const idealDate  = addDays(tmpl.publish_date, slot_def.day);
    const assigned   = assignSlot(idealDate, slotMap);
    const useCarousel = ['chapter_carousel', 'cover_reveal', 'table_of_contents'].includes(slot_def.type);

    generated.push({
      id:             generatePostId(tmpl.id, i + 1),
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
  return generated;
}

// ── IMAGE VALIDATION ──────────────────────────────────────────────────
function checkUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.request(url, { method: 'HEAD', timeout: 8000 }, (res) => {
      resolve({ ok: res.statusCode === 200, status: res.statusCode });
    });
    req.on('error', () => resolve({ ok: false, status: 'ERROR' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 'TIMEOUT' }); });
    req.end();
  });
}

async function validateAllImages(templates) {
  const errors = [];
  const checked = new Set();

  for (const tmpl of templates) {
    const urlsToCheck = [];

    if (tmpl.image_url) {
      urlsToCheck.push({ label: `[${tmpl.id}] image_url`, url: resolveUrl(tmpl.image_url) });
    }
    if (tmpl.carousel_images) {
      tmpl.carousel_images.forEach((img, i) => {
        urlsToCheck.push({ label: `[${tmpl.id}] carousel_images[${i}]`, url: resolveUrl(img) });
      });
    }

    for (const { label, url } of urlsToCheck) {
      if (!url || checked.has(url)) continue;
      checked.add(url);
      const result = await checkUrl(url);
      if (!result.ok) {
        errors.push(`  ✗ ${label} → HTTP ${result.status}\n    URL: ${url}`);
      }
    }
  }
  return errors;
}

// ── MAIN ──────────────────────────────────────────────────────────────
async function main() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  PUBLIXION — BATCH POST GENERATOR');
  if (DRY_RUN) console.log('  MODE: DRY RUN (nothing written)');
  if (FORCE)   console.log('  MODE: FORCE (re-generating existing items)');
  if (SKIP_IMAGE_CHECK) console.log('  MODE: SKIP IMAGE CHECK');
  console.log('═══════════════════════════════════════════════════════\n');

  const files = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('TEMPLATE'))
    .sort();

  if (files.length === 0) {
    console.log('No template files found in posts/templates/\n');
    return;
  }

  console.log(`Found ${files.length} template file(s).\n`);

  // Load all valid templates first
  const validTemplates = [];
  const loadErrors = [];

  for (const file of files) {
    let tmpl;
    try {
      tmpl = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8'));
    } catch (e) {
      loadErrors.push({ file, reason: `Invalid JSON: ${e.message}` });
      continue;
    }
    const err = validateTemplate(tmpl);
    if (err) { loadErrors.push({ file, reason: err }); continue; }
    validTemplates.push({ file, tmpl });
  }

  // ── IMAGE VALIDATION ──────────────────────────────────────────────
  if (!SKIP_IMAGE_CHECK) {
    console.log('  Checking all image URLs (this may take 30-60 seconds)...\n');
    const imageErrors = await validateAllImages(validTemplates.map(v => v.tmpl));

    if (imageErrors.length > 0) {
      console.log('═══════════════════════════════════════════════════════');
      console.log('  ❌ IMAGE VALIDATION FAILED — Fix these before generating:');
      console.log('═══════════════════════════════════════════════════════');
      imageErrors.forEach(e => console.log(e));
      console.log('\n  Fix the image filenames in your templates and run again.');
      console.log('  To skip this check: node scripts/generate_all.js --skip-image-check\n');
      process.exit(1);
    } else {
      console.log('  ✓ All image URLs verified successfully!\n');
    }
  }

  // ── GENERATE ──────────────────────────────────────────────────────
  let queue = fs.existsSync(QUEUE_PATH) ? JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')) : [];
  const existingIds = new Set(queue.map(p => p.item_id));
  const slotMap     = buildSlotMap(queue);
  const results     = { generated: [], skipped: [], errors: loadErrors };

  for (const { file, tmpl } of validTemplates) {
    if (existingIds.has(tmpl.id) && !FORCE) {
      results.skipped.push({ file, id: tmpl.id });
      continue;
    }

    if (FORCE && existingIds.has(tmpl.id)) {
      queue = queue.filter(p => p.item_id !== tmpl.id);
    }

    const generated = generateForTemplate(tmpl, slotMap);
    if (!DRY_RUN) { queue.push(...generated); existingIds.add(tmpl.id); }

    results.generated.push({ file, id: tmpl.id, title: tmpl.title, type: tmpl.item_type, count: generated.length, first: generated[0].scheduled_date, last: generated[generated.length - 1].scheduled_date });
    console.log(`  ✓ [${tmpl.item_type.padEnd(8)}] ${tmpl.title.padEnd(45)} ${generated.length} posts  (${generated[0].scheduled_date} → ${generated[generated.length-1].scheduled_date})`);
  }

  if (!DRY_RUN && results.generated.length > 0) {
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════');

  const totalPosts = results.generated.reduce((a, r) => a + r.count, 0);
  console.log(`  Generated : ${results.generated.length} items  (${totalPosts} posts)`);
  console.log(`  Skipped   : ${results.skipped.length} items (already in queue — use --force to override)`);
  console.log(`  Errors    : ${results.errors.length} items`);
  console.log(`  Queue total: ${queue.length} posts`);

  if (results.errors.length > 0) {
    console.log('\n  ERRORS — fix these and run again:');
    for (const e of results.errors) console.log(`  ✗ ${e.file}: ${e.reason}`);
  }

  if (!DRY_RUN && results.generated.length > 0) {
    console.log('\n  Next step:');
    console.log('  git add posts/queue.json && git commit -m "Batch generate" && git push\n');
  } else if (DRY_RUN) {
    console.log('\n  DRY RUN — nothing written. Remove --dry-run to apply.\n');
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
