// Builds public/Assets/Audio from CC0 / public-domain recordings.
//
//   node scripts/build-audio.mjs              download what is missing, build everything
//   node scripts/build-audio.mjs --only=sea   build outputs whose path contains "sea"
//   node scripts/build-audio.mjs --inspect=<source>:<path>   print step onsets
//
// Every output is small on purpose: loops are short, seamless (the tail is
// equal-power crossfaded into the head, so the buffer can repeat forever) and
// encoded at a low bitrate; one-shots are mono. Sources are cached in
// .cache/audio-sources and never committed. CATALOG.md is rewritten with the
// source and licence of every file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache/audio-sources');
const OUT = path.join(ROOT, 'public/Assets/Audio');
const RATE = 44100;
const UA = 'grass-test-audio-build/1.0 (personal game project)';

const OGA = 'https://opengameart.org/sites/default/files/';
const WIKI = 'https://upload.wikimedia.org/wikipedia/commons/';

// Every recording used, with where it came from. `archive` sources are unpacked
// into a folder of the same id; outputs name files inside it as `id:path`.
const SOURCES = {
  ocean: { url: `${WIKI}6/64/Ocean_Waves_on_a_Tropical_Beach.ogg`, file: 'ocean-tropical-beach.ogg', license: 'CC0', author: 'Wikimedia Commons', page: 'https://commons.wikimedia.org/wiki/File:Ocean_Waves_on_a_Tropical_Beach.ogg' },
  waveAlkai: { url: `${OGA}wave_0{n}_cc0-18363__jasinski__alkaibeach.flac`, file: 'wave-alkai-{n}.flac', count: 4, license: 'CC0', author: 'jasinski', page: 'https://opengameart.org/content/beach-ocean-waves' },
  waveTransit: { url: `${OGA}wave_0{n}_cc0-11505__transitking__wavesound.flac`, file: 'wave-transit-{n}.flac', count: 4, license: 'CC0', author: 'transitking', page: 'https://opengameart.org/content/water-waves' },
  seagull: { url: `${OGA}Seagull%20Ambient%20{n}.wav`, file: 'seagull-{n}.wav', count: 7, license: 'CC0', author: 'Rango Mango', page: 'https://opengameart.org/content/solo-seagull-sound-effects' },
  amazon: { url: `${WIKI}8/87/404114_felix-blume_toucans-singing-in-the-amazonian-rainforest-brazil.ogg`, file: 'amazon-toucans.ogg', license: 'CC0', author: 'Felix Blume', page: 'https://commons.wikimedia.org/wiki/File:404114_felix-blume_toucans-singing-in-the-amazonian-rainforest-brazil.ogg' },
  costaRica: { url: `${WIKI}0/0a/20090610_0_ambience.ogg`, file: 'costa-rica-ambience.ogg', license: 'Public domain', author: 'Wikimedia Commons', page: 'https://commons.wikimedia.org/wiki/File:20090610_0_ambience.ogg' },
  piha: { url: `${WIKI}b/b0/Lipaugus_vociferans_singing_and_whistling.ogg`, file: 'screaming-piha.ogg', license: 'CC0', author: 'Wikimedia Commons', page: 'https://commons.wikimedia.org/wiki/File:Lipaugus_vociferans_singing_and_whistling.ogg' },
  parrots: { url: `${WIKI}9/9e/Parrots_perroquets.ogg`, file: 'parrots.ogg', license: 'Public domain', author: 'Wikimedia Commons', page: 'https://commons.wikimedia.org/wiki/File:Parrots_perroquets.ogg' },
  cicadaChorus: { url: `${WIKI}b/b1/Chorus_Cicada_singing.ogg`, file: 'cicada-chorus.ogg', license: 'CC0', author: 'Wikimedia Commons', page: 'https://commons.wikimedia.org/wiki/File:Chorus_Cicada_singing.ogg' },
  cicadaGreece: { url: `${WIKI}f/f4/Cicadas_in_Greece.ogg`, file: 'cicadas-greece.ogg', license: 'Public domain', author: 'Wikimedia Commons', page: 'https://commons.wikimedia.org/wiki/File:Cicadas_in_Greece.ogg' },
  frogCroak: { url: `${OGA}croak_0{n}.mp3`, file: 'frog-croak-{n}.mp3', count: 4, rename: { 1: 'croak_01_0.mp3' }, license: 'CC0', author: 'EZduzziteh', page: 'https://opengameart.org/content/frog-croaks' },
  parkWind: { url: `${OGA}park_ambience_wind.wav`, file: 'park-wind.wav', license: 'CC0', author: 'Thimras', page: 'https://opengameart.org/content/park-ambiences' },
  parkRiver: { url: `${OGA}park_ambience_river.wav`, file: 'park-river.wav', license: 'CC0', author: 'Thimras', page: 'https://opengameart.org/content/park-ambiences' },
  crickets: { url: `${OGA}crickets_1.mp3`, file: 'crickets.mp3', license: 'CC0', author: 'Wolfgang_', page: 'https://opengameart.org/content/crickets-ambient-noise-loopable' },
  rainPack: { url: `${OGA}Rain%20MP3.zip`, file: 'Rain_MP3.zip', archive: true, license: 'CC0', author: 'OpenGameArt', page: 'https://opengameart.org/content/rain-loopable' },
  birdsIsaiah: { url: `${OGA}birds-isaiah658_0.ogg`, file: 'birds-isaiah658.ogg', license: 'CC0', author: 'isaiah658', page: 'https://opengameart.org/content/ambient-bird-sounds' },
  birdChirping: { url: `${OGA}birdchirping071414_0.mp3`, file: 'birdchirping071414.mp3', license: 'CC0', author: 'OpenGameArt', page: 'https://opengameart.org/content/bird-chirping-sounds' },
  birdsCrickets: { url: `${OGA}birdsCrickets.zip`, file: 'birdsCrickets.zip', archive: true, license: 'CC0', author: 'OpenGameArt', page: 'https://opengameart.org/content/birdcricketfrog-and-mosquito-sounds' },
  crows: { url: `${OGA}Crows.ogg`, file: 'Crows.ogg', license: 'CC0', author: 'OpenGameArt', page: 'https://opengameart.org/content/crows-singing' },
  fantozzi: { url: `${OGA}Fantozzi-footsteps.7z`, file: 'Fantozzi-footsteps.7z', archive: true, license: 'CC0', author: 'Fantozzi', page: 'https://opengameart.org/content/fantozzis-footsteps-grasssand-stone' },
  snowSteps: { url: `${OGA}corsica_s-walking_in_snow.7z`, file: 'corsica_s-walking_in_snow.7z', archive: true, license: 'CC0', author: 'Corsica_S', page: 'https://opengameart.org/content/42-snow-and-gravel-footsteps' },
  leafRustle: { url: `${OGA}qubodup-rustle.7z`, file: 'qubodup-rustle.7z', archive: true, license: 'CC0', author: 'qubodup', page: 'https://opengameart.org/content/20-rustles-dry-leaves' },
  differentSteps: { url: `${OGA}%5Bkdd%5DDifferentSteps_0.zip`, file: 'DifferentSteps.zip', archive: true, license: 'CC0', author: 'kddekadenz', page: 'https://opengameart.org/content/different-steps-on-wood-stone-leaves-gravel-and-mud' },
  mudPack: { url: `${OGA}25-CC0-mud-sfx.zip`, file: '25-CC0-mud-sfx.zip', archive: true, license: 'CC0', author: 'OpenGameArt', page: 'https://opengameart.org/content/25-cc0-mud-sfx' },
  splashPack: { url: `${OGA}ezwa-water_splash.7z`, file: 'ezwa-water_splash.7z', archive: true, license: 'CC0', author: 'ezwa', page: 'https://opengameart.org/content/6-short-water-splashes' },
  waterPack: { url: `${OGA}water-splash-slime-sfx.zip`, file: 'water-splash-slime-sfx.zip', archive: true, license: 'CC0', author: 'OpenGameArt', page: 'https://opengameart.org/content/40-cc0-water-splash-slime-sfx' },
  interact: { url: `${OGA}interact_0.mp3`, file: 'interact.mp3', license: 'CC0', author: 'OpenGameArt', page: 'https://opengameart.org/content/interaction-sound' },
};

