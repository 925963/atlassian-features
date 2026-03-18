/**
 * generate-pages.mjs
 * 
 * Reads all JSON feature files from data/features/ and generates
 * Astro/Starlight .mdx pages in src/content/docs/
 *
 * Run after scraping: node scripts/generate-pages.mjs
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data', 'features');
const DOCS_DIR = join(ROOT, 'src', 'content', 'docs');

const STATUS_LABELS = {
  coming_soon: '🔜 Coming Soon',
  rolling_out_new: '🆕 Rolling Out — New This Week',
  rolling_out: '⏳ Rolling Out',
  rollout_complete: '✅ Rollout Complete',
  released: '✅ Released',
};

const STATUS_BADGE = {
  coming_soon: 'caution',
  rolling_out_new: 'tip',
  rolling_out: 'note',
  rollout_complete: 'success',
  released: 'success',
};

function loadAllFeatures() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')));
}

function slugifyProduct(product) {
  return product
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .trim();
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function generateFeaturePage(feature) {
  const badge = STATUS_BADGE[feature.status] || 'note';
  const statusLabel = STATUS_LABELS[feature.status] || feature.status;

  const historyRows = (feature.history || [])
    .map(h => `| ${formatDate(h.date)} | ${STATUS_LABELS[h.status] || h.status} | [↗](${h.week_url || ''}) |`)
    .join('\n');

  return `---
title: "${feature.title.replace(/"/g, '\\"')}"
description: "${(feature.description || '').replace(/"/g, '\\"').substring(0, 160)}"
sidebar:
  badge:
    text: "${statusLabel}"
    variant: ${badge}
---

import { Badge } from '@astrojs/starlight/components';

<Badge text="${statusLabel}" variant="${badge}" size="large" />

**Product:** ${feature.product}

| | |
|---|---|
| **Announced** | ${formatDate(feature.announced_date)} |
| **Rollout started** | ${formatDate(feature.rollout_start_date)} |
| **Rollout ended** | ${formatDate(feature.rollout_end_date)} |
| **Source** | [Atlassian blog ↗](${feature.source_url}) |

## Description

${feature.description || '_No description available._'}

## Status history

| Date | Status | Week |
|------|--------|------|
${historyRows}
`;
}

function generateIndexPage(features) {
  const now = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const byStatus = {
    rolling_out_new: features.filter(f => f.status === 'rolling_out_new'),
    coming_soon: features.filter(f => f.status === 'coming_soon'),
    rolling_out: features.filter(f => f.status === 'rolling_out'),
    rollout_complete: features.filter(f => f.status === 'rollout_complete'),
    released: features.filter(f => f.status === 'released'),
  };

  const tableRows = features
    .sort((a, b) => (b.announced_date || '').localeCompare(a.announced_date || ''))
    .map(f => {
      const statusLabel = STATUS_LABELS[f.status] || f.status;
      const slug = `features/${slugifyProduct(f.product)}/${f.id}`;
      return `| [${f.title}](/${slug}/) | ${f.product} | ${statusLabel} | ${formatDate(f.announced_date)} | ${formatDate(f.rollout_start_date)} | ${formatDate(f.rollout_end_date)} |`;
    })
    .join('\n');

  return `---
title: All Features
description: Complete overview of all tracked Atlassian Cloud features — deduplicated, with announcement and rollout dates.
---

Last updated: **${now}**

**${features.length} features tracked** across ${Object.values(byStatus).filter(v => v.length > 0).length} statuses.

| Status | Count |
|--------|-------|
| 🆕 New This Week | ${byStatus.rolling_out_new.length} |
| 🔜 Coming Soon | ${byStatus.coming_soon.length} |
| ⏳ Rolling Out | ${byStatus.rolling_out.length} |
| ✅ Complete / Released | ${byStatus.rollout_complete.length + byStatus.released.length} |

## All features

| Feature | Product | Status | Announced | Rollout start | Rollout end |
|---------|---------|--------|-----------|---------------|-------------|
${tableRows}
`;
}

function generateStatusPage(features, status, title, description) {
  const filtered = features.filter(f => f.status === status)
    .sort((a, b) => (b.announced_date || '').localeCompare(a.announced_date || ''));

  const rows = filtered.map(f => {
    const slug = `features/${slugifyProduct(f.product)}/${f.id}`;
    return `| [${f.title}](/${slug}/) | ${f.product} | ${formatDate(f.announced_date)} | ${formatDate(f.rollout_start_date)} |`;
  }).join('\n');

  return `---
title: ${title}
description: ${description}
---

**${filtered.length} feature(s)**

| Feature | Product | Announced | Rollout start |
|---------|---------|-----------|---------------|
${rows || '| _None currently_ | | | |'}
`;
}

function generateNewThisWeekPage(features) {
  // "New this week" = features whose rolling_out_new status was set in the
  // most recently scraped week. Find that week first.
  const allNewFeatures = features.filter(f => f.status === 'rolling_out_new');

  // Find the most recent week date across all rolling_out_new features
  const latestWeek = allNewFeatures
    .map(f => f.last_seen_week)
    .filter(Boolean)
    .sort()
    .reverse()[0];

  // Only show features that were last seen in that most recent week
  const newFeatures = latestWeek
    ? allNewFeatures.filter(f => f.last_seen_week === latestWeek)
    : allNewFeatures;

  newFeatures.sort((a, b) => (a.product || '').localeCompare(b.product || ''));

  // Group by product
  const byProduct = {};
  for (const f of newFeatures) {
    if (!byProduct[f.product]) byProduct[f.product] = [];
    byProduct[f.product].push(f);
  }

  const sections = Object.entries(byProduct).map(([product, feats]) => {
    const items = feats.map(f => {
      const slug = `features/${slugifyProduct(f.product)}/${f.id}`;
      return `- [**${f.title}**](/${slug}/)${f.description ? ` — ${f.description.substring(0, 120)}` : ''}`;
    }).join('\n');
    return `### ${product}\n\n${items}`;
  }).join('\n\n');

  return `---
title: New This Week
description: Features marked as "Rolling Out — New This Week" in the latest Atlassian Cloud release notes.
---

${latestWeek ? `**Week of ${formatDate(latestWeek)}** — ${newFeatures.length} new feature(s)` : '_No new features this week._'}

${sections || '_Nothing new this week._'}
`;
}

async function main() {
  console.log('\n📄 Generating Astro pages from feature data...\n');

  const features = loadAllFeatures();
  console.log(`Found ${features.length} features in data/features/`);

  if (features.length === 0) {
    console.log('No features found. Run `npm run scrape` first.');
    return;
  }

  // Clean and recreate docs directories
  const featuresDocsDir = join(DOCS_DIR, 'features');
  const productsDocsDir = join(DOCS_DIR, 'products');
  if (existsSync(featuresDocsDir)) rmSync(featuresDocsDir, { recursive: true });
  mkdirSync(featuresDocsDir, { recursive: true });

  // Generate per-feature pages grouped by product
  let pageCount = 0;
  for (const feature of features) {
    const productSlug = slugifyProduct(feature.product);
    const dir = join(featuresDocsDir, productSlug);
    mkdirSync(dir, { recursive: true });

    const content = generateFeaturePage(feature);
    writeFileSync(join(dir, `${feature.id}.mdx`), content);
    pageCount++;
  }

  // Generate overview pages
  writeFileSync(join(DOCS_DIR, 'features.mdx'), generateIndexPage(features));

  writeFileSync(join(DOCS_DIR, 'new-this-week.mdx'), generateNewThisWeekPage(features));

  writeFileSync(
    join(DOCS_DIR, 'coming-soon.mdx'),
    generateStatusPage(features, 'coming_soon', 'Coming Soon', 'Features announced but not yet rolling out.')
  );

  writeFileSync(
    join(DOCS_DIR, 'rolling-out.mdx'),
    generateStatusPage(features, 'rolling_out', 'Rolling Out', 'Features currently being rolled out to Atlassian Cloud sites.')
  );

  writeFileSync(
    join(DOCS_DIR, 'completed.mdx'),
    generateStatusPage(features, 'rollout_complete', 'Completed', 'Features whose rollout has completed.')
  );

  // About page
  writeFileSync(join(DOCS_DIR, 'about.mdx'), `---
title: How this works
description: About this Atlassian Cloud feature tracker.
---

This site automatically tracks features published in the [Atlassian Cloud weekly release notes](https://confluence.atlassian.com/cloud/blog).

## What gets tracked

Every week, Atlassian publishes a page listing changes to their cloud products. Features appear in three stages:

| Label | Meaning |
|-------|---------|
| **COMING SOON** | Announced, not yet rolling out |
| **ROLLING OUT** | Gradually being deployed to sites |
| **ROLLING OUT — NEW THIS WEEK** | Just started rolling out this week |
| _(no label)_ | Fully released to all sites |

## How deduplication works

Features often appear across many consecutive weekly pages while rolling out. This tracker:

1. **Detects** each feature by a stable ID derived from its title and product
2. **Records** the first week it appeared as the *announced date*
3. **Tracks** status changes (e.g. Coming Soon → Rolling Out)
4. **Marks** a feature as *Rollout Complete* once it disappears from ${4} consecutive weeks

## Update schedule

The scraper runs every Monday via GitHub Actions, after Atlassian publishes their weekly notes.

## Source

Data sourced from [confluence.atlassian.com/cloud/blog](https://confluence.atlassian.com/cloud/blog).  
Built by [Brainboss](https://brainboss.nl) — Atlassian partner consultancy.
`);

  console.log(`\n✅ Generated ${pageCount} feature pages + overview pages.`);
  console.log(`   Location: src/content/docs/\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
