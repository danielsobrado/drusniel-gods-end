import * as THREE from 'three/webgpu';
import { color, float, smoothstep, uniform, uv } from 'three/tsl';

const DEFAULTS = Object.freeze({
  enabled: true,
  // Fractions of the character's height.
  radius: 0.26,
  fadeHeight: 0.4,
  opacity: 0.82,
  color: '#0b1018',
  // The tight occlusion right under each sole, as fractions of the height.
  foot: { radius: 0.05, fadeHeight: 0.035, opacity: 0.9 },
});
// Metres used for the terrain normal central difference, and the lift that
// keeps the blob clear of the terrain it lies on.
const NORMAL_STEP = 0.6;
const SURFACE_LIFT = 0.04;
const UP = new THREE.Vector3(0, 1, 0);
const FOOT_SIDES = ['Left', 'Right'];

function createBlob(name, settings, opacity, sharpness) {
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
  // A dark core with a soft falloff, like ambient occlusion rather than a
  // hard-edged disc.
  const falloff = smoothstep(float(0), float(1), distance.oneMinus());
  material.colorNode = color(settings.color);
  material.opacityNode = falloff.pow(sharpness).mul(opacity);
  material.fog = false;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.visible = false;
  return mesh;
}

// A soft occlusion blob under the character, lying on the terrain, plus a tight
// dark patch under each sole. The low snow-country sun throws the real shadow
// long and sideways, or loses it altogether in a shaded gorge, which leaves a
// standing character looking suspended. The body blob shrinks and fades as the
// character leaves the ground, so a jump still reads as height above it; each
// sole's patch fades as that foot lifts, so a stride plants one foot at a time.
export class ContactShadow {
  constructor({ scene, player, terrain, config }) {
    const overrides = config?.player?.contactShadow ?? {};
    this.settings = { ...DEFAULTS, ...overrides, foot: { ...DEFAULTS.foot, ...(overrides.foot ?? {}) } };
    this.player = player;
    this.terrain = terrain;
    this.normal = new THREE.Vector3();
    this.heel = new THREE.Vector3();
    this.toe = new THREE.Vector3();
    this.opacity = uniform(0);
    this.feet = [];
    if (!this.settings.enabled) return;

    this.mesh = createBlob('Player contact shadow', this.settings, this.opacity, 1.3);
    scene.add(this.mesh);
    if (this.settings.foot.opacity > 0) {
      for (const side of FOOT_SIDES) {
        const opacity = uniform(0);
        const mesh = createBlob(`Player ${side.toLowerCase()} sole shadow`, this.settings, opacity, 1.8);
        scene.add(mesh);
        this.feet.push({ side, mesh, opacity, heel: null, toe: null });
      }
    }
  }

  #alignToTerrain(mesh, x, z, yaw) {
    const step = NORMAL_STEP;
    const dx = this.terrain.sampleHeight(x + step, z) - this.terrain.sampleHeight(x - step, z);
    const dz = this.terrain.sampleHeight(x, z + step) - this.terrain.sampleHeight(x, z - step);
    this.normal.set(-dx, 2 * step, -dz).normalize();
    mesh.quaternion.setFromUnitVectors(UP, this.normal);
    mesh.rotateY(yaw);
  }

  #hide() {
    this.mesh.visible = false;
    for (const foot of this.feet) foot.mesh.visible = false;
  }

  update() {
    if (!this.mesh) return;
    const root = this.player.root;
    const height = this.player.modelHeight;
    const position = this.player.getPosition();
    const ground = this.terrain?.sampleHeight(position.x, position.z);
    if (!root?.visible || !this.player.enabled || !(height > 0) || !Number.isFinite(ground)) {
      this.#hide();
      return;
    }
    const feet = position.y - this.player.metrics.rootToFeet - this.player.metrics.groundOffset;
    const lift = THREE.MathUtils.clamp((feet - ground) / (height * this.settings.fadeHeight), 0, 1);
    const opacity = this.settings.opacity * (1 - lift) ** 2;
    this.mesh.visible = opacity > 0.005;
    if (this.mesh.visible) {
      this.opacity.value = opacity;
      this.#alignToTerrain(this.mesh, position.x, position.z, this.player.playerYaw ?? 0);
      const radius = height * this.settings.radius * (1 - lift * 0.35);
      // Wider across the shoulders than from toe to heel.
      this.mesh.scale.set(radius, 1, radius * 0.72);
      this.mesh.position.set(position.x, ground + SURFACE_LIFT, position.z);
    }
    this.#updateFeet(height);
  }

  #updateFeet(height) {
    const model = this.player.model;
    const foot = this.settings.foot;
    for (const entry of this.feet) {
      entry.heel ??= model?.getObjectByName(`${entry.side}Foot`) ?? null;
      entry.toe ??= model?.getObjectByName(`${entry.side}Toe_end`) ?? model?.getObjectByName(`${entry.side}ToeBase`) ?? null;
      if (!entry.heel || !entry.toe) {
        entry.mesh.visible = false;
        continue;
      }
      entry.heel.getWorldPosition(this.heel);
      entry.toe.getWorldPosition(this.toe);
      // The ankle joint sits above the heel; centre the patch on the sole.
      const x = (this.heel.x + this.toe.x) / 2, z = (this.heel.z + this.toe.z) / 2;
      const ground = this.terrain.sampleHeight(x, z);
      const sole = Math.min(this.toe.y, this.heel.y - height * 0.04);
      const lift = Number.isFinite(ground)
        ? THREE.MathUtils.clamp((sole - ground) / (height * foot.fadeHeight), 0, 1) : 1;
      const opacity = foot.opacity * (1 - lift) ** 2;
      entry.mesh.visible = opacity > 0.005;
      if (!entry.mesh.visible) continue;
      entry.opacity.value = opacity;
      const length = Math.hypot(this.toe.x - this.heel.x, this.toe.z - this.heel.z);
      this.#alignToTerrain(entry.mesh, x, z, Math.atan2(this.toe.x - this.heel.x, this.toe.z - this.heel.z));
      const radius = height * foot.radius * (1 + lift * 0.4);
      entry.mesh.scale.set(radius, 1, Math.max(radius, length * 0.75 + radius * 0.4));
      entry.mesh.position.set(x, ground + SURFACE_LIFT, z);
    }
  }

  dispose() {
    for (const mesh of [this.mesh, ...this.feet.map(foot => foot.mesh)]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
