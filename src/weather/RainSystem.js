import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  positionGeometry,
  time,
  uniform,
  vec3,
} from 'three/tsl';
import {
  createCinematicWindFieldNode,
  getSharedWindUniforms,
  resolveWindConfig,
} from './WindField.js';

const RAIN_VISIBILITY_THRESHOLD = 0.001;
const MIN_CAMERA_DISTANCE = 0.001;
const TWO_PI = Math.PI * 2;
const CINEMATIC_MODEL = 'cinematic';
const HASH_OFFSETS = Object.freeze({
  x: 17.13,
  z: 93.71,
  initialY: 41.27,
  speed: 71.91,
  wind: 121.43,
  turbulence: 211.17,
  length: 331.71,
  width: 441.31,
  opacity: 551.91,
});
const DEFAULT_COLOR_LINEAR = Object.freeze([0.78, 0.86, 1]);

function readRainConfig(config) {
  const rain = config.rain;
  return {
    count: rain.count,
    area: rain.area,
    top: rain.top,
    bottom: rain.bottom,
    speed: rain.speed,
    windX: rain.windX,
    windZ: rain.windZ,
    windStrength: rain.windStrength,
    windVariation: rain.windVariation,
    turbulence: rain.turbulence,
    dropLength: rain.dropLength,
    dropWidth: rain.dropWidth,
    opacity: rain.opacity,
    colorLinear: rain.colorLinear ?? DEFAULT_COLOR_LINEAR,
  };
}

export class RainSystem {
  constructor(scene, player, config) {
    this.scene = scene;
    this.player = player;
    this.config = config;
    this.windConfig = resolveWindConfig(config);
    this.params = readRainConfig(config);
    this.playerPosition = new THREE.Vector3();
    this.center = uniform(new THREE.Vector3());
    this.intensity = uniform(0);
    this.windStrength = uniform(this.params.windStrength);

    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.geometry.translate(0, -0.5, 0);

    this.mesh = new THREE.InstancedMesh(this.geometry, null, this.params.count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    // Zero-filled instance matrices would collapse every drop onto the origin;
    // the drops are placed by positionNode, so identity is all that is needed.
    const identity = new THREE.Matrix4();
    for (let index = 0; index < this.params.count; index += 1) this.mesh.setMatrixAt(index, identity);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.material = this.#createMaterial();
    this.mesh.material = this.material;
    scene.add(this.mesh);
    this.update();
  }

  #createMaterial() {
    const index = instanceIndex.toFloat();
    const randomX = hash(index.add(float(HASH_OFFSETS.x)));
    const randomZ = hash(index.add(float(HASH_OFFSETS.z)));
    const randomInitialY = hash(index.add(float(HASH_OFFSETS.initialY)));
    const randomSpeed = hash(index.add(float(HASH_OFFSETS.speed)));
    const randomWind = hash(index.add(float(HASH_OFFSETS.wind)));
    const randomTurbulence = hash(index.add(float(HASH_OFFSETS.turbulence)));
    const randomLength = hash(index.add(float(HASH_OFFSETS.length)));
    const randomWidth = hash(index.add(float(HASH_OFFSETS.width)));
    const randomOpacity = hash(index.add(float(HASH_OFFSETS.opacity)));

    const dropLength = mix(
      float(this.params.dropLength * 0.45),
      float(this.params.dropLength * 1.35),
      randomLength,
    );
    const dropWidth = mix(
      float(this.params.dropWidth * 0.55),
      float(this.params.dropWidth * 1.25),
      randomWidth,
    );
    const dropSpeed = mix(
      float(this.params.speed * 0.7),
      float(this.params.speed * 1.35),
      randomSpeed,
    );

    const range = float(this.params.top - this.params.bottom);
    const initialY = mix(float(this.params.bottom), float(this.params.top), randomInitialY);
    const y = fract(
      initialY.sub(float(this.params.bottom)).add(time.mul(dropSpeed)).div(range),
    ).mul(range).add(float(this.params.bottom));

    const wind = this.#createWindNodes();
    const windVariation = mix(
      float(1 - this.params.windVariation),
      float(1 + this.params.windVariation),
      randomWind,
    );
    const windEffect = wind.strength.mul(windVariation);
    const windTime = time.mul(windEffect);

    const x = fract(
      randomX.add(windTime.mul(wind.direction.x).div(float(this.params.area))),
    ).sub(0.5).mul(float(this.params.area));
    const z = fract(
      randomZ.add(windTime.mul(wind.direction.y).div(float(this.params.area))),
    ).sub(0.5).mul(float(this.params.area));

    const turbulencePhase = time.mul(0.7).add(randomTurbulence.mul(float(TWO_PI)));
    const turbulenceAmount = this.windConfig.model === CINEMATIC_MODEL
      ? wind.turbulence.abs().mul(this.params.turbulence)
      : float(this.params.turbulence);
    const turbulentX = turbulencePhase.sin().mul(turbulenceAmount);
    const turbulentZ = turbulencePhase.cos().mul(turbulenceAmount);
    const dropX = this.center.x.add(x).add(turbulentX);
    const dropZ = this.center.z.add(z).add(turbulentZ);

    const windTiltRatio = windEffect.div(dropSpeed);
    const toCamera = cameraPosition.sub(vec3(dropX, 0, dropZ));
    const horizontalDistance = toCamera.xz.length().max(float(MIN_CAMERA_DISTANCE));
    const cameraRight = vec3(
      toCamera.z.div(horizontalDistance),
      0,
      toCamera.x.div(horizontalDistance).negate(),
    );
    const widthOffset = positionGeometry.x.mul(dropWidth);
    const lengthOffset = positionGeometry.y.mul(dropLength);
    const windDirection = vec3(wind.direction.x, 0, wind.direction.y);
    const windTilt = positionGeometry.y.add(0.5).mul(windTiltRatio).mul(dropLength);

    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.side = THREE.FrontSide;
    material.depthWrite = false;
    material.fog = true;
    material.positionNode = vec3(
      dropX.add(cameraRight.x.mul(widthOffset)).add(windDirection.x.mul(windTilt)),
      y.add(lengthOffset),
      dropZ.add(cameraRight.z.mul(widthOffset)).add(windDirection.z.mul(windTilt)),
    );

    const localY = positionGeometry.y.add(0.5);
    const profile = localY.mul(float(1).sub(localY)).mul(4).clamp(0, 1);
    const opacityVariation = mix(float(0.5), float(1), randomOpacity);
    const alpha = profile.mul(0.1)
      .mul(opacityVariation)
      .mul(float(this.params.opacity))
      .clamp(0.05, 1);
    material.opacityNode = alpha.mul(this.intensity);
    material.colorNode = vec3(...this.params.colorLinear);
    return material;
  }

