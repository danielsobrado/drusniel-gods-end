import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { logger } from '../utils/logger.js';
import { createTerrainIndices, createWorldSpacePositions } from './terrainColliderGeometry.js';

const CHARACTER_OFFSET = 0.01;
const SNAP_TO_GROUND = 0.2;
const MAX_SLOPE_CLIMB_DEGREES = 45;
const MIN_SLOPE_SLIDE_DEGREES = 60;
const TERRAIN_FRICTION = 1;
const PLAYER_FRICTION = 0;
const PLAYER_RESTITUTION = 0;
const IDENTITY_ROTATION = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

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

  /** Whether `collider` is one of the terrain trimeshes. */
  isTerrainCollider(collider) {
    return this.terrainColliderHandles.has(collider.handle);
  }

  #createTerrainColliders(terrain) {
    this.terrainColliderHandles ??= new Set();
    if (!terrain) return;
    terrain.updateWorldMatrix(true, true);
    let colliderCount = 0;

    terrain.traverse((object) => {
      if (!object.isMesh || !object.geometry?.attributes?.position) return;
      const vertices = createWorldSpacePositions(object);
      if (!vertices) return;
      const indices = createTerrainIndices(object.geometry);
      const colliderDescription = RAPIER.ColliderDesc.trimesh(vertices, indices);
      colliderDescription.setFriction(TERRAIN_FRICTION);

      const fixedBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const collider = this.world.createCollider(colliderDescription, fixedBody);
      this.terrainColliderHandles.add(collider.handle);
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

  // How far a sphere of `radius` travels from `from` toward `to` before it
  // touches a collider accepted by `filter` (all of them when omitted), or null
  // when the whole path is clear. The player's own capsule is excluded. The
  // camera boom uses it to stop in front of solid obstacles instead of behind.
  castSphere(from, to, radius, filter = undefined) {
    if (!this.world) return null;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (!(length > 1e-4)) return null;
    // The camera casts with two radii per frame; keep a ball for each.
    this.castBalls ??= new Map();
    this.castBall = this.castBalls.get(radius);
    if (!this.castBall) {
      if (this.castBalls.size >= 8) this.castBalls.clear();
      this.castBall = new RAPIER.Ball(radius);
      this.castBalls.set(radius, this.castBall);
    }
    const hit = this.world.castShape(
      from,
      IDENTITY_ROTATION,
      { x: dx / length, y: dy / length, z: dz / length },
      this.castBall,
      0,
      length,
      true,
      undefined,
      undefined,
      this.collider,
      this.body,
      filter,
    );
    return hit ? hit.time_of_impact : null;
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
