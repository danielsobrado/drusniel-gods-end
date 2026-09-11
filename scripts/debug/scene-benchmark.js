import { FrameProfiler } from '../../src/debug/FrameProfiler.js';

const DEFAULT_SCENARIOS = [
  { id: 'openingMeadow', position: [2, null, -5], target: [40, 6, 30], move: [36, 0, 0] },
  { id: 'denseForest', position: [-280, null, 20], target: [-350, 12, 90], move: [0, 0, 36] },
  { id: 'river', position: [88, null, -19], target: [110, 8, 8], move: [24, 0, 24] },
  { id: 'lake', position: [145, null, 104], target: [250, -8, 160], move: [36, 0, 0] },
  { id: 'coast', position: [950, null, 80], target: [1100, -18, 80], move: [0, 0, 36] },
];

function waitUntil(predicate, message, timeout) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (performance.now() - started > timeout) return reject(new Error(message));
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function sampleHeight(demo, x, z, fallback = 5) {
  const y = demo.world.terrainSampler.sampleHeight(x, z);
  return Number.isFinite(y) ? y : fallback;
}

function pose(demo, scenario, phase = 0) {
  const x = scenario.position[0] + scenario.move[0] * phase;
  const z = scenario.position[2] + scenario.move[2] * phase;
  const ground = sampleHeight(demo, x, z);
  const eye = (scenario.position[1] ?? ground) + 6;
  const target = scenario.target.slice();
  if (target[1] == null) target[1] = sampleHeight(demo, target[0], target[2]) + 2;
  // setPosition expects root height, matching PlayerController's terrain snap.
  // Keep the feet at groundOffset above terrain and the lens independent.
  const { rootToFeet, groundOffset } = demo.player.metrics;
  demo.player.setPosition(x, ground + rootToFeet + groundOffset, z);
  demo.world.camera.position.set(x, eye, z);
  demo.world.camera.lookAt(...target);
}

function capturePoseMeta(demo) {
  const player = demo.player.getPosition();
  const camera = demo.world.camera.position;
  const { rootToFeet, groundOffset } = demo.player.metrics;
  return {
    player: [player.x, player.y, player.z],
    camera: [camera.x, camera.y, camera.z],
    feetY: player.y - rootToFeet,
    cameraAboveRoot: camera.y > player.y,
    avatarVisible: demo.player.root?.visible ?? null,
    rootToFeet,
    groundOffset,
  };
}

async function measure(demo, scenario, moving, { warmupSeconds, measureSeconds }) {
  demo.profiler ??= new FrameProfiler();
  let elapsed = 0;
  demo.player.update = (delta = 0.016) => {
    if (!moving) return;
    elapsed += delta;
    pose(demo, scenario, (elapsed % 4) / 4);
  };
  pose(demo, scenario, 0);
  const poseMeta = capturePoseMeta(demo);
  demo.profiler.startTimed({ warmupSeconds, measureSeconds });
  await waitUntil(
    () => demo.profiler.done,
    `${scenario.id} ${moving ? 'moving' : 'stationary'} measurement timed out`,
    (warmupSeconds + measureSeconds + 30) * 1000,
  );
  return { ...demo.profiler.summarize(), pose: poseMeta };
}

export function snapshotSceneControls(demo) {
  return {
    playerUpdate: demo.player.update,
    tourUpdate: demo.tour.update,
    playerEnabled: demo.player.enabled,
    playerVisible: demo.player.root?.visible ?? true,
    tourActive: demo.tour.active,
    position: demo.player.getPosition().clone(),
    camera: demo.world.camera.position.clone(),
    rotation: demo.world.camera.quaternion.clone(),
  };
}

export function restoreSceneControls(demo, snapshot) {
  demo.player.setPosition(snapshot.position.x, snapshot.position.y, snapshot.position.z);
  demo.world.camera.position.copy(snapshot.camera);
  demo.world.camera.quaternion.copy(snapshot.rotation);
  demo.player.update = snapshot.playerUpdate;
  demo.tour.update = snapshot.tourUpdate;
  demo.tour.active = snapshot.tourActive;
  demo.player.setEnabled(snapshot.playerEnabled);
  if (demo.player.root) demo.player.root.visible = snapshot.playerVisible;
}

