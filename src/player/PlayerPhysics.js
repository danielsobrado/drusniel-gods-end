import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { logger } from '../utils/logger.js';

const CHARACTER_OFFSET = 0.01;
const SNAP_TO_GROUND = 0.2;
const MAX_SLOPE_CLIMB_DEGREES = 45;
const MIN_SLOPE_SLIDE_DEGREES = 60;
const TERRAIN_FRICTION = 1;
const PLAYER_FRICTION = 0;
const PLAYER_RESTITUTION = 0;

function createSequentialIndices(vertexCount) {
  const indices = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) indices[index] = index;
  return indices;
}

export class PlayerPhysics {
  static async create({ terrain, cameraPosition, config, capsule }) {
    await RAPIER.init();
    return new PlayerPhysics({ terrain, cameraPosition, config, capsule });
  }

  // `capsule` carries the collider dimensions the controller derived from the actual
  // scaled character model; without it the authored config values are used as-is.
  constructor({ terrain, cameraPosition, config, capsule }) {
    this.config = config;
    this.eyeHeight = capsule?.eyeHeight ?? config.player.eyeHeight ?? 0.5;
    this.world = new RAPIER.World({ x: 0, y: config.player.gravity ?? -25, z: 0 });
    this.characterController = this.world.createCharacterController(CHARACTER_OFFSET);
    this.characterController.enableSnapToGround(SNAP_TO_GROUND);
    this.characterController.setMaxSlopeClimbAngle(MAX_SLOPE_CLIMB_DEGREES * Math.PI / 180);
    this.characterController.setMinSlopeSlideAngle(MIN_SLOPE_SLIDE_DEGREES * Math.PI / 180);

    const bodyDescription = RAPIER.RigidBodyDesc.kinematicPositionBased();
    bodyDescription.setTranslation(
      cameraPosition.x,
      cameraPosition.y - this.eyeHeight,
      cameraPosition.z,
    );
    this.body = this.world.createRigidBody(bodyDescription);

    const colliderDescription = RAPIER.ColliderDesc.capsule(
      capsule?.halfHeight ?? config.player.capsuleHalfHeight,
      capsule?.radius ?? config.player.capsuleRadius,
    );
    colliderDescription.setFriction(PLAYER_FRICTION);
    colliderDescription.setRestitution(PLAYER_RESTITUTION);
    this.collider = this.world.createCollider(colliderDescription, this.body);
    this.#createTerrainColliders(terrain);
  }

  #createTerrainColliders(terrain) {
    if (!terrain) return;
    terrain.updateWorldMatrix(true, true);
    let colliderCount = 0;

    terrain.traverse((object) => {
      if (!object.isMesh) return;
      const positionAttribute = object.geometry?.attributes?.position;
      if (!positionAttribute?.array) return;

      const vertices = positionAttribute.array;
      const indices = object.geometry.index?.array
        ?? createSequentialIndices(vertices.length / 3);
      const colliderDescription = RAPIER.ColliderDesc.trimesh(vertices, indices);
      colliderDescription.setFriction(TERRAIN_FRICTION);

      const bodyDescription = RAPIER.RigidBodyDesc.fixed();
      const fixedBody = this.world.createRigidBody(bodyDescription);
      const worldPosition = object.getWorldPosition(new THREE.Vector3());
      const worldRotation = object.getWorldQuaternion(new THREE.Quaternion());
      fixedBody.setTranslation(worldPosition, false);
      fixedBody.setRotation(worldRotation, false);
      this.world.createCollider(colliderDescription, fixedBody);
      colliderCount += 1;
    });

    logger.info('Rapier terrain colliders created.', { colliderCount });
  }

  move(movement) {
    this.characterController.computeColliderMovement(this.collider, movement);
    const computed = this.characterController.computedMovement();
    const current = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: current.x + computed.x,
      y: current.y + computed.y,
      z: current.z + computed.z,
    });
    this.world.step();
    return {
      grounded: this.characterController.computedGrounded(),
      movement: computed,
      position: this.body.translation(),
    };
  }

  setPosition(x, y, z) {
    this.body.setTranslation({ x, y: y - this.eyeHeight, z }, true);
  }

  getVisualPosition(target = new THREE.Vector3()) {
    const position = this.body.translation();
    return target.set(position.x, position.y + this.eyeHeight, position.z);
  }

  getBodyPosition() {
    return this.body.translation();
  }

  dispose() {
    // Rapier's World, bodies and colliders live in WASM linear memory, which
    // JavaScript garbage collection cannot reclaim. Freeing the world releases
    // every body and collider it owns.
    this.world?.free?.();
    this.world = null;
    this.body = null;
    this.collider = null;
    this.characterController = null;
  }
}
