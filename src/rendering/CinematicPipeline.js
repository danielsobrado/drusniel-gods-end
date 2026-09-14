import { RenderPipeline, FloatType, RedFormat, NearestFilter, Vector3 } from 'three/webgpu';
import {
  pass, rtt, renderOutput, vec4, vec3, vec2, uniform, mix, dot, uv, smoothstep, float, fract, sin, screenCoordinate, time,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { GpuOcclusion } from './GpuOcclusion.js';
import { createDepthNormals } from './DepthNormals.js';
import { withSceneWarmup } from './SceneWarmup.js';
import {
  accountComposite,
  applyCpuMarks,
  resetCpuStats,
  wrapNodeUpdateBefore,
} from '../debug/cinematicCpuBreakdown.js';

export class CinematicPipeline {
  constructor(world, config) {
    this.world = world;
    this.settings = config.cinematic?.post;
    this.enabled = Boolean(config.cinematic?.enabled);
    this.gpuOcclusion = new GpuOcclusion(world, config.cinematic?.occlusion);
    this.cpu = resetCpuStats({});
    this.cpuHooksInstalled = false;
    if (!this.enabled) return;
    this.post = new RenderPipeline(world.renderer);
    this.post.outputColorTransform = false;
    // Coverage samples stabilize moving subpixel blades; FXAA alone cannot.
    this.scenePass = pass(world.scene, world.camera, { samples: this.settings.samples ?? 4 });
    const beauty = this.scenePass.getTextureNode('output');
    // r185 still issues an invalid mip-level query for multisampled depth in
    // GTAO. Resolve to color and explicitly reconstruct scalar-depth normals.
    this.aoDepth = rtt(this.scenePass.getTextureNode('depth').r, null, null, {
      type: FloatType, format: RedFormat, minFilter: NearestFilter, magFilter: NearestFilter,
    });
    this.aoNormals = createDepthNormals(this.aoDepth, world.camera);
    this.occlusion = ao(this.aoDepth, this.aoNormals, world.camera);
    this.occlusion.radius.value = this.settings.aoRadius;
    this.occlusion.thickness.value = 1;
    this.occlusion.resolutionScale = 0.5;
    this.aoStrength = uniform(this.settings.aoStrength);
    this.bloom = bloom(beauty, this.settings.bloomStrength, 0.3, this.settings.bloomThreshold);
    const post = this.settings;
    this.grade = {
      saturation: uniform(post.saturation ?? 1),
      contrast: uniform(post.contrast ?? 1),
      lift: uniform(new Vector3().fromArray(post.lift ?? [0, 0, 0])),
      gain: uniform(new Vector3().fromArray(post.gain ?? [1, 1, 1])),
      highlightDesaturation: uniform(post.highlightDesaturation ?? 0),
      vignette: uniform(post.vignette ?? 0),
      grain: uniform(post.grain ?? 0),
    };
    // Filmic grade in linear light ahead of the ACES output transform:
    // saturation, pivot-preserving contrast, a lift/gain split that cools
    // shadows and warms highlights, highlight desaturation so sunlit grass
    // bleaches toward white instead of neon, a soft vignette and animated grain.
    const luma = vec3(0.2126, 0.7152, 0.0722);
    const grade = (input) => {
      const saturated = mix(vec3(dot(input, luma)), input, this.grade.saturation);
      const pivot = float(0.18);
      const contrasted = saturated.sub(pivot).mul(this.grade.contrast).add(pivot).max(0);
      const shaped = contrasted.mul(this.grade.gain).add(this.grade.lift.mul(contrasted.oneMinus().max(0)));
      const shapedLuma = dot(shaped, luma);
      const rolled = mix(shaped, vec3(shapedLuma), smoothstep(0.55, 1.4, shapedLuma).mul(this.grade.highlightDesaturation));
      const vignette = smoothstep(0.18, 0.95, uv().sub(0.5).length()).mul(this.grade.vignette).oneMinus();
      const grain = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233)).add(time.fract().mul(43758.5453))).mul(43758.5453))
        .sub(0.5).mul(this.grade.grain);
      return rolled.mul(vignette).add(grain).max(0);
    };
    const lit = beauty.rgb.mul(mix(1, this.occlusion.r, this.aoStrength)).add(this.bloom.rgb);
    this.richOutput = renderOutput(vec4(grade(lit), beauty.a));
    this.smoothedOutput = fxaa(this.richOutput);
    this.leanOutput = fxaa(renderOutput(vec4(grade(beauty.rgb), beauty.a)));
    this.setQuality(config.ui.initialQuality);
  }

  setQuality(name) {
    if (!this.post) return;
    // High/Ultra already use multisample coverage. A second FXAA pass softens
    // texture and foliage detail without providing temporal stabilization.
    this.post.outputNode = name === 'performance' ? this.leanOutput
      : name === 'balanced' || (this.settings.samples ?? 4) < 2 ? this.smoothedOutput : this.richOutput;
    this.aoStrength.value = this.settings.aoStrength * (name === 'balanced' ? 0.75 : 1);
    this.post.needsUpdate = true;
  }

  async warmup({ water, signal, nextFrame = () => new Promise(requestAnimationFrame) } = {}) {
    signal?.throwIfAborted();
    // PassNode updates once per renderer frame, including during loading.
    await nextFrame();
    signal?.throwIfAborted();
    const started = performance.now();
    const counts = withSceneWarmup(this.world.scene, () => {
      const render = () => this.render({ occlusionEnabled: false });
      if (water) water.withReflectionWarmup(render);
      else render();
    });
    const cpuMs = performance.now() - started;
    await this.world.renderer.backend?.device?.queue.onSubmittedWorkDone();
    this.warmupStats = { ...counts, cpuMs, elapsedMs: performance.now() - started };
    signal?.throwIfAborted();
    // Allow a real opening-view render to replace the empty preparation pass.
    await nextFrame();
    signal?.throwIfAborted();
  }

  #installCpuHooks() {
    if (this.cpuHooksInstalled || !this.enabled) return;
    this.cpuHooksInstalled = true;
    wrapNodeUpdateBefore(this.scenePass, this.cpu, 'scene');
    wrapNodeUpdateBefore(this.aoDepth, this.cpu, 'depthResolve');
    wrapNodeUpdateBefore(this.occlusion, this.cpu, 'gtao');
    wrapNodeUpdateBefore(this.bloom, this.cpu, 'bloom');
  }

  render({ occlusionEnabled = true, profiler } = {}) {
    this.#installCpuHooks();
    resetCpuStats(this.cpu);
    this.world.scene.userData.updateCoastalJungleVisibility?.(this.world.camera);
    const started = performance.now();
    if (occlusionEnabled) this.gpuOcclusion.prepare();
    else this.gpuOcclusion.active.clear();
    this.gpuOcclusion.lastPrepareMs = performance.now() - started;
    const drawStart = performance.now();
    this.gpuOcclusion.render(() => {
      if (this.enabled) this.post.render();
      else {
        const sceneStart = performance.now();
        this.world.renderer.render(this.world.scene, this.world.camera);
        this.cpu.scene += performance.now() - sceneStart;
      }
    });
    accountComposite(this.cpu, performance.now() - drawStart);
    applyCpuMarks(profiler, this.cpu);
  }

  dispose() {
    this.gpuOcclusion.dispose();
    this.scenePass?.dispose();
    this.aoDepth?.dispose();
    this.aoNormals?.dispose();
    this.occlusion?.dispose();
    this.bloom?.dispose();
    this.post?.dispose();
  }
}