export function freezeSceneControls(demo) {
  demo.tour.update = () => {};
  demo.player.setEnabled(false);
  demo.tour.active = false;
  if (demo.player.root) demo.player.root.visible = false;
}

export async function runSceneBenchmark({
  demo = window.__grassDemo,
  warmupSeconds = 5,
  measureSeconds = 30,
  repetitions = 3,
  scenarios = DEFAULT_SCENARIOS,
  shareVertices,
  manageControls = true,
  onProgress = () => {},
} = {}) {
  if (!demo?.started) throw new Error('Wait for the scene to finish loading, then enter the world.');
  const saved = manageControls ? snapshotSceneControls(demo) : null;
  const previousShare = demo.grass?.shareVertices;
  if (manageControls) freezeSceneControls(demo);
  if (shareVertices !== undefined) demo.grass?.setShareVertices(shareVertices);
  const meta = demo.getProfileResults();
  const results = {
    backend: meta.backend,
    viewport: meta.viewport,
    pixelRatio: meta.pixelRatio,
    gpuTiming: meta.gpuTiming,
    quality: meta.quality,
    shareVertices: demo.grass?.shareVertices ?? shareVertices ?? true,
    templateVertices: templateVertexCounts(demo),
    warmupSeconds,
    measureSeconds,
    repetitions,
    scenarios: {},
  };
  try {
    for (const scenario of scenarios) {
      const record = { stationary: [], moving: [] };
      for (let rep = 0; rep < repetitions; rep += 1) {
        onProgress({
          scenario: scenario.id, mode: 'stationary', rep, shareVertices: results.shareVertices,
        });
        record.stationary.push(await measure(demo, scenario, false, { warmupSeconds, measureSeconds }));
        onProgress({
          scenario: scenario.id, mode: 'moving', rep, shareVertices: results.shareVertices,
        });
        record.moving.push(await measure(demo, scenario, true, { warmupSeconds, measureSeconds }));
      }
      results.scenarios[scenario.id] = record;
    }
  } finally {
    if (manageControls && shareVertices !== undefined && previousShare !== undefined) {
      demo.grass?.setShareVertices(previousShare);
    }
    if (saved) restoreSceneControls(demo, saved);
  }
  demo.lastBenchmark = results;
  return results;
}

function templateVertexCounts(demo) {
  const geometries = demo.grass?.geometries;
  if (!geometries) return null;
  return Object.fromEntries(
    Object.entries(geometries).map(([lod, geometry]) => [
      lod,
      geometry.getAttribute?.('position')?.count ?? null,
    ]),
  );
}

async function settle(seconds) {
  const until = performance.now() + seconds * 1000;
  await waitUntil(() => performance.now() >= until, 'settle timed out', seconds * 1000 + 2000);
}

export async function captureArrivalHitch(demo, scenario, { measureSeconds = 8 } = {}) {
  if (!demo?.started) throw new Error('Wait for the scene to finish loading, then enter the world.');
  return measure(demo, scenario, false, { warmupSeconds: 0, measureSeconds });
}

