import * as THREE from 'three';
import { createLeafTexture } from './leafTextures.js';
import {
  getSharedWindState,
  resolveWindConfig,
  sampleCinematicWindCpu,
} from '../weather/WindField.js';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';

const ZONES = ['yellow', 'green', 'white'];
const TWO_PI = Math.PI * 2;
const CINEMATIC_MODEL = 'cinematic';

function randomRange(min, max) {
  return THREE.MathUtils.lerp(min, max, Math.random());
}


export class LeafSystem {
  constructor({ scene, player, zoneIndex, config, renderer = null }) {
    this.scene = scene;
    this.renderer = renderer;
    this.player = player;
    this.zoneIndex = zoneIndex;
    this.config = config;
    this.leafConfig = config.leaves;
    this.windConfig = resolveWindConfig(config);
    this.currentZone = null;
    this.zoneTransition = false;
    this.spawnTimer = 0;
    this.spawnIndex = 0;
    this.windStrength = this.leafConfig.windStrength;
    this.simulationSpeed = this.leafConfig.simulationSpeed;
    this.windTime = 0;
    this.playerPosition = new THREE.Vector3();
    this.matrix = new THREE.Matrix4();
    this.quaternion = new THREE.Quaternion();
    this.scale = new THREE.Vector3();
    this.euler = new THREE.Euler();
    this.hiddenPosition = new THREE.Vector3(0, this.leafConfig.hiddenY, 0);
    this.hiddenScale = new THREE.Vector3(0, 0, 0);
    this.leaves = [];
    this.textures = new Map();
    this.renderEnabled = true;

    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      transparent: true,
      alphaTest: this.leafConfig.material.alphaTest,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.mesh = adoptInstanceMatrices(new THREE.InstancedMesh(this.geometry, this.material, this.leafConfig.count));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = this.leafConfig.material.renderOrder;
    this.scene.add(this.mesh);

    this.#createTextures();
    // Bound from the start so the loading warmup compiles the textured shader;
    // zone changes then only swap textures (see #setZoneTexture).
    this.material.map = this.textures.values().next().value ?? null;
    this.#createLeaves();
  }

