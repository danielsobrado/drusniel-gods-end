import { PostProcessing, FloatType, RedFormat, NearestFilter } from 'three/webgpu';
import { pass, rtt, renderOutput, vec4, vec3, uniform, mix, dot, uv, smoothstep } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { GpuOcclusion } from './GpuOcclusion.js';

export class CinematicPipeline {
  constructor(world, config) {
    this.world = world;
    this.settings = config.cinematic?.post;
    this.enabled = Boolean(config.cinematic?.enabled);
    this.gpuOcclusion = new GpuOcclusion(world, config.cinematic?.occlusion);
    if (!this.enabled) return;
    this.post = new PostProcessing(world.renderer);
    this.post.outputColorTransform = false;
    // Coverage samples stabilize moving subpixel blades; FXAA alone cannot.
    this.scenePass = pass(world.scene, world.camera, { samples: this.settings.samples ?? 4 });
    const beauty = this.scenePass.getTextureNode('output');
    // Resolve sampled depth into an R32F color texture for r180 GTAO's mip-level
    // dimension query. This is one screen quad, not a second geometry pass.
    this.aoDepth = rtt(this.scenePass.getTextureNode('depth').r, null, null, {
      type: FloatType, format: RedFormat, minFilter: NearestFilter, magFilter: NearestFilter,
    });
    // normalNode stays null: GTAO then reconstructs normals from depth via r180's
    // getNormalFromDepth(), which logs a benign "vec3() data exceeds maximum
    // length" TSL error (it passes a vec4 textureLoad where a float depth is
    // expected, then correctly truncates it to .x). Feeding it an MRT normal
    // target skips that path but renders the scene black on this backend, so the
    // upstream log is the cheaper of the two. Revisit when three fixes it.
    this.occlusion = ao(this.aoDepth, null, world.camera);
    this.occlusion.radius.value = this.settings.aoRadius;
    this.occlusion.thickness.value = 1;
    this.occlusion.resolutionScale = 0.5;
    this.aoStrength = uniform(this.settings.aoStrength);
    this.bloom = bloom(beauty, this.settings.bloomStrength, 0.3, this.settings.bloomThreshold);
    const lit = beauty.rgb.mul(mix(1, this.occlusion.r, this.aoStrength)).add(this.bloom.rgb);
    const luminance = dot(lit, vec3(0.2126, 0.7152, 0.0722));
    const graded = mix(vec3(luminance), lit, this.settings.saturation);
    const vignette = smoothstep(0.22, 0.72, uv().sub(0.5).length()).mul(this.settings.vignette).oneMinus();
    this.richOutput = fxaa(renderOutput(vec4(graded.mul(vignette), beauty.a)));
    this.leanOutput = fxaa(renderOutput(vec4(mix(vec3(dot(beauty.rgb, vec3(0.2126, 0.7152, 0.0722))), beauty.rgb, this.settings.saturation).mul(vignette), beauty.a)));
    this.setQuality(config.ui.initialQuality);
  }

  setQuality(name) {
    if (!this.post) return;
    this.post.outputNode = name === 'performance' ? this.leanOutput : this.richOutput;
    this.aoStrength.value = this.settings.aoStrength * (name === 'balanced' ? 0.75 : 1);
    this.post.needsUpdate = true;
  }

  render({ occlusionEnabled = true } = {}) {
    if (occlusionEnabled) this.gpuOcclusion.prepare();
    else this.gpuOcclusion.active.clear();
    this.gpuOcclusion.render(() => {
      if (this.enabled) this.post.render();
      else this.world.renderer.render(this.world.scene, this.world.camera);
    });
  }

  dispose() {
    this.gpuOcclusion.dispose();
    this.scenePass?.dispose();
    this.aoDepth?.dispose();
    this.occlusion?.dispose();
    this.bloom?.dispose();
    this.post?.dispose();
  }
}