export async function runTopologyComparison({
  demo = window.__grassDemo,
  warmupSeconds = 5,
  measureSeconds = 30,
  repetitions = 3,
  scenarios = DEFAULT_SCENARIOS,
  hitchSeconds = 8,
  settleSeconds = 5,
  onProgress = () => {},
} = {}) {
  if (!demo?.started) throw new Error('Wait for the scene to finish loading, then enter the world.');
  const saved = snapshotSceneControls(demo);
  const previousShare = demo.grass?.shareVertices !== false;
  freezeSceneControls(demo);
  const forest = scenarios.find((scenario) => scenario.id === 'denseForest') ?? DEFAULT_SCENARIOS[1];
  const progress = (phase, extra = {}) => {
    const status = { phase, ...extra };
    demo.topologyBenchmarkProgress = status;
    onProgress(status);
  };
  const results = {
    hitch: null,
    shared: null,
    duplicated: null,
    sharedRepeat: null,
    runs: [],
  };
  demo.lastTopologyComparison = results;
  try {
    demo.grass.setShareVertices(true);
    progress('forestHitch');
    results.hitch = await captureArrivalHitch(demo, forest, { measureSeconds: hitchSeconds });
    progress('settleAfterHitch', { hitchMs: results.hitch.hitch?.maxProcessingMs });
    await settle(settleSeconds);
    const order = [
      { shareVertices: true, key: 'shared', phase: 'sharedProtocol' },
      { shareVertices: false, key: 'duplicated', phase: 'duplicatedProtocol' },
      { shareVertices: true, key: 'sharedRepeat', phase: 'sharedRepeatProtocol' },
    ];
    for (const step of order) {
      progress(step.phase === 'duplicatedProtocol' ? 'duplicatedRebuild' : step.phase);
      demo.grass.setShareVertices(step.shareVertices);
      await settle(settleSeconds);
      progress(step.phase);
      const run = await runSceneBenchmark({
        demo, warmupSeconds, measureSeconds, repetitions, scenarios,
        shareVertices: step.shareVertices, manageControls: false,
        onProgress: (extra) => progress(step.phase, extra),
      });
      results[step.key] = run;
      results.runs.push(run);
    }
    progress('done');
  } finally {
    demo.grass?.setShareVertices(previousShare);
    restoreSceneControls(demo, saved);
  }
  return results;
}

export { DEFAULT_SCENARIOS, pose, capturePoseMeta };

export const BIOME_SCENARIOS = [
  ...DEFAULT_SCENARIOS,
  { id: 'closeShrubs', position: [12, null, 8], target: [16, 1.2, 10], move: [8, 0, 4], gameplay: true },
  { id: 'lowGrassAngle', position: [2, null, -5], target: [18, 0.4, 4], move: [12, 0, 0], eyeHeight: 1.4 },
  { id: 'lodNearBoundary', position: [2, null, -5], target: [22, 4, 8], move: [20, 0, 0] },
  { id: 'lodFarBoundary', position: [2, null, -5], target: [70, 8, 8], move: [48, 0, 0] },
  { id: 'cellCrossing', position: [0, null, 0], target: [40, 6, 0], move: [64, 0, 0] },
];

export function poseGameplay(demo, scenario, phase = 0) {
  const x = scenario.position[0] + scenario.move[0] * phase;
  const z = scenario.position[2] + scenario.move[2] * phase;
  const ground = sampleHeight(demo, x, z);
  const { rootToFeet, groundOffset } = demo.player.metrics;
  demo.player.setPosition(x, ground + rootToFeet + groundOffset, z);
  demo.player.cameraYaw ??= 0;
  demo.player.cameraPitch ??= demo.config?.camera?.pitch ?? -0.25;
  demo.player.targetCameraDistance = demo.player.cameraDistance;
  if (typeof demo.player.update === 'function' && demo.player.enabled) return;
  const height = scenario.eyeHeight ?? (demo.player.cameraControls?.cameraHeight ?? 4);
  demo.world.camera.position.set(x, ground + rootToFeet + height, z + (demo.player.cameraDistance ?? 5));
  const target = scenario.target.slice();
  if (target[1] == null) target[1] = sampleHeight(demo, target[0], target[2]) + 2;
  demo.world.camera.lookAt(...target);
}

