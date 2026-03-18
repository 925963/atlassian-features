/**
 * Atlassian Cloud Feature Scraper
 * 
 * Fetches weekly Atlassian Cloud change blog posts and maintains a
 * deduplicated feature repository in data/features/ as JSON files.
 *
 * Run: node scripts/scrape.mjs
 * Backfill (process all available weeks): node scripts/scrape.mjs --backfill
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data', 'features');
const STATE_FILE = join(ROOT, 'data', 'scrape-state.json');
const BLOG_INDEX = 'https://confluence.atlassian.com/cloud/blog';

// Status constants — maps from text found on page to internal status key
const STATUS_MAP = {
  'ROLLING OUT NEW THIS WEEK': 'rolling_out_new',
  'NEW THIS WEEK': 'rolling_out_new',
  'ROLLING OUT': 'rolling_out',
  'COMING SOON': 'coming_soon',
};

// How many recent weeks to keep checking before marking a feature "complete"
// (A feature that hasn't appeared in the last COMPLETION_WEEKS weeks is considered done)
const COMPLETION_WEEKS = 4;

// ─── Utilities ──────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .substring(0, 80);
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { processed_weeks: [] };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadFeature(id) {
  const file = join(DATA_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function saveFeature(feature) {
  const file = join(DATA_DIR, `${feature.id}.json`);
  writeFileSync(file, JSON.stringify(feature, null, 2));
}

function loadAllFeatures() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')));
}

// Parse the week-start date from a blog URL like:
// /cloud/blog/2026/03/atlassian-cloud-changes-mar-9-to-mar-16-2026
function parseDateFromUrl(url) {
  const match = url.match(/(\d{4})\/(\d{2})\/atlassian-cloud-changes-/);
  if (!match) return null;
  // The URL slug contains the end-date, but the week *starts* on the Monday before.
  // We extract from the slug title text instead when possible; here we use the
  // URL year/month as a rough anchor and refine from the page title.
  return null; // refined below in parseWeekPage
}

// Parse "Mar 9 to Mar 16, 2026" → { start: "2026-03-09", end: "2026-03-16" }
function parseWeekRange(title) {
  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  // Match patterns like "Mar 9 to Mar 16, 2026" or "Dec 29 to Jan 5, 2026"
  const m = title.match(
    /([A-Za-z]+)\s+(\d+)\s+to\s+([A-Za-z]+)\s+(\d+),\s+(\d{4})/i
  );
  if (!m) return null;

  const [, m1, d1, m2, d2, year] = m;
  const mo1 = months[m1.toLowerCase()];
  const mo2 = months[m2.toLowerCase()];

  // Handle year boundary (e.g. Dec 29 to Jan 5)
  const y1 = mo1 === '01' && mo2 === '12' ? String(Number(year) - 1) : year;

  return {
    start: `${y1}-${mo1}-${d1.padStart(2, '0')}`,
    end: `${year}-${mo2}-${d2.padStart(2, '0')}`,
  };
}

// ─── Fetching ────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  console.log(`  Fetching: ${url}`);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'AtlassianFeatureTracker/1.0 (atlassianfeatures.valk.nu)',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function getBlogIndex() {
  const html = await fetchPage(BLOG_INDEX);
  const $ = cheerio.load(html);
  const weeks = [];

  // The blog index lists blog post links as <a href="...">Read more</a>
  // or as heading links — collect all unique blog week URLs
  $('a[href*="/cloud/blog/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.match(/\/cloud\/blog\/\d{4}\/\d{2}\/atlassian-cloud-changes-/)) {
      const full = href.startsWith('http') ? href : `https://confluence.atlassian.com${href}`;
      if (!weeks.find(w => w.url === full)) {
        weeks.push({ url: full });
      }
    }
  });

  return weeks;
}

// ─── Page parsing ────────────────────────────────────────────────────────────

function extractStatus(text) {
  const upper = text.toUpperCase().trim();
  for (const [key, val] of Object.entries(STATUS_MAP)) {
    if (upper.includes(key)) return val;
  }
  // If a feature appears without a status label, it's considered fully released
  return 'released';
}

/**
 * Parse a single week page and return an array of feature objects.
 */
