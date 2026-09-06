// scripts/scrape-audio-sources.mjs
import fs from 'node:fs/promises';

const urls = [
  'https://opengameart.org/content/wind-whoosh-loop',
  'https://opengameart.org/content/wind',
  'https://opengameart.org/content/forest-ambience',
  'https://opengameart.org/content/bird-chirping-sounds',
  'https://opengameart.org/content/ambient-bird-sounds',
  'https://opengameart.org/content/crow',
  'https://opengameart.org/content/crows-singing',
  'https://opengameart.org/content/birdcricketfrog-and-mosquito-sounds',
  'https://opengameart.org/content/cricket-sounds',
  'https://opengameart.org/content/swamp-environment-audio',
  'https://opengameart.org/content/40-cc0-water-splash-slime-sfx',
  'https://opengameart.org/content/6-short-water-splashes',
  'https://opengameart.org/content/different-steps-on-wood-stone-leaves-gravel-and-mud',
  'https://opengameart.org/content/fantozzis-footsteps-grasssand-stone',
  'https://opengameart.org/content/25-cc0-mud-sfx',
  'https://opengameart.org/content/rain-loopable',
  'https://opengameart.org/content/swishes-sound-pack',
  'https://opengameart.org/content/interaction-sound',
];

async function extractPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) return { url, error: `HTTP ${res.status}` };
  const html = await res.text();

  const titleMatch = html.match(/<h2[^>]*property="dc:title"[^>]*>([\s\S]*?)<\/h2>/i)
    || html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Unknown';

  const isCc0 = /\bCC0\b/i.test(html) || /Creative Commons 0/i.test(html) || /publicdomain\/zero/i.test(html);

  // Match file download links
  const fileRegex = /<span class="file">[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:([0-9.]+\s*[KMG]?b))?/gi;
  const files = [];
  let m;
  while ((m = fileRegex.exec(html)) !== null) {
    const rawHref = m[1];
    const fileName = m[2].replace(/<[^>]+>/g, '').trim();
    const size = m[3] ? m[3].trim() : 'Unknown';
    const absUrl = new URL(rawHref, url).href;
    const ext = (fileName.split('.').pop() || '').toUpperCase();
    files.push({ name: fileName, url: absUrl, format: ext, size });
  }

  // Fallback href scan if standard Drupal file span not matched
  if (files.length === 0) {
    const directRegex = /href=["'](https?:\/\/opengameart\.org\/sites\/default\/files\/[^"']+|\/sites\/default\/files\/[^"']+)["']/gi;
    const seen = new Set();
    while ((m = directRegex.exec(html)) !== null) {
      const rawHref = m[1];
      if (rawHref.includes('/audio_preview/')) continue;
      const absUrl = new URL(rawHref, url).href;
      if (seen.has(absUrl)) continue;
      seen.add(absUrl);
      const name = decodeURIComponent(absUrl.split('/').pop());
      const ext = (name.split('.').pop() || '').toUpperCase();
      files.push({ name, url: absUrl, format: ext, size: 'Unknown' });
    }
  }

  return {
    pageUrl: url,
    title,
    licenseCc0: isCc0,
    files,
  };
}

(async () => {
  const results = [];
  for (const u of urls) {
    try {
      const data = await extractPage(u);
      results.push(data);
      console.log(`✓ Scraped: ${data.title} (${data.files.length} files) -> ${data.files.map(f => f.name).join(', ')}`);
    } catch (err) {
      console.error(`✗ Failed: ${u} - ${err.message}`);
    }
  }
  await fs.writeFile('scripts/scraped-sources.json', JSON.stringify(results, null, 2));
  console.log('\nWrote scripts/scraped-sources.json');
})();