function percentileMean(runs, path) {
  const values = runs.map((run) => path(run)).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

export function evaluateBiomeGate(baseline, feature) {
  const failures = [];
  const limitations = [];
  for (const [id, record] of Object.entries(feature.scenarios ?? {})) {
    const baseRecord = baseline.scenarios?.[id];
    if (!baseRecord) {
      failures.push(`${id}: missing baseline`);
      continue;
    }
    for (const mode of ['stationary', 'moving']) {
      const nextRuns = record[mode] ?? [];
      const baseRuns = baseRecord[mode] ?? [];
      const processingMedian = percentileMean(nextRuns, (run) => run.processing?.median);
      const processingP95 = percentileMean(nextRuns, (run) => run.processing?.p95);
      const baseMedian = percentileMean(baseRuns, (run) => run.processing?.median);
      const baseP95 = percentileMean(baseRuns, (run) => run.processing?.p95);
      if (processingMedian > baseMedian * 1.10) {
        failures.push(`${id} ${mode} processing median ${processingMedian.toFixed(3)} > ${ (baseMedian * 1.10).toFixed(3)}`);
      }
      if (processingP95 > baseP95 * 1.10) {
        failures.push(`${id} ${mode} processing p95 ${processingP95.toFixed(3)} > ${(baseP95 * 1.10).toFixed(3)}`);
      }
      const gpuMedian = percentileMean(nextRuns, (run) => run.gpuTimestamp?.median);
      const gpuP95 = percentileMean(nextRuns, (run) => run.gpuTimestamp?.p95);
      const baseGpuMedian = percentileMean(baseRuns, (run) => run.gpuTimestamp?.median);
      const baseGpuP95 = percentileMean(baseRuns, (run) => run.gpuTimestamp?.p95);
      if (gpuMedian == null || baseGpuMedian == null) {
        limitations.push(`${id} ${mode}: GPU timestamps unavailable; not treated as zero cost`);
      } else {
        if (gpuMedian > baseGpuMedian * 1.10) {
          failures.push(`${id} ${mode} GPU median ${gpuMedian.toFixed(3)} > ${(baseGpuMedian * 1.10).toFixed(3)}`);
        }
        if (gpuP95 > baseGpuP95 * 1.10) {
          failures.push(`${id} ${mode} GPU p95 ${gpuP95.toFixed(3)} > ${(baseGpuP95 * 1.10).toFixed(3)}`);
        }
      }
    }
  }
  return {
    pass: failures.length === 0,
    failures,
    limitations,
    verified: failures.length === 0 && limitations.length === 0,
  };
}

export async function runBiomeBenchmark({
  demo = window.__grassDemo,
  presets = ['sunny', 'windy'],
  qualities = ['performance', 'balanced', 'high', 'ultra'],
  ...options
} = {}) {
  const results = {
    commit: demo.world?.rendererSession?.diagnostics ?? null,
    backend: demo.getProfileResults()?.backend,
    browser: navigator.userAgent,
    gpu: demo.world?.renderer?.backend?.getContext?.()?.getParameter?.(0x1F00) ?? null,
    viewport: demo.getProfileResults()?.viewport,
    pixelRatio: demo.getProfileResults()?.pixelRatio,
    presets: {},
    gate: null,
  };
  const savedEnabled = demo.config.biomes?.referenceScrub?.enabled === true;
  try {
    for (const preset of presets) {
      results.presets[preset] = {};
      for (const quality of qualities) {
        demo.ui?.actions?.setQuality?.(quality);
        demo.config.biomes.referenceScrub.enabled = false;
        await demo.ui.actions.setPreset(preset);
        const baseline = await runSceneBenchmark({
          demo, scenarios: BIOME_SCENARIOS, ...options,
        });
        demo.config.biomes.referenceScrub.enabled = true;
        await demo.ui.actions.setPreset(preset);
        const feature = await runSceneBenchmark({
          demo, scenarios: BIOME_SCENARIOS, ...options,
        });
        const gate = evaluateBiomeGate(baseline, feature);
        results.presets[preset][quality] = { baseline, feature, gate };
      }
    }
    const failures = Object.values(results.presets).flatMap((qualityMap) => (
      Object.values(qualityMap).flatMap((entry) => entry.gate.failures)
    ));
    results.gate = { pass: failures.length === 0, failures };
  } finally {
    demo.config.biomes.referenceScrub.enabled = savedEnabled;
  }
  demo.lastBiomeBenchmark = results;
  return results;
}