// Encodings. Beds keep stereo width; everything positional or short is mono.
const BED = { channels: 2, bitrate: '48k', rate: 32000 };
const ONE_SHOT = { channels: 1, bitrate: '40k', rate: 32000 };
const STEP = { channels: 1, bitrate: '48k', rate: 32000 };

const loop = (file, src, start, duration, extra = {}) => ({ file, kind: 'loop', src, start, duration, xfade: 2.5, ...BED, rmsDb: -22, ...extra });
const shot = (file, src, start, duration, extra = {}) => ({ file, kind: 'shot', src, start, duration, ...ONE_SHOT, peakDb: -3, ...extra });
const step = (file, src, extra = {}) => ({ file, kind: 'step', src, start: 0, duration: 8, length: 0.42, ...STEP, peakDb: -3, ...extra });
const range = (count, make) => Array.from({ length: count }, (_, i) => make(i, String(i + 1).padStart(2, '0')));

const OUTPUTS = [
  // Beds: region- or preset-weighted loops.
  loop('ambient/sea-surf.mp3', 'ocean', 212, 28, { xfade: 4, desc: 'Tropical beach surf, breaking waves' }),
  loop('ambient/jungle-day.mp3', 'amazon', 181, 32, { xfade: 4, desc: 'Amazon rainforest by day: toucans, birds, insects' }),
  loop('ambient/jungle-night.mp3', 'costaRica', 57, 30, { xfade: 4, desc: 'Tropical forest insect and frog chorus' }),
  // The park recording carries a steady rumble below ~150 Hz (distant traffic
  // and mic buffeting) that played as an engine idling under the world: half
  // the meadow bed's energy and 80% of the alpine one's. Two stacked
  // high-passes remove it and leave the wind's whoosh.
  loop('ambient/meadow-wind.mp3', 'parkWind', 40, 24, { xfade: 4, af: 'highpass=f=220,highpass=f=220', desc: 'Outdoor wind bed' }),
  loop('ambient/alpine-wind.mp3', 'parkWind', 150, 20, { xfade: 4, af: 'highpass=f=200,highpass=f=200,lowpass=f=3500', desc: 'Cold high-altitude wind' }),
  loop('ambient/stream.mp3', 'parkRiver', 30, 16, { xfade: 3, desc: 'Lake and river water flow' }),
  loop('ambient/night-crickets.mp3', 'crickets', 0.5, 8.5, { xfade: 2, desc: 'Night crickets' }),
  loop('ambient/rain.mp3', 'rainPack:2.mp3', 2, 18, { xfade: 3, desc: 'Steady rain' }),

  // Beach one-shots, placed along the waterline and over the sea.
  ...[1, 2, 3, 4].map((n, i) => shot(`beach/wave-${String(i + 1).padStart(2, '0')}.mp3`, `waveAlkai#${n}`, 0, 5, { fadeOut: 0.4, desc: 'Single wave breaking on the shore' })),
  ...[2, 3].map((n, i) => shot(`beach/wave-${String(i + 5).padStart(2, '0')}.mp3`, `waveTransit#${n}`, 0, 5, { fadeOut: 0.4, desc: 'Single wave breaking on the shore' })),
  ...[1, 3, 4, 5, 6, 7].map((n, i) => shot(`beach/seagull-${String(i + 1).padStart(2, '0')}.mp3`, `seagull#${n}`, 0, 4, { desc: 'Seagull call' })),

  // Jungle one-shots.
  shot('jungle/piha-01.mp3', 'piha', 0.6, 3.2, { desc: 'Screaming piha call' }),
  shot('jungle/piha-02.mp3', 'piha', 54.4, 3.4, { desc: 'Screaming piha call' }),
  shot('jungle/piha-03.mp3', 'piha', 75.2, 3.2, { desc: 'Screaming piha call' }),
  shot('jungle/parrot-01.mp3', 'parrots', 1.9, 1.4, { desc: 'Parrot squawk' }),
  shot('jungle/parrot-02.mp3', 'parrots', 25.9, 2.2, { desc: 'Parrot squawks' }),
  shot('jungle/parrot-03.mp3', 'parrots', 60.6, 2.0, { desc: 'Parrot squawks' }),
  shot('jungle/parrot-04.mp3', 'parrots', 36.9, 1.4, { desc: 'Parrot squawk' }),
  shot('jungle/cicada-01.mp3', 'cicadaChorus', 2, 9, { fadeIn: 1.2, fadeOut: 2.5, rmsDb: -24, peakDb: null, desc: 'Cicada swell' }),
  shot('jungle/cicada-02.mp3', 'cicadaGreece', 4, 9, { fadeIn: 1.2, fadeOut: 2.5, rmsDb: -24, peakDb: null, desc: 'Cicada swell' }),
  ...[1, 3, 4].map((n, i) => shot(`jungle/frog-${String(i + 1).padStart(2, '0')}.mp3`, `frogCroak#${n}`, 0, 1.4, { desc: 'Frog croak' })),

  // Meadow birds.
  shot('meadow/bird-01.mp3', 'birdsCrickets:birdsCrickets/bird.wav', 0.05, 0.65, { desc: 'Songbird chirp' }),
  shot('meadow/bird-02.mp3', 'birdsCrickets:birdsCrickets/bird2.wav', 0.05, 1.05, { desc: 'Songbird double trill' }),
  shot('meadow/bird-03.mp3', 'birdChirping', 0.1, 1.2, { desc: 'Wild bird call' }),
  shot('meadow/bird-04.mp3', 'birdsIsaiah', 4.8, 1.4, { desc: 'Sparrow chirp' }),
  shot('meadow/bird-05.mp3', 'birdsIsaiah', 12.0, 2.0, { desc: 'Songbird phrase' }),
  shot('meadow/crows-01.mp3', 'crows', 1.2, 4.5, { desc: 'Distant crows' }),

  // UI.
  shot('ui/transition.mp3', 'interact', 0.02, 1.2, { desc: 'Preset change chime' }),

  // Footsteps: one contact per file, cut at the step's onset.
  ...range(8, (i, n) => ({ ...step(`footsteps/grass-${n}.mp3`, `fantozzi:Fantozzi-footsteps/ogg/Fantozzi-Sand${['L1', 'R1', 'L2', 'R2', 'L3', 'R3', 'L1', 'R2'][i]}.ogg`), synth: 'grass', seed: i + 1, desc: 'Grass step: soft heel plus generated blade rustle' })),
  ...range(6, (i, n) => step(`footsteps/sand-${n}.mp3`, `fantozzi:Fantozzi-footsteps/ogg/Fantozzi-Sand${['L1', 'R1', 'L2', 'R2', 'L3', 'R3'][i]}.ogg`, { desc: 'Sand step' })),
  ...range(8, (i, n) => step(`footsteps/snow-${n}.mp3`, `snowSteps:Corsica_S-Walking_in_Snow/Corsica_S-Walking_on_snow_covered_gravel_${String([1, 3, 5, 7, 9, 11, 13, 15][i]).padStart(2, '0')}.flac`, { length: 0.5, desc: 'Snow step' })),
  // Jungle floor: a soft heel under a damp (low-passed) leaf rustle.
  ...range(6, (i, n) => step(`footsteps/leaves-${n}.mp3`, `fantozzi:Fantozzi-footsteps/ogg/Fantozzi-Sand${['L1', 'R1', 'L2', 'R2', 'L3', 'R3'][i]}.ogg`, {
    af: 'lowpass=f=900', layer: { src: `leafRustle:rustle/rustle${['02', '05', '09', '12', '17', '20'][i]}.flac`, af: 'lowpass=f=6000', gain: 0.9 },
    desc: 'Leaf-litter step: soft heel plus leaf rustle',
  })),
  ...range(6, (i, n) => step(`footsteps/gravel-${n}.mp3`, i === 0 ? 'differentSteps:gravel.ogg' : `fantozzi:Fantozzi-footsteps/ogg/Fantozzi-Stone${['L1', 'R1', 'L2', 'R2', 'L3'][i - 1]}.ogg`, { desc: 'Path step: gravel and packed stone' })),
  ...range(6, (i, n) => step(`footsteps/mud-${n}.mp3`, `mudPack:mud_${String([6, 8, 10, 12, 13, 15][i]).padStart(2, '0')}.ogg`, { length: 0.36, desc: 'Mud step' })),
  ...range(6, (i, n) => step(`footsteps/water-${n}.mp3`, i < 3 ? `splashPack:ezwa-water_splash/water_splash-0${[1, 2, 3][i]}.flac` : `waterPack:splash_${String([3, 6, 9][i - 3]).padStart(2, '0')}.ogg`, { length: 0.5, desc: 'Shallow water step' })),
];

