// scripts/inspect-sources.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

async function probe(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate,format_name:stream=codec_name,channels,sample_rate',
      '-of', 'json',
      file
    ]);
    const info = JSON.parse(stdout);
    const duration = Number(info.format?.duration || 0).toFixed(2);
    const channels = info.streams?.[0]?.channels || 1;
    const codec = info.streams?.[0]?.codec_name || '';
    const sampleRate = info.streams?.[0]?.sample_rate || '';
    return { file: path.basename(file), duration, channels, codec, sampleRate };
  } catch (err) {
    return { file: path.basename(file), error: err.message };
  }
}

(async () => {
  const checkFiles = [
    '.cache/audio-sources/wind_woosh_loop.ogg',
    '.cache/audio-sources/unpacked/wind-pack/wind/Wind.ogg',
    '.cache/audio-sources/unpacked/wind-pack/wind/Wind2.ogg',
    '.cache/audio-sources/unpacked/wind-pack/wind/Wind3.ogg',
    '.cache/audio-sources/Forest_Ambience.mp3',
    '.cache/audio-sources/birdchirping071414.mp3',
    '.cache/audio-sources/birds-isaiah658.ogg',
    '.cache/audio-sources/crow.ogg',
    '.cache/audio-sources/Crows.ogg',
    '.cache/audio-sources/unpacked/birds-crickets-pack/birdsCrickets/bird.wav',
    '.cache/audio-sources/unpacked/birds-crickets-pack/birdsCrickets/bird2.wav',
    '.cache/audio-sources/unpacked/birds-crickets-pack/birdsCrickets/birdNight.wav',
    '.cache/audio-sources/unpacked/birds-crickets-pack/birdsCrickets/cricket.wav',
    '.cache/audio-sources/unpacked/birds-crickets-pack/birdsCrickets/cricket2.wav',
    '.cache/audio-sources/unpacked/birds-crickets-pack/birdsCrickets/distressedMosquito.wav',
    '.cache/audio-sources/unpacked/birds-crickets-pack/birdsCrickets/frog.wav',
    '.cache/audio-sources/cricketsounds090613.mp3',
    '.cache/audio-sources/swamp.ogg',
    '.cache/audio-sources/unpacked/water-sfx-pack/loop_water_01.ogg',
    '.cache/audio-sources/unpacked/water-sfx-pack/loop_water_02.ogg',
    '.cache/audio-sources/unpacked/water-sfx-pack/loop_water_03.ogg',
    '.cache/audio-sources/unpacked/water-sfx-pack/loop_bubbles_02.ogg',
    '.cache/audio-sources/unpacked/rain-pack/1.mp3',
    '.cache/audio-sources/unpacked/rain-pack/2.mp3',
    '.cache/audio-sources/unpacked/rain-pack/3.mp3',
    '.cache/audio-sources/unpacked/rain-pack/4.mp3',
    '.cache/audio-sources/interact.mp3',
  ];

  for (const f of checkFiles) {
    const p = await probe(f);
    console.log(`${p.file.padEnd(30)} ${p.duration}s  ch:${p.channels}  ${p.codec}  ${p.sampleRate}Hz`);
  }
})();