  #createWindNodes() {
    if (this.windConfig.model === CINEMATIC_MODEL) {
      const sharedWind = getSharedWindUniforms();
      return createCinematicWindFieldNode({
        positionXZ: this.center.xz,
        timeNode: time,
        directionDegrees: sharedWind.directionDegrees,
        intensity: this.windStrength,
        simulationSpeed: sharedWind.simulationSpeed,
        noiseScale: sharedWind.noiseScale,
        config: this.config,
      });
    }

    const windLength = Math.hypot(this.params.windX, this.params.windZ) || 1;
    return {
      direction: {
        x: float(this.params.windX / windLength),
        y: float(this.params.windZ / windLength),
      },
      strength: this.windStrength,
      turbulence: float(1),
    };
  }

  setIntensity(value) {
    const intensity = THREE.MathUtils.clamp(Number(value), 0, 1);
    this.intensity.value = intensity;
    this.mesh.visible = intensity > RAIN_VISIBILITY_THRESHOLD;
  }

  setWindStrength(value) {
    const strength = Number(value);
    if (!Number.isFinite(strength)) return;
    this.windStrength.value = strength;
  }

  update() {
    if (!this.player) return;
    this.player.getWorldPosition(this.playerPosition);
    this.center.value.copy(this.playerPosition);
  }

  dispose() {
    this.scene?.remove(this.mesh);
    this.geometry?.dispose?.();
    this.material?.dispose?.();
    this.player = null;
    this.scene = null;
  }
}