// ---------------------------------------------------------------- sources

function sourceFiles(id) {
  const source = SOURCES[id];
  if (!source.count) return [{ url: source.url, file: source.file }];
  return Array.from({ length: source.count }, (_, i) => {
    const n = i + 1;
    const url = source.rename?.[n] ? `${OGA}${source.rename[n]}` : source.url.replaceAll('{n}', n);
    return { url, file: source.file.replaceAll('{n}', n) };
  });
}

async function exists(file) {
  try { return (await fs.stat(file)).size > 0; } catch { return false; }
}

async function fetchSource(id) {
  const source = SOURCES[id];
  for (const { url, file } of sourceFiles(id)) {
    const target = path.join(CACHE, file);
    if (!(await exists(target))) {
      process.stdout.write(`  download ${file}\n`);
      const response = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!response.ok) throw new Error(`${id}: ${url} returned ${response.status}`);
      await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (source.archive) {
      const folder = path.join(CACHE, 'unpacked', id);
      if (!(await exists(folder))) {
        await fs.mkdir(folder, { recursive: true });
        await execFileAsync('7z', ['x', '-y', `-o${folder}`, target]);
      }
    }
  }
}

function resolveSource(ref) {
  const [head, inner] = ref.split(':');
  const [id, index] = head.split('#');
  if (!SOURCES[id]) throw new Error(`Unknown source ${id}`);
  if (inner) return { id, file: path.join(CACHE, 'unpacked', id, inner) };
  const files = sourceFiles(id);
  return { id, file: path.join(CACHE, files[index ? Number(index) - 1 : 0].file) };
}