  // The zone sprites are painted here (leafTextures.js), not downloaded, and
  // uploaded at once: uploaded on first use, a zone change stalled that frame.
  #createTextures() {
    for (const zone of ZONES) {
      const texture = createLeafTexture(zone);
      if (!texture) continue;
      this.renderer?.initTexture?.(texture);
      this.textures.set(zone, texture);
    }
  }

  #createLeaves() {
    for (let index = 0; index < this.leafConfig.count; index += 1) {
      const leaf = {
        index,
        active: false,
        fadingOut: false,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        rotation: new THREE.Vector3(),
        rotationSpeed: new THREE.Vector3(),
        phase: 0,
        phase2: 0,
        speed: 0,
        drift: 0,
        driftSpeed: 0,
        float: 0,
        floatSpeed: 0,
        size: 0,
        currentSize: 0,
        fade: 1,
        time: Math.random() * this.leafConfig.initialTimeMax,
      };
      this.#randomizeLeaf(leaf);
      this.leaves.push(leaf);
      this.#hideLeaf(leaf);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  #randomizeLeaf(leaf) {
    const direction = Math.random() * TWO_PI;
    leaf.velocity.set(Math.cos(direction), -this.leafConfig.gravity, Math.sin(direction));
    leaf.speed = randomRange(this.leafConfig.minSpeed, this.leafConfig.maxSpeed);
    leaf.drift = randomRange(this.leafConfig.drift.min, this.leafConfig.drift.max);
    leaf.driftSpeed = randomRange(this.leafConfig.drift.speedMin, this.leafConfig.drift.speedMax);
    leaf.float = randomRange(this.leafConfig.float.min, this.leafConfig.float.max);
    leaf.floatSpeed = randomRange(this.leafConfig.float.speedMin, this.leafConfig.float.speedMax);
    leaf.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    leaf.rotationSpeed.set(
      randomRange(this.leafConfig.rotationSpeed.min, this.leafConfig.rotationSpeed.max),
      randomRange(this.leafConfig.rotationSpeed.min, this.leafConfig.rotationSpeed.max),
      randomRange(this.leafConfig.rotationSpeed.min, this.leafConfig.rotationSpeed.max),
    );
    leaf.phase = Math.random() * TWO_PI;
    leaf.phase2 = Math.random() * TWO_PI;
    leaf.size = randomRange(this.leafConfig.minSize, this.leafConfig.maxSize);
    leaf.currentSize = leaf.size;
    leaf.fade = 1;
    leaf.time = Math.random() * this.leafConfig.initialTimeMax;
  }

  #setRandomSpawnPosition(leaf) {
    const angle = Math.random() * TWO_PI;
    const radius = Math.sqrt(Math.random()) * this.leafConfig.spawnRadius;
    leaf.position.set(
      this.playerPosition.x + Math.cos(angle) * radius,
      this.playerPosition.y + randomRange(this.leafConfig.minHeight, this.leafConfig.maxHeight),
      this.playerPosition.z + Math.sin(angle) * radius,
    );
  }

  #respawnLeaf(leaf) {
    if (!this.currentZone) {
      leaf.fadingOut = true;
      return;
    }
    this.#setRandomSpawnPosition(leaf);
    this.#randomizeLeaf(leaf);
    leaf.active = true;
    leaf.fadingOut = false;
    leaf.currentSize = 0;
    leaf.fade = 0;
  }

  #activateNextLeaf() {
    const count = this.leaves.length;
    if (count === 0) return false;

    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.spawnIndex + offset) % count;
      const leaf = this.leaves[index];
      if (leaf.active) continue;
      this.spawnIndex = (index + 1) % count;
      this.#respawnLeaf(leaf);
      return true;
    }
    return false;
  }

  #hasActiveLeaves() {
    return this.leaves.some((leaf) => leaf.active);
  }

  // Adding or removing the map changes the shader, and flagging the material
  // rebuilds it: walking in and out of leaf zones near the village recompiled
  // it 28 times in 12 s. Outside a zone no leaf spawns, so the last texture
  // stays bound; swapping one texture for another needs no rebuild.
  #setZoneTexture(zone) {
    const next = zone ? (this.textures.get(zone) ?? null) : this.material.map;
    if (next === this.material.map) return;
    const presenceChanged = !next !== !this.material.map;
    this.material.map = next;
    if (presenceChanged) this.material.needsUpdate = true;
  }

  #updateZone() {
    const nextZone = this.zoneIndex?.getZone(this.playerPosition) ?? null;
    if (nextZone === this.currentZone) return;

    if (this.currentZone === null && nextZone !== null && this.material.map === null) {
      this.currentZone = nextZone;
      this.#setZoneTexture(nextZone);
      this.zoneTransition = false;
      this.spawnTimer = 0;
      this.spawnIndex = 0;
      return;
    }

    this.currentZone = nextZone;
    this.zoneTransition = true;
    this.spawnTimer = 0;
    this.spawnIndex = 0;
    for (const leaf of this.leaves) {
      if (leaf.active) leaf.fadingOut = true;
    }
  }

  #spawnNewLeaves(deltaSeconds) {
    if (this.zoneTransition) {
      if (this.#hasActiveLeaves()) return;
      this.#setZoneTexture(this.currentZone);
      this.zoneTransition = false;
      this.spawnTimer = 0;
      this.spawnIndex = 0;
    }
    if (!this.currentZone) return;

    this.spawnTimer += deltaSeconds;
    const interval = this.leafConfig.spawnInterval;
    while (this.spawnTimer >= interval) {
      this.spawnTimer -= interval;
      if (!this.#activateNextLeaf()) {
        this.spawnTimer = 0;
        break;
      }
    }
  }

  #hideLeaf(leaf) {
    this.quaternion.identity();
    this.matrix.compose(this.hiddenPosition, this.quaternion, this.hiddenScale);
    this.mesh.setMatrixAt(leaf.index, this.matrix);
  }

  #updateFade(leaf, deltaSeconds) {
    if (leaf.fadingOut) {
      leaf.fade = Math.max(0, leaf.fade - this.leafConfig.fadeSpeed * deltaSeconds);
      if (leaf.fade <= 0) {
        leaf.active = false;
        leaf.fadingOut = false;
        leaf.currentSize = 0;
        this.#hideLeaf(leaf);
        return false;
      }
    } else {
      leaf.fade = Math.min(1, leaf.fade + this.leafConfig.fadeSpeed * deltaSeconds);
    }
    leaf.currentSize = leaf.size * leaf.fade;
    return true;
  }

  #updateLeafMatrix(leaf) {
    this.euler.set(leaf.rotation.x, leaf.rotation.y, leaf.rotation.z);
    this.quaternion.setFromEuler(this.euler);
    this.scale.setScalar(leaf.currentSize);
    this.matrix.compose(leaf.position, this.quaternion, this.scale);
    this.mesh.setMatrixAt(leaf.index, this.matrix);
  }

  #sampleCinematicWind() {
    if (this.windConfig.model !== CINEMATIC_MODEL) return null;
    const shared = getSharedWindState();
    return sampleCinematicWindCpu({
      x: this.playerPosition.x,
      z: this.playerPosition.z,
      time: this.windTime,
      directionDegrees: shared.directionDegrees,
      intensity: this.windStrength,
      simulationSpeed: this.simulationSpeed,
      noiseScale: shared.noiseScale,
      config: this.config,
    });
  }

  setRenderEnabled(enabled) {
    this.renderEnabled = Boolean(enabled);
    this.mesh.visible = this.renderEnabled;
  }

  setWindStrength(value) {
    this.windStrength = Number(value);
  }

  setSimulationSpeed(value) {
    this.simulationSpeed = Number(value);
  }

  update(deltaSeconds) {
    if (!this.renderEnabled) return;
    this.playerPosition.copy(this.player.getPosition());
    this.windTime += deltaSeconds;
    const scaledDelta = deltaSeconds * this.simulationSpeed;
    this.#updateZone();
    this.#spawnNewLeaves(scaledDelta);

    const minY = this.playerPosition.y + this.leafConfig.minHeight;
    const maxY = this.playerPosition.y + this.leafConfig.maxHeight;
    const despawnRadiusSq = this.leafConfig.despawnRadius ** 2;
    const windCap = Math.min(this.windStrength, this.leafConfig.turbulence.windCap);
    const cinematicWind = this.#sampleCinematicWind();
    const cinematicResponse = this.windConfig.response.leaves;
    const cinematicPerpendicular = cinematicWind
      ? { x: -cinematicWind.direction.z, z: cinematicWind.direction.x }
      : null;

    // Every active leaf writes its instance matrix below (move, respawn or
    // hide), so the upload is only needed when at least one leaf was active.
    let wrote = false;
    for (const leaf of this.leaves) {
      if (!leaf.active) continue;
      wrote = true;
      leaf.time += scaledDelta;

      const driftX = Math.sin(leaf.time * leaf.driftSpeed + leaf.phase) * leaf.drift;
      const driftZ = Math.cos(
        leaf.time * leaf.driftSpeed * this.leafConfig.drift.zFrequencyScale + leaf.phase2,
      ) * leaf.drift;
      const noiseX = Math.sin(
        leaf.time * this.leafConfig.turbulence.xFrequency + leaf.phase2,
      ) * this.leafConfig.turbulence.amplitude;
      const noiseZ = Math.cos(
        leaf.time * this.leafConfig.turbulence.zFrequency + leaf.phase,
      ) * this.leafConfig.turbulence.amplitude;

      let windX = leaf.velocity.x * leaf.speed * this.windStrength;
      let windZ = leaf.velocity.z * leaf.speed * this.windStrength;
      if (cinematicWind) {
        const turbulence = cinematicWind.turbulence
          * this.windStrength
          * cinematicResponse.turbulence;
        windX = cinematicWind.direction.x
          * cinematicWind.strength
          * cinematicResponse.advection
          + cinematicPerpendicular.x * turbulence;
        windZ = cinematicWind.direction.z
          * cinematicWind.strength
          * cinematicResponse.advection
          + cinematicPerpendicular.z * turbulence;
      }

      leaf.position.x += (windX + driftX * windCap + noiseX * windCap) * scaledDelta;
      leaf.position.z += (windZ + driftZ * windCap + noiseZ * windCap) * scaledDelta;
      const verticalFloat = Math.sin(leaf.time * leaf.floatSpeed + leaf.phase) * leaf.float;
      leaf.position.y += verticalFloat * scaledDelta - this.leafConfig.gravity * scaledDelta;
      leaf.rotation.addScaledVector(leaf.rotationSpeed, scaledDelta);

      const dx = leaf.position.x - this.playerPosition.x;
      const dz = leaf.position.z - this.playerPosition.z;
      const outside = dx * dx + dz * dz > despawnRadiusSq
        || leaf.position.y < minY
        || leaf.position.y > maxY;
      if (outside) {
        if (this.currentZone && !this.zoneTransition) this.#respawnLeaf(leaf);
        else leaf.fadingOut = true;
      }

      if (!this.#updateFade(leaf, scaledDelta)) continue;
      this.#updateLeafMatrix(leaf);
    }

    if (wrote) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.leaves.length = 0;
  }
}
