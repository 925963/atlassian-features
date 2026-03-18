/**
 * test-parse.mjs — validates scraper parsing logic against a fixture
 * Run: node scripts/test-parse.mjs
 */

import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal fixture based on real Atlassian blog page structure
const FIXTURE_HTML = `
<html><body>
<h1>Atlassian Cloud changes Mar 9 to Mar 16, 2026</h1>
<h1>Atlassian Administration</h1>
<h4>Access policies: Block mobile browser access</h4>
<p>ROLLING OUT NEW THIS WEEK</p>
<p>Atlassian Guard now allows organization admins to block access from mobile browsers. This new condition-based policy helps you enhance security.</p>
<h4>We're replacing Beacon with Guard Detect</h4>
<p>ROLLING OUT</p>
<p>Beacon (beta) will soon be part of Atlassian Guard Premium. We're replacing 'Beacon' with 'Guard Detect' in CSV exports.</p>
<h4>Apply a default classification level for all Confluence products</h4>
<p>COMING SOON</p>
<p>Apply a default classification level enforced across all Confluence products in your organization.</p>
<h1>Jira platform</h1>
<h4>Automation: Improved rule builder header</h4>
<p>ROLLING OUT NEW THIS WEEK</p>
<p>We've uplifted the header in the automation rule builder to improve readability and navigation across Jira.</p>
<h4>Development feature for software projects is now generally available</h4>
<p>Development in Jira unifies data from your connected code, CI/CD, and security apps into a single view.</p>
</body></html>
`;

const STATUS_MAP = {
  'ROLLING OUT NEW THIS WEEK': 'rolling_out_new',
  'NEW THIS WEEK': 'rolling_out_new',
  'ROLLING OUT': 'rolling_out',
  'COMING SOON': 'coming_soon',
};

function parseWeekRange(title) {
  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const m = title.match(/([A-Za-z]+)\s+(\d+)\s+to\s+([A-Za-z]+)\s+(\d+),\s+(\d{4})/i);
  if (!m) return null;
  const [, m1, d1, m2, d2, year] = m;
  const mo1 = months[m1.toLowerCase()];
  const mo2 = months[m2.toLowerCase()];
  const y1 = mo1 === '01' && mo2 === '12' ? String(Number(year) - 1) : year;
  return {
    start: `${y1}-${mo1}-${d1.padStart(2, '0')}`,
    end: `${year}-${mo2}-${d2.padStart(2, '0')}`,
  };
}

function parseWeekPageFromHtml(html, url) {
  const $ = cheerio.load(html);
  const titleText = $('h1').first().text().trim();
  const weekRange = parseWeekRange(titleText);

  const features = [];
  let currentProduct = 'General';
  const contentEl = $('body');

  contentEl.find('h1, h4, p').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    if (tag === 'h1') {
      const isPageTitle = text.toLowerCase().includes('atlassian cloud changes');
      const isStatus = Object.keys(STATUS_MAP).some(k => text.toUpperCase().includes(k));
      if (!isPageTitle && !isStatus && text.length > 0) {
        currentProduct = text;
      }
      return;
    }

    if (tag === 'h4' && text.length > 5) {
      let status = 'released';
      let descriptionParts = [];
      let next = $(el).next();
      while (next.length > 0) {
        const nextTag = next.prop('tagName')?.toLowerCase();
        if (['h1', 'h2', 'h3', 'h4', 'h5'].includes(nextTag)) break;
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
      features.push({
        title: text,
        product: currentProduct,
        status,
        description: descriptionParts.slice(0, 2).join(' ').substring(0, 300),
      });
    }
  });

  return { weekRange, features };
}

// Run test
console.log('🧪 Testing scraper parsing logic...\n');
const { weekRange, features } = parseWeekPageFromHtml(FIXTURE_HTML, 'https://test.example/');

console.log('Week range:', weekRange);
console.log(`\nParsed ${features.length} features:\n`);

let passed = 0;
let failed = 0;

const expected = [
  { title: 'Access policies: Block mobile browser access', product: 'Atlassian Administration', status: 'rolling_out_new' },
  { title: "We're replacing Beacon with Guard Detect",     product: 'Atlassian Administration', status: 'rolling_out' },
  { title: 'Apply a default classification level for all Confluence products', product: 'Atlassian Administration', status: 'coming_soon' },
  { title: 'Automation: Improved rule builder header',     product: 'Jira platform',            status: 'rolling_out_new' },
  { title: 'Development feature for software projects is now generally available', product: 'Jira platform', status: 'released' },
];

for (const exp of expected) {
  const found = features.find(f => f.title === exp.title);
  if (!found) {
    console.log(`  ❌ MISSING: "${exp.title}"`);
    failed++;
    continue;
  }
  const statusOk = found.status === exp.status;
  const productOk = found.product === exp.product;
  if (statusOk && productOk) {
    console.log(`  ✅ OK: [${found.status}] ${found.product} → ${found.title}`);
    passed++;
  } else {
    console.log(`  ❌ MISMATCH: "${found.title}"`);
    if (!statusOk) console.log(`     status: got "${found.status}", expected "${exp.status}"`);
    if (!productOk) console.log(`     product: got "${found.product}", expected "${exp.product}"`);
    failed++;
  }
}

// Also validate week range
const rangeOk = weekRange?.start === '2026-03-09' && weekRange?.end === '2026-03-16';
if (rangeOk) {
  console.log(`  ✅ OK: week range ${weekRange.start} → ${weekRange.end}`);
  passed++;
} else {
  console.log(`  ❌ FAIL: week range — got ${JSON.stringify(weekRange)}`);
  failed++;
}

console.log(`\n─────────────────────────────`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) console.log('All tests passed! ✅');
else process.exit(1);
