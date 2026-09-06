// scripts/build-sound-bank.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TARGET_BASE = path.resolve('public/Assets/Audio');
const STAGING = path.resolve('.cache/audio-sources');

const BANK_MANIFEST = [
  // ==========================================
  // AMBIENT (96 kbps, stereo / 2ch, 10-30s)
  // ==========================================
  {
    target: 'ambient/highfield-wind-01.mp3',
    source: `${STAGING}/wind_woosh_loop.ogg`,
    start: 0,
    duration: 5.9,
    bitrate: '96k',
    channels: 2,
    fades: { in: 0.1, out: 0.1 },
    desc: 'Open grass / Highfield gentle wind bed'
  },
  {
    target: 'ambient/highfield-wind-02.mp3',
    source: `${STAGING}/unpacked/wind-pack/wind/Wind2.ogg`,
    start: 0.5,
    duration: 5.8,
    bitrate: '96k',
    channels: 2,
    fades: { in: 0.15, out: 0.15 },
    desc: 'Highfield gustier wind variation'
  },
  {
    target: 'ambient/forest-01.mp3',
    source: `${STAGING}/Forest_Ambience.mp3`,
    start: 5.0,
    duration: 25.0,
    bitrate: '96k',
    channels: 2,
    fades: { in: 0.5, out: 0.5 },
    desc: 'Woodland forest ambience bed with rustling & distant life'
  },
  {
    target: 'ambient/wetland-01.mp3',
    source: `${STAGING}/swamp.ogg`,
    start: 10.0,
    duration: 25.0,
    bitrate: '96k',
    channels: 2,
    fades: { in: 0.5, out: 0.5 },
    desc: 'Wetland / swamp ambient bed with bubbling and marsh insects'
  },
  {
    target: 'ambient/lake-01.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/loop_water_02.ogg`,
    start: 0,
    duration: 7.0,
    bitrate: '96k',
    channels: 2,
    fades: { in: 0.2, out: 0.2 },
    desc: 'Lake waterflow / shoreline steady loop'
  },
  {
    target: 'ambient/rain-light-01.mp3',
    source: `${STAGING}/unpacked/rain-pack/1.mp3`,
    start: 2.0,
    duration: 20.0,
    bitrate: '96k',
    channels: 2,
    fades: { in: 0.3, out: 0.3 },
    desc: 'Light gentle rain loop'
  },
  {
    target: 'ambient/rain-medium-01.mp3',
    source: `${STAGING}/unpacked/rain-pack/2.mp3`,
    start: 2.0,
    duration: 20.0,
    bitrate: '96k',
    channels: 2,
    fades: { in: 0.3, out: 0.3 },
    desc: 'Medium steady rain loop'
  },
  {
    target: 'ambient/rain-heavy-01.mp3',
    source: `${STAGING}/unpacked/rain-pack/4.mp3`,
    start: 3.0,
    duration: 22.0,
    bitrate: '96k',
    channels: 2,
    fades: { in: 0.3, out: 0.3 },
    desc: 'Heavy downpour rain loop'
  },

  // ==========================================
  // WILDLIFE (64 kbps, mono / 1ch, short one-shots)
  // ==========================================
  {
    target: 'wildlife/bird-chirp-01.mp3',
    source: `${STAGING}/unpacked/birds-crickets-pack/birdsCrickets/bird.wav`,
    start: 0.05,
    duration: 0.65,
    bitrate: '64k',
    channels: 1,
    desc: 'Daylight small songbird chirp'
  },
  {
    target: 'wildlife/bird-chirp-02.mp3',
    source: `${STAGING}/unpacked/birds-crickets-pack/birdsCrickets/bird2.wav`,
    start: 0.05,
    duration: 1.05,
    bitrate: '64k',
    channels: 1,
    desc: 'Daylight bird double trill'
  },
  {
    target: 'wildlife/bird-chirp-03.mp3',
    source: `${STAGING}/birdchirping071414.mp3`,
    start: 0.1,
    duration: 1.2,
    bitrate: '64k',
    channels: 1,
    desc: 'Natural wild bird call'
  },
  {
    target: 'wildlife/bird-chirp-04.mp3',
    source: `${STAGING}/birds-isaiah658.ogg`,
    start: 4.8,
    duration: 1.4,
    bitrate: '64k',
    channels: 1,
    desc: 'Sparrow melody chirp'
  },
  {
    target: 'wildlife/crow-01.mp3',
    source: `${STAGING}/crow.ogg`,
    start: 0.02,
    duration: 0.55,
    bitrate: '64k',
    channels: 1,
    desc: 'Single sharp crow caw'
  },
  {
    target: 'wildlife/crows-01.mp3',
    source: `${STAGING}/Crows.ogg`,
    start: 1.2,
    duration: 4.5,
    bitrate: '64k',
    channels: 1,
    desc: 'Distant crows group call'
  },
  {
    target: 'wildlife/cricket-01.mp3',
    source: `${STAGING}/unpacked/birds-crickets-pack/birdsCrickets/cricket2.wav`,
    start: 0.05,
    duration: 3.2,
    bitrate: '64k',
    channels: 1,
    desc: 'Close evening cricket cadence'
  },
  {
    target: 'wildlife/cricket-02.mp3',
    source: `${STAGING}/cricketsounds090613.mp3`,
    start: 2.0,
    duration: 6.0,
    bitrate: '64k',
    channels: 1,
    fades: { in: 0.2, out: 0.2 },
    desc: 'Night grass crickets chorus loop'
  },
  {
    target: 'wildlife/frog-01.mp3',
    source: `${STAGING}/unpacked/birds-crickets-pack/birdsCrickets/frog.wav`,
    start: 0.02,
    duration: 0.26,
    bitrate: '64k',
    channels: 1,
    desc: 'Wetland frog croak'
  },
  {
    target: 'wildlife/mosquito-01.mp3',
    source: `${STAGING}/unpacked/birds-crickets-pack/birdsCrickets/distressedMosquito.wav`,
    start: 0.02,
    duration: 0.32,
    bitrate: '64k',
    channels: 1,
    desc: 'Subtle night insect buzz'
  },

  // ==========================================
  // FOOTSTEPS: GRASS (8 sounds, 64 kbps, mono)
  // ==========================================
  {
    target: 'footsteps/grass-01.mp3',
    source: `${STAGING}/unpacked/fantozzi-footsteps-pack/Fantozzi-footsteps/ogg/Fantozzi-SandL1.ogg`,
    start: 0.02,
    duration: 0.38,
    bitrate: '64k',
    channels: 1,
    desc: 'Grass step L1'
  },
  {
    target: 'footsteps/grass-02.mp3',
    source: `${STAGING}/unpacked/fantozzi-footsteps-pack/Fantozzi-footsteps/ogg/Fantozzi-SandR1.ogg`,
    start: 0.02,
    duration: 0.36,
    bitrate: '64k',
    channels: 1,
    desc: 'Grass step R1'
  },
  {
    target: 'footsteps/grass-03.mp3',
    source: `${STAGING}/unpacked/fantozzi-footsteps-pack/Fantozzi-footsteps/ogg/Fantozzi-SandL2.ogg`,
    start: 0.02,
    duration: 0.28,
    bitrate: '64k',
    channels: 1,
    desc: 'Grass step L2'
  },
  {
    target: 'footsteps/grass-04.mp3',
    source: `${STAGING}/unpacked/fantozzi-footsteps-pack/Fantozzi-footsteps/ogg/Fantozzi-SandR2.ogg`,
    start: 0.02,
    duration: 0.30,
    bitrate: '64k',
    channels: 1,
    desc: 'Grass step R2'
  },
  {
    target: 'footsteps/grass-05.mp3',
    source: `${STAGING}/unpacked/fantozzi-footsteps-pack/Fantozzi-footsteps/ogg/Fantozzi-SandL3.ogg`,
    start: 0.02,
    duration: 0.26,
    bitrate: '64k',
    channels: 1,
    desc: 'Grass step L3'
  },
  {
    target: 'footsteps/grass-06.mp3',
    source: `${STAGING}/unpacked/fantozzi-footsteps-pack/Fantozzi-footsteps/ogg/Fantozzi-SandR3.ogg`,
    start: 0.02,
    duration: 0.28,
    bitrate: '64k',
    channels: 1,
    desc: 'Grass step R3'
  },
  {
    target: 'footsteps/grass-07.mp3',
    source: `${TARGET_BASE}/grass-footstep1.mp3`,
    start: 0.02,
    duration: 0.35,
    bitrate: '64k',
    channels: 1,
    desc: 'Grass step variation 7 (soft)'
  },
  {
    target: 'footsteps/grass-08.mp3',
    source: `${TARGET_BASE}/grass-footstep2.mp3`,
    start: 0.02,
    duration: 0.35,
    bitrate: '64k',
    channels: 1,
    desc: 'Grass step variation 8 (crisp)'
  },

  // ==========================================
  // FOOTSTEPS: LEAVES (4 sounds, 64 kbps, mono)
  // ==========================================
  {
    target: 'footsteps/leaves-01.mp3',
    source: `${STAGING}/unpacked/different-steps-pack/leaves01.ogg`,
    start: 0.02,
    duration: 0.34,
    bitrate: '64k',
    channels: 1,
    desc: 'Dry woodland leaves crunch step 1'
  },
  {
    target: 'footsteps/leaves-02.mp3',
    source: `${STAGING}/unpacked/different-steps-pack/leaves02.ogg`,
    start: 0.02,
    duration: 0.38,
    bitrate: '64k',
    channels: 1,
    desc: 'Dry woodland leaves crunch step 2'
  },
  {
    target: 'footsteps/leaves-03.mp3',
    source: `${STAGING}/unpacked/different-steps-pack/leaves01.ogg`,
    start: 0.12,
    duration: 0.25,
    bitrate: '64k',
    channels: 1,
    desc: 'Dry leaves rustle step 3'
  },
  {
    target: 'footsteps/leaves-04.mp3',
    source: `${STAGING}/unpacked/different-steps-pack/leaves02.ogg`,
    start: 0.15,
    duration: 0.28,
    bitrate: '64k',
    channels: 1,
    desc: 'Dry leaves rustle step 4'
  },

  // ==========================================
  // FOOTSTEPS: MUD (8 sounds, 64 kbps, mono)
  // ==========================================
  {
    target: 'footsteps/mud-01.mp3',
    source: `${STAGING}/unpacked/mud-sfx-pack/mud_06.ogg`,
    start: 0.01,
    duration: 0.26,
    bitrate: '64k',
    channels: 1,
    desc: 'Mud squelch step 1'
  },
  {
    target: 'footsteps/mud-02.mp3',
    source: `${STAGING}/unpacked/mud-sfx-pack/mud_08.ogg`,
    start: 0.01,
    duration: 0.28,
    bitrate: '64k',
    channels: 1,
    desc: 'Mud squelch step 2'
  },
  {
    target: 'footsteps/mud-03.mp3',
    source: `${STAGING}/unpacked/mud-sfx-pack/mud_10.ogg`,
    start: 0.01,
    duration: 0.25,
    bitrate: '64k',
    channels: 1,
    desc: 'Mud squelch step 3'
  },
  {
    target: 'footsteps/mud-04.mp3',
    source: `${STAGING}/unpacked/mud-sfx-pack/mud_11.ogg`,
    start: 0.01,
    duration: 0.22,
    bitrate: '64k',
    channels: 1,
    desc: 'Mud squelch step 4'
  },
  {
    target: 'footsteps/mud-05.mp3',
    source: `${STAGING}/unpacked/mud-sfx-pack/mud_12.ogg`,
    start: 0.01,
    duration: 0.35,
    bitrate: '64k',
    channels: 1,
    desc: 'Mud squelch step 5'
  },
  {
    target: 'footsteps/mud-06.mp3',
    source: `${STAGING}/unpacked/mud-sfx-pack/mud_13.ogg`,
    start: 0.01,
    duration: 0.32,
    bitrate: '64k',
    channels: 1,
    desc: 'Mud squelch step 6'
  },
  {
    target: 'footsteps/mud-07.mp3',
    source: `${STAGING}/unpacked/mud-sfx-pack/mud_15.ogg`,
    start: 0.01,
    duration: 0.30,
    bitrate: '64k',
    channels: 1,
    desc: 'Mud squelch step 7'
  },
  {
    target: 'footsteps/mud-08.mp3',
    source: `${STAGING}/unpacked/mud-sfx-pack/mud_24.ogg`,
    start: 0.01,
    duration: 0.18,
    bitrate: '64k',
    channels: 1,
    desc: 'Mud squelch step 8'
  },

  // ==========================================
  // FOOTSTEPS: WATER (8 sounds, 64 kbps, mono)
  // ==========================================
  {
    target: 'footsteps/water-01.mp3',
    source: `${STAGING}/unpacked/water-splashes-pack/ezwa-water_splash/water_splash-02.flac`,
    start: 0,
    duration: 0.38,
    bitrate: '64k',
    channels: 1,
    desc: 'Shallow water footstep splash 1'
  },
  {
    target: 'footsteps/water-02.mp3',
    source: `${STAGING}/unpacked/water-splashes-pack/ezwa-water_splash/water_splash-03.flac`,
    start: 0,
    duration: 0.55,
    bitrate: '64k',
    channels: 1,
    desc: 'Shallow water footstep splash 2'
  },
  {
    target: 'footsteps/water-03.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/splash_03.ogg`,
    start: 0,
    duration: 0.35,
    bitrate: '64k',
    channels: 1,
    desc: 'Light water splash step 3'
  },
  {
    target: 'footsteps/water-04.mp3',
    source: `${STAGING}/unpacked/water-splashes-pack/ezwa-water_splash/water_splash-06.flac`,
    start: 0,
    duration: 0.45,
    bitrate: '64k',
    channels: 1,
    desc: 'Shallow water wade step 4'
  },
  {
    target: 'footsteps/water-05.mp3',
    source: `${STAGING}/unpacked/water-splashes-pack/ezwa-water_splash/water_splash-01.flac`,
    start: 0,
    duration: 0.48,
    bitrate: '64k',
    channels: 1,
    desc: 'Water wading impact step 5'
  },
  {
    target: 'footsteps/water-06.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/splash_06.ogg`,
    start: 0,
    duration: 0.35,
    bitrate: '64k',
    channels: 1,
    desc: 'Water dip splash step 6'
  },
  {
    target: 'footsteps/water-07.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/splash_09.ogg`,
    start: 0,
    duration: 0.28,
    bitrate: '64k',
    channels: 1,
    desc: 'Water plop step 7'
  },
  {
    target: 'footsteps/water-08.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/splash_15.ogg`,
    start: 0,
    duration: 0.35,
    bitrate: '64k',
    channels: 1,
    desc: 'Water disturbance step 8'
  },

  // ==========================================
  // FOOTSTEPS: GRAVEL (4 sounds, 64 kbps, mono)
  // ==========================================
  {
    target: 'footsteps/gravel-01.mp3',
    source: `${STAGING}/unpacked/different-steps-pack/gravel.ogg`,
    start: 0.01,
    duration: 0.32,
    bitrate: '64k',
    channels: 1,
    desc: 'Loose gravel ground step 1'
  },
  {
    target: 'footsteps/gravel-02.mp3',
    source: `${STAGING}/unpacked/different-steps-pack/gravel.ogg`,
    start: 0.32,
    duration: 0.35,
    bitrate: '64k',
    channels: 1,
    desc: 'Loose gravel ground step 2'
  },
  {
    target: 'footsteps/gravel-03.mp3',
    source: `${STAGING}/unpacked/fantozzi-footsteps-pack/Fantozzi-footsteps/ogg/Fantozzi-StoneL1.ogg`,
    start: 0.02,
    duration: 0.32,
    bitrate: '64k',
    channels: 1,
    desc: 'Firm gravel / stone step 3'
  },
  {
    target: 'footsteps/gravel-04.mp3',
    source: `${STAGING}/unpacked/fantozzi-footsteps-pack/Fantozzi-footsteps/ogg/Fantozzi-StoneR1.ogg`,
    start: 0.02,
    duration: 0.32,
    bitrate: '64k',
    channels: 1,
    desc: 'Firm gravel / stone step 4'
  },

  // ==========================================
  // WATER SFX (64 kbps, mono)
  // ==========================================
  {
    target: 'water/splash-01.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/splash_01.ogg`,
    start: 0.02,
    duration: 0.65,
    bitrate: '64k',
    channels: 1,
    desc: 'Water medium splash impact'
  },
  {
    target: 'water/splash-02.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/splash_02.ogg`,
    start: 0.02,
    duration: 0.55,
    bitrate: '64k',
    channels: 1,
    desc: 'Water jumping splash'
  },
  {
    target: 'water/splash-03.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/splash_04.ogg`,
    start: 0.02,
    duration: 0.62,
    bitrate: '64k',
    channels: 1,
    desc: 'Water hollow splash'
  },
  {
    target: 'water/splash-04.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/splash_05.ogg`,
    start: 0.02,
    duration: 0.68,
    bitrate: '64k',
    channels: 1,
    desc: 'Water deep splash'
  },
  {
    target: 'water/splash-05.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/splash_07.ogg`,
    start: 0.02,
    duration: 0.72,
    bitrate: '64k',
    channels: 1,
    desc: 'Water surface crash'
  },
  {
    target: 'water/splash-06.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/splash_11.ogg`,
    start: 0.02,
    duration: 0.75,
    bitrate: '64k',
    channels: 1,
    desc: 'Water heavy plunge splash'
  },
  {
    target: 'water/bubble-01.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/bubble_01.ogg`,
    start: 0.01,
    duration: 0.45,
    bitrate: '64k',
    channels: 1,
    desc: 'Water bubble pop'
  },
  {
    target: 'water/shoreline-01.mp3',
    source: `${STAGING}/unpacked/water-sfx-pack/loop_bubbles_02.ogg`,
    start: 0.5,
    duration: 4.5,
    bitrate: '64k',
    channels: 1,
    fades: { in: 0.2, out: 0.2 },
    desc: 'Shoreline bubbling water sound'
  },

  // ==========================================
  // TRANSITIONS (64k - 96k)
  // ==========================================
  {
    target: 'transitions/transition-light-01.mp3',
    source: `${STAGING}/unpacked/swishes-pack/swishes/swish-1.wav`,
    start: 0.01,
    duration: 0.12,
    bitrate: '64k',
    channels: 1,
    desc: 'Light snappy air swish'
  },
  {
    target: 'transitions/transition-light-02.mp3',
    source: `${STAGING}/interact.mp3`,
    start: 0.02,
    duration: 1.2,
    bitrate: '96k',
    channels: 2,
    fades: { in: 0.01, out: 0.1 },
    desc: 'Smooth neutral UI interaction chime'
  },
  {
    target: 'transitions/transition-heavy-01.mp3',
    source: `${STAGING}/unpacked/swishes-pack/swishes/swish-9.wav`,
    start: 0.01,
    duration: 0.19,
    bitrate: '64k',
    channels: 1,
    desc: 'Heavy dramatic preset whoosh'
  }
];