// ---------------------------------------------------------------- PCM i/o

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${command} failed: ${stderr}`))));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function decode(file, { start = 0, duration, channels, af }) {
  const args = ['-v', 'error', '-ss', String(start)];
  if (duration) args.push('-t', String(duration));
  args.push('-i', file);
  if (af) args.push('-af', af);
  args.push('-f', 'f32le', '-ac', String(channels), '-ar', String(RATE), '-');
  const bytes = await run('ffmpeg', args);
  const interleaved = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const frames = Math.floor(interleaved.length / channels);
  return Array.from({ length: channels }, (_, c) => {
    const data = new Float32Array(frames);
    for (let i = 0; i < frames; i++) data[i] = interleaved[i * channels + c];
    return data;
  });
}

async function encode(channels, target, { bitrate, rate }) {
  const frames = channels[0].length;
  const interleaved = new Float32Array(frames * channels.length);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels.length; c++) interleaved[i * channels.length + c] = channels[c][i];
  await fs.mkdir(path.dirname(target), { recursive: true });
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', String(channels.length), '-i', '-',
    '-codec:a', 'libmp3lame', '-b:a', bitrate, '-ar', String(rate), target], Buffer.from(interleaved.buffer));
}

// ---------------------------------------------------------------- DSP

const db = (value) => 10 ** (value / 20);

function peak(channels) {
  let result = 0;
  for (const data of channels) for (const value of data) result = Math.max(result, Math.abs(value));
  return result;
}

function rms(channels) {
  let sum = 0;
  let count = 0;
  for (const data of channels) for (const value of data) { sum += value * value; count++; }
  return Math.sqrt(sum / Math.max(1, count));
}

function scale(channels, gain) {
  for (const data of channels) for (let i = 0; i < data.length; i++) data[i] *= gain;
}

// Gentle tanh knee above -1.5 dBFS so an RMS-normalised bed never clips.
function limit(channels) {
  const knee = db(-1.5);
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      const magnitude = Math.abs(value);
      if (magnitude > knee) data[i] = Math.sign(value) * (knee + (1 - knee) * Math.tanh((magnitude - knee) / (1 - knee)));
    }
  }
}

function normalise(channels, { rmsDb, peakDb }) {
  if (peakDb != null) scale(channels, db(peakDb) / Math.max(1e-6, peak(channels)));
  else if (rmsDb != null) scale(channels, db(rmsDb) / Math.max(1e-6, rms(channels)));
  limit(channels);
}

// The segment is duration + xfade long. The last xfade seconds are blended
// under the first xfade seconds with an equal-power curve, so sample N-1 runs
// straight into sample 0 when the buffer loops.
function makeSeamless(channels, duration, xfade) {
  const length = Math.round(duration * RATE);
  const fade = Math.round(xfade * RATE);
  return channels.map((data) => {
    if (data.length < length + fade) throw new Error(`segment too short for a ${duration}s loop with ${xfade}s crossfade`);
    const out = data.slice(0, length);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      out[i] = data[i] * Math.sin(t * Math.PI / 2) + data[length + i] * Math.cos(t * Math.PI / 2);
    }
    return out;
  });
}

function fadeEdges(channels, fadeIn, fadeOut) {
  const inFrames = Math.max(1, Math.round(fadeIn * RATE));
  const outFrames = Math.max(1, Math.round(fadeOut * RATE));
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const gain = Math.min(1, i / inFrames, (data.length - 1 - i) / outFrames);
      data[i] *= gain * gain * (3 - 2 * gain);
    }
  }
}

// Short-window energy envelope and attack detection, for cutting single
// footsteps (and trimming leading silence) out of longer recordings.
function onsets(channels) {
  const hop = Math.round(RATE * 0.005);
  const energy = [];
  for (let start = 0; start < channels[0].length; start += hop) {
    let sum = 0;
    const end = Math.min(channels[0].length, start + hop);
    for (const data of channels) for (let i = start; i < end; i++) sum += data[i] * data[i];
    energy.push(Math.sqrt(sum / ((end - start) * channels.length)));
  }
  const top = Math.max(...energy);
  const result = [];
  let quiet = 100;
  let last = -1000;
  for (let i = 0; i < energy.length; i++) {
    if (energy[i] < top * 0.08) quiet++;
    else if (energy[i] > top * 0.2) {
      if (quiet >= 10 && i - last >= 50) { result.push(i * hop); last = i; }
      quiet = 0;
    }
  }
  return result.length ? result : [0];
}

function trimToOnset(channels, onsetIndex, length) {
  const found = onsets(channels);
  const start = Math.max(0, found[Math.min(onsetIndex, found.length - 1)] - Math.round(RATE * 0.004));
  const frames = Math.min(channels[0].length - start, Math.round(length * RATE));
  return channels.map((data) => data.slice(start, start + frames));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Two-pole state-variable band-pass, enough to shape noise into rustle.
function bandNoise(length, low, high, random) {
  const out = new Float32Array(length);
  let lp1 = 0; let lp2 = 0; let hp = 0; let prev = 0;
  const aLow = 1 - Math.exp(-2 * Math.PI * high / RATE);
  const aHigh = Math.exp(-2 * Math.PI * low / RATE);
  for (let i = 0; i < length; i++) {
    const white = random() * 2 - 1;
    hp = aHigh * (hp + white - prev);
    prev = white;
    lp1 += aLow * (hp - lp1);
    lp2 += aLow * (lp1 - lp2);
    out[i] = lp2;
  }
  return out;
}

// Cascaded one-pole low-pass (6 dB/octave per pole).
function lowpass(data, hz, poles) {
  const a = 1 - Math.exp(-2 * Math.PI * hz / RATE);
  for (let p = 0; p < poles; p++) {
    let state = 0;
    for (let i = 0; i < data.length; i++) { state += a * (data[i] - state); data[i] = state; }
  }
  return data;
}

// Grass under a boot: the blades brush and snap (sparse crackle grains in a
// 1.6-5 kHz band), a softer swish while the foot rolls, and a little lift-off
// rustle. It is mixed over the source step, low-passed, which supplies the
// weight of the heel.
function synthGrass(heel, seed) {
  const random = mulberry32(seed * 7919);
  const length = heel[0].length;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = heel[0][i] * 1.4;

  const swish = bandNoise(length, 500, 2400, random);
  const crackle = bandNoise(length, 1600, 5200, random);
  const roll = 0.07 + random() * 0.04;
  const lift = 0.2 + random() * 0.06;
  for (let i = 0; i < length; i++) {
    const t = i / RATE;
    const contact = Math.min(1, t / 0.012) * Math.exp(-t / 0.09);
    const rolling = Math.exp(-((t - roll) ** 2) / (2 * 0.03 ** 2));
    const lifting = 0.45 * Math.exp(-((t - lift) ** 2) / (2 * 0.035 ** 2));
    out[i] += swish[i] * 1.1 * (0.6 * contact + 0.5 * rolling + lifting);
  }
  // Blade snaps: a Poisson train of 1-3 ms grains, densest at contact.
  let t = 0;
  while (t < length / RATE) {
    const density = 900 * Math.exp(-t / 0.08) + 250 * Math.exp(-((t - lift) ** 2) / (2 * 0.04 ** 2)) + 20;
    t += -Math.log(1 - random()) / density;
    const at = Math.round(t * RATE);
    const grain = Math.round(RATE * (0.001 + random() * 0.002));
    const amplitude = (0.4 + random() * 0.8) * 2.6;
    for (let i = 0; i < grain && at + i < length; i++) {
      const window = Math.sin(Math.PI * i / grain);
      out[at + i] += crackle[at + i] * amplitude * window;
    }
  }
  return [lowpass(out, 5500, 3)];
}

// ---------------------------------------------------------------- build

async function build(output) {
  const { file } = resolveSource(output.src);
  let channels;
  if (output.kind === 'loop') {
    channels = await decode(file, { start: output.start, duration: output.duration + output.xfade + 0.25, channels: output.channels, af: output.af });
    channels = makeSeamless(channels, output.duration, output.xfade);
    normalise(channels, output);
  } else if (output.kind === 'shot') {
    channels = await decode(file, { start: output.start, duration: output.duration, channels: output.channels, af: output.af });
    fadeEdges(channels, output.fadeIn ?? 0.004, output.fadeOut ?? 0.12);
    normalise(channels, output);
  } else {
    const heelFilter = output.synth === 'grass' ? 'lowpass=f=900' : undefined;
    const af = [output.af, heelFilter].filter(Boolean).join(',') || undefined;
    channels = await decode(file, { start: output.start, duration: output.duration, channels: 1, af });
    channels = trimToOnset(channels, output.onset ?? 0, output.length);
    if (output.synth === 'grass') channels = synthGrass(channels, output.seed);
    if (output.layer) {
      const layer = trimToOnset(await decode(resolveSource(output.layer.src).file, { channels: 1, af: output.layer.af }), 0, output.length);
      const base = channels[0];
      const scaleLayer = output.layer.gain * peak(channels) / Math.max(1e-6, peak(layer));
      for (let i = 0; i < Math.min(base.length, layer[0].length); i++) base[i] += layer[0][i] * scaleLayer;
    }
    fadeEdges(channels, 0.002, 0.08);
    normalise(channels, output);
  }
  const target = path.join(OUT, output.file);
  await encode(channels, target, output);
  return { ...output, bytes: (await fs.stat(target)).size, seconds: channels[0].length / RATE };
}

async function writeCatalog(results) {
  const total = results.reduce((sum, r) => sum + r.bytes, 0);
  const lines = [
    '# Sound bank',
    '',
    `Generated by \`npm run audio:build\` (scripts/build-audio.mjs). ${results.length} files, ${(total / 1024).toFixed(0)} KB.`,
    'Loops are crossfaded into themselves and repeat seamlessly. Grass steps are a',
    'low-passed sand step with generated blade rustle layered on top.',
    '',
    '| File | KB | Seconds | Ch | Description | Source | Licence |',
    '| :--- | ---: | ---: | :---: | :--- | :--- | :--- |',
  ];
  for (const r of results) {
    const source = SOURCES[resolveSource(r.src).id];
    lines.push(`| \`${r.file}\` | ${(r.bytes / 1024).toFixed(1)} | ${r.seconds.toFixed(2)} | ${r.channels} | ${r.desc ?? ''} | [${source.author}](${source.page}) | ${source.license} |`);
  }
  await fs.writeFile(path.join(OUT, 'CATALOG.md'), `${lines.join('\n')}\n`);
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')));
  await fs.mkdir(CACHE, { recursive: true });
  if (args.inspect) {
    const [id] = args.inspect.split(/[:#]/);
    await fetchSource(id);
    const channels = await decode(resolveSource(args.inspect).file, { channels: 1 });
    console.log(`${(channels[0].length / RATE).toFixed(2)}s onsets:`, onsets(channels).map((i) => (i / RATE).toFixed(3)).join(' '));
    return;
  }
  const selected = OUTPUTS.filter((output) => !args.only || output.file.includes(args.only));
  for (const id of new Set(selected.map((output) => resolveSource(output.src).id))) await fetchSource(id);
  const results = [];
  for (const output of selected) {
    const result = await build(output);
    results.push(result);
    console.log(`${result.file.padEnd(34)} ${(result.bytes / 1024).toFixed(1).padStart(6)} KB  ${result.seconds.toFixed(2)}s`);
  }
  if (!args.only) await writeCatalog(results);
  console.log(`total ${(results.reduce((sum, r) => sum + r.bytes, 0) / 1024).toFixed(0)} KB`);
}

await main();