async function parseWeekPage(url) {
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  // Extract week date range from page title
  const titleText = $('h1').first().text().trim();
  const weekRange = parseWeekRange(titleText);
  if (!weekRange) {
    console.warn(`  Could not parse week range from: ${titleText}`);
    return { weekRange: null, features: [] };
  }

  const features = [];
  let currentProduct = 'General';

  // The page is structured as:
  //   <h1> Product Name </h1>
  //   <h4> Feature Title </h4>
  //   STATUS TEXT (as a standalone paragraph or span)
  //   Description paragraphs...

  // Walk through all block-level elements in order
  const contentEl = $('article, .content, #main-content, body').first();

  contentEl.find('h1, h2, h3, h4, h5, p, ul, ol').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    // Product section headings (h1/h2/h3 that are NOT the page title and NOT status labels)
    if (['h1', 'h2', 'h3'].includes(tag)) {
      const isPageTitle = text.toLowerCase().includes('atlassian cloud changes');
      const isStatusLabel = Object.keys(STATUS_MAP).some(k => text.toUpperCase().includes(k));
      if (!isPageTitle && !isStatusLabel && text.length > 0) {
        currentProduct = text;
      }
      return;
    }

    // Feature titles are h4/h5
    if (['h4', 'h5'].includes(tag) && text.length > 5) {
      // Skip if it's a "Jump to..." navigation element
      if (text.toLowerCase().startsWith('jump to')) return;

      // Determine status from the NEXT sibling elements
      let status = 'released';
      let descriptionParts = [];

      // Look ahead for status + description
      let next = $(el).next();
      while (next.length > 0) {
        const nextTag = next.prop('tagName')?.toLowerCase();
        const nextText = next.text().trim().toUpperCase();

        // Stop at next feature heading or product heading
        if (['h1', 'h2', 'h3', 'h4', 'h5'].includes(nextTag)) break;

        // Check if this element IS a status label (short text matching known patterns)
        const rawText = next.text().trim();
        const detectedStatus = Object.keys(STATUS_MAP).find(k =>
          rawText.toUpperCase().replace(/\s+/g, ' ').includes(k)
        );
        if (detectedStatus) {
          status = STATUS_MAP[detectedStatus];
        } else if (rawText.length > 0) {
          descriptionParts.push(rawText);
        }
        next = next.next();
      }

      const description = descriptionParts.slice(0, 3).join(' ').substring(0, 500);

      features.push({
        title: text,
        product: currentProduct,
        status,
        description,
        weekUrl: url,
      });
    }
  });

  return { weekRange, features };
}

// ─── Feature repo management ─────────────────────────────────────────────────

function createFeature({ title, product, status, description, weekRange, weekUrl }) {
  const id = slugify(`${product}-${title}`);
  return {
    id,
    title,
    product,
    status,
    description,
    announced_date: weekRange.start,
    rollout_start_date: status === 'rolling_out' || status === 'rolling_out_new'
      ? weekRange.start
      : null,
    rollout_end_date: null,
    last_seen_week: weekRange.start,
    source_url: weekUrl,
    history: [
      { date: weekRange.start, status, week_url: weekUrl },
    ],
  };
}

function updateFeature(existing, { status, weekRange, weekUrl, description }) {
  let changed = false;

  // Update last_seen
  if (weekRange.start > existing.last_seen_week) {
    existing.last_seen_week = weekRange.start;
  }

  // Status transition
  if (existing.status !== status) {
    console.log(`    Status change: ${existing.title} → ${status}`);
    existing.status = status;
    existing.history.push({ date: weekRange.start, status, week_url: weekUrl });
    changed = true;

    // Set rollout_start_date if transitioning to rolling_out
    if ((status === 'rolling_out' || status === 'rolling_out_new') && !existing.rollout_start_date) {
      existing.rollout_start_date = weekRange.start;
    }
  }

  // Update description if we get a better (longer) one
  if (description && description.length > (existing.description || '').length) {
    existing.description = description;
    changed = true;
  }

  return changed;
}

/**
 * After processing all recent weeks, mark features as complete if they
 * haven't appeared in the last COMPLETION_WEEKS weeks.
 */