async function processAudio(item) {
  const dest = path.join(TARGET_BASE, item.target);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const filters = [];

  // Fades
  const fadeIn = item.fades?.in ?? 0.005;
  const fadeOut = item.fades?.out ?? 0.015;
  const duration = item.duration;

  filters.push(`afade=t=in:st=0:d=${fadeIn}`);
  filters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}`);

  // Normalization: use loudnorm for ambient/long sounds, volume normalization for short SFX
  if (duration >= 2.0) {
    filters.push('loudnorm=I=-20:TP=-1.5:LRA=11');
  } else {
    filters.push('volume=0.9');
  }

  const args = [
    '-y',
    '-ss', String(item.start),
    '-t', String(duration),
    '-i', item.source,
    '-af', filters.join(','),
    '-ac', String(item.channels || 1),
    '-b:a', item.bitrate || '64k',
    '-f', 'mp3',
    dest
  ];

  await execFileAsync('ffmpeg', args);

  // Probe output
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=channels,sample_rate',
    '-of', 'json',
    dest
  ]);
  const info = JSON.parse(stdout);
  const sizeBytes = Number(info.format?.size || 0);
  const actualDuration = Number(info.format?.duration || 0).toFixed(2);
  const channels = info.streams?.[0]?.channels;

  return {
    target: item.target,
    desc: item.desc,
    sizeBytes,
    sizeKB: (sizeBytes / 1024).toFixed(1),
    duration: actualDuration,
    channels
  };
}

(async () => {
  console.log('Building Environmental Sound Bank in public/Assets/Audio/...\n');

  let totalBytes = 0;
  const catalog = [];

  for (const item of BANK_MANIFEST) {
    try {
      const result = await processAudio(item);
      totalBytes += result.sizeBytes;
      catalog.push(result);
      console.log(`✓ ${result.target.padEnd(38)} [${result.sizeKB.padStart(5)} KB] (${result.duration}s, ${result.channels}ch)`);
    } catch (err) {
      console.error(`✗ FAILED: ${item.target} - ${err.message}`);
    }
  }

  const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
  console.log(`\n========================================`);
  console.log(`Sound Bank Generated: ${catalog.length} files`);
  console.log(`Total Size: ${totalMB} MB`);
  console.log(`========================================\n`);

  // Write CATALOG.md
  let md = `# Environmental Sound Bank Catalog\n\n`;
  md += `Total sounds: **${catalog.length}** | Total bank size: **${totalMB} MB**\n\n`;
  md += `All assets are CC0 (Public Domain) sourced from OpenGameArt.org.\n\n`;
  md += `| File | Size (KB) | Duration | Channels | Description |\n`;
  md += `| :--- | :---: | :---: | :---: | :--- |\n`;

  let currentDir = '';
  for (const row of catalog) {
    const dir = path.dirname(row.target);
    if (dir !== currentDir) {
      currentDir = dir;
      md += `| **${currentDir.toUpperCase()}** | | | | |\n`;
    }
    md += `| \`${row.target}\` | ${row.sizeKB} | ${row.duration}s | ${row.channels === 1 ? 'Mono' : 'Stereo'} | ${row.desc} |\n`;
  }

  await fs.writeFile(path.join(TARGET_BASE, 'CATALOG.md'), md, 'utf8');
  console.log(`Catalog written to: public/Assets/Audio/CATALOG.md`);
})();
