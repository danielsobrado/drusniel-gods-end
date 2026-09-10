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