function markCompletedFeatures(allFeatures, recentWeeks) {
  if (recentWeeks.length === 0) return;

  // Sort weeks descending and take the last N
  const sortedWeeks = [...recentWeeks].sort().reverse();
  const cutoffWeek = sortedWeeks[Math.min(COMPLETION_WEEKS - 1, sortedWeeks.length - 1)];

  let completedCount = 0;
  for (const feature of allFeatures) {
    if (feature.status === 'rolling_out' || feature.status === 'rolling_out_new') {
      if (feature.last_seen_week < cutoffWeek) {
        console.log(`  ✓ Marking complete: ${feature.title}`);
        feature.status = 'rollout_complete';
        feature.rollout_end_date = feature.last_seen_week;
        feature.history.push({
          date: cutoffWeek,
          status: 'rollout_complete',
          note: `Not seen in ${COMPLETION_WEEKS} consecutive weeks`,
        });
        saveFeature(feature);
        completedCount++;
      }
    }
  }
  if (completedCount > 0) {
    console.log(`\nMarked ${completedCount} features as rollout_complete.`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const isBackfill = process.argv.includes('--backfill');
  console.log(`\n🔍 Atlassian Cloud Feature Scraper`);
  console.log(`Mode: ${isBackfill ? 'BACKFILL (all weeks)' : 'INCREMENTAL (new weeks only)'}\n`);

  mkdirSync(DATA_DIR, { recursive: true });

  const state = loadState();
  const processedWeeks = new Set(state.processed_weeks || []);

  // Get list of all available blog weeks
  console.log('Fetching blog index...');
  const weeks = await getBlogIndex();
  console.log(`Found ${weeks.length} weekly posts.\n`);

  // Filter to only new weeks (unless backfilling)
  const weeksToProcess = isBackfill
    ? weeks
    : weeks.filter(w => !processedWeeks.has(w.url));

  if (weeksToProcess.length === 0) {
    console.log('No new weeks to process. Everything is up to date! ✅');
    return;
  }

  console.log(`Processing ${weeksToProcess.length} week(s)...\n`);

  let newFeatures = 0;
  let updatedFeatures = 0;
  const processedWeekDates = [];

  for (const week of weeksToProcess) {
    console.log(`\n📅 Processing: ${week.url}`);

    try {
      const { weekRange, features } = await parseWeekPage(week.url);

      if (!weekRange) {
        console.warn('  Skipping — could not parse date range');
        continue;
      }

      console.log(`  Week: ${weekRange.start} → ${weekRange.end}`);
      console.log(`  Found ${features.length} features`);

      processedWeekDates.push(weekRange.start);

      for (const raw of features) {
        const id = slugify(`${raw.product}-${raw.title}`);
        const existing = loadFeature(id);

        if (!existing) {
          const feature = createFeature({ ...raw, weekRange, weekUrl: week.url });
          saveFeature(feature);
          newFeatures++;
          console.log(`  + New: [${raw.status}] ${raw.product} → ${raw.title}`);
        } else {
          const changed = updateFeature(existing, {
            status: raw.status,
            weekRange,
            weekUrl: week.url,
            description: raw.description,
          });
          if (changed) {
            saveFeature(existing);
            updatedFeatures++;
          }
        }
      }

      processedWeeks.add(week.url);

      // Small delay to be respectful to Atlassian's servers
      await new Promise(r => setTimeout(r, 800));

    } catch (err) {
      console.error(`  ❌ Error processing ${week.url}: ${err.message}`);
    }
  }

  // Save updated state
  state.processed_weeks = [...processedWeeks];
  state.last_run = new Date().toISOString();
  saveState(state);

  // Check for features that should be marked as complete
  console.log('\n🔎 Checking for completed rollouts...');
  const allFeatures = loadAllFeatures();
  const allProcessedWeeks = [...processedWeeks].map(url => {
    const m = url.match(/\/(\d{4})\/(\d{2})\//);
    return m ? null : null; // weekRange.start is stored in features
  }).filter(Boolean);

  markCompletedFeatures(allFeatures, processedWeekDates);

  // Summary
  console.log('\n─────────────────────────────────');
  console.log(`✅ Done!`);
  console.log(`   New features:     ${newFeatures}`);
  console.log(`   Updated features: ${updatedFeatures}`);
  console.log(`   Total in repo:    ${loadAllFeatures().length}`);
  console.log('─────────────────────────────────\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
