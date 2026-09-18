import * as THREE from 'three/webgpu';
import { color, float, smoothstep, uniform, uv } from 'three/tsl';

const DEFAULTS = Object.freeze({
  enabled: true,
  // Fractions of the character's height.
  radius: 0.26,
  fadeHeight: 0.4,
  opacity: 0.82,
  color: '#0b1018',
});
// Metres used for the terrain normal central difference, and the lift that
// keeps the blob clear of the terrain it lies on.
const NORMAL_STEP = 0.6;
const SURFACE_LIFT = 0.04;
const UP = new THREE.Vector3(0, 1, 0);

// A soft occlusion blob under the character's feet, lying on the terrain. The
// low snow-country sun throws the real shadow long and sideways, or loses it
// altogether in a shaded gorge, which leaves a standing character looking
// suspended. The blob shrinks and fades as the feet leave the ground, so a
// jump still reads as height above it.
export class ContactShadow {
  constructor({ scene, player, terrain, config }) {
    this.settings = { ...DEFAULTS, ...(config?.player?.contactShadow ?? {}) };
    this.player = player;
    this.terrain = terrain;
    this.normal = new THREE.Vector3();
    this.opacity = uniform(0);
    if (!this.settings.enabled) return;

    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const distance = uv().sub(0.5).length().mul(2);
    // A dark core under the soles with a long soft falloff, like ambient
    // occlusion rather than a hard-edged disc.
    const falloff = smoothstep(float(0), float(1), distance.oneMinus());
    material.colorNode = color(this.settings.color);
    material.opacityNode = falloff.pow(1.3).mul(this.opacity);
    material.fog = false;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'Player contact shadow';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  update() {
    if (!this.mesh) return;
    const root = this.player.root;
    const height = this.player.modelHeight;
    const position = this.player.getPosition();
    const ground = this.terrain?.sampleHeight(position.x, position.z);
    if (!root?.visible || !this.player.enabled || !(height > 0) || !Number.isFinite(ground)) {
      this.mesh.visible = false;
      return;
    }
    const feet = position.y - this.player.metrics.rootToFeet - this.player.metrics.groundOffset;
    const lift = THREE.MathUtils.clamp((feet - ground) / (height * this.settings.fadeHeight), 0, 1);
    const opacity = this.settings.opacity * (1 - lift) ** 2;
    this.mesh.visible = opacity > 0.005;
    if (!this.mesh.visible) return;
    this.opacity.value = opacity;

    const step = NORMAL_STEP;
    const dx = this.terrain.sampleHeight(position.x + step, position.z) - this.terrain.sampleHeight(position.x - step, position.z);
    const dz = this.terrain.sampleHeight(position.x, position.z + step) - this.terrain.sampleHeight(position.x, position.z - step);
    this.normal.set(-dx, 2 * step, -dz).normalize();
    this.mesh.quaternion.setFromUnitVectors(UP, this.normal);
    this.mesh.rotateY(this.player.playerYaw ?? 0);
    const radius = height * this.settings.radius * (1 - lift * 0.35);
    // Wider across the shoulders than from toe to heel.
    this.mesh.scale.set(radius, 1, radius * 0.72);
    this.mesh.position.set(position.x, ground + SURFACE_LIFT, position.z);
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
