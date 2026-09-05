import { PostProcessing } from 'three/webgpu';
import { pass, vec4, vec3, uniform, mix, dot, uv, smoothstep } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

export class CinematicPipeline {
  constructor(world, config) {
    this.world = world;
    this.settings = config.cinematic?.post;
    this.enabled = Boolean(config.cinematic?.enabled);
    if (!this.enabled) return;
    this.post = new PostProcessing(world.renderer);
    this.scenePass = pass(world.scene, world.camera);
    const beauty = this.scenePass.getTextureNode('output');
    this.occlusion = ao(this.scenePass.getTextureNode('depth'), null, world.camera);
    this.occlusion.radius.value = this.settings.aoRadius;
    this.occlusion.thickness.value = 1;
    this.occlusion.resolutionScale = 0.5;
    this.aoStrength = uniform(this.settings.aoStrength);
    this.bloom = bloom(beauty, this.settings.bloomStrength, 0.3, this.settings.bloomThreshold);
    const lit = beauty.rgb.mul(mix(1, this.occlusion.r, this.aoStrength)).add(this.bloom.rgb);
    const luminance = dot(lit, vec3(0.2126, 0.7152, 0.0722));
    const graded = mix(vec3(luminance), lit, this.settings.saturation);
    const vignette = smoothstep(0.22, 0.72, uv().sub(0.5).length()).mul(this.settings.vignette).oneMinus();
    this.richOutput = fxaa(vec4(graded.mul(vignette), beauty.a));
    this.leanOutput = fxaa(vec4(mix(vec3(dot(beauty.rgb, vec3(0.2126, 0.7152, 0.0722))), beauty.rgb, this.settings.saturation).mul(vignette), beauty.a));
    this.setQuality(config.ui.initialQuality);
  }

  setQuality(name) {
    if (!this.post) return;
    this.post.outputNode = name === 'performance' ? this.leanOutput : this.richOutput;
    this.aoStrength.value = this.settings.aoStrength * (name === 'balanced' ? 0.75 : 1);
    this.post.needsUpdate = true;
  }

  render() {
    if (this.enabled) this.post.render();
    else this.world.renderer.render(this.world.scene, this.world.camera);
  }

  dispose() {
    this.scenePass?.dispose();
    this.occlusion?.dispose();
    this.bloom?.dispose();
    this.post?.dispose();
  }
}
