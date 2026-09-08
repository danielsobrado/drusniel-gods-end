import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const DEFAULT_ACTIVE_DISTANCE = 50;
const DEFAULT_INACTIVE_DISTANCE = 70;
const DEFAULT_RADIUS = 0;
const COLLIDER_FRICTION = 1;
const HALF = 0.5;

function meshesWithPositions(root) {
  const meshes = [];
  root?.traverse((object) => {
    if (object.isMesh && object.geometry?.attributes?.position) meshes.push(object);
  });
  return meshes;
}

function horizontalRadius(root, center) {
  const bounds = new THREE.Box3();
  root?.traverse((object) => {
    if (object.isMesh && object.geometry?.attributes?.position) bounds.expandByObject(object);
  });
  if (bounds.isEmpty()) return DEFAULT_RADIUS;

  const radiusX = Math.max(
    Math.abs(bounds.min.x - center.x),
    Math.abs(bounds.max.x - center.x),
  );
  const radiusZ = Math.max(
    Math.abs(bounds.min.z - center.z),
    Math.abs(bounds.max.z - center.z),
  );
  return Math.sqrt(radiusX * radiusX + radiusZ * radiusZ);
}

export class WorldCollisionSystem {
  constructor({ physics, player, scene, config = {} }) {
    this.world = physics?.world ?? null;
    this.player = player ?? null;
    this.scene = scene ?? null;
    this.activeDistance = Number(config.activeDistance ?? DEFAULT_ACTIVE_DISTANCE);
    this.inactiveDistance = Number(config.inactiveDistance ?? DEFAULT_INACTIVE_DISTANCE);
    this.colliders = [];
    this.playerPosition = new THREE.Vector3();
  }

  #register({ body, collider, position, radius = DEFAULT_RADIUS }) {
    if (!body || !collider) return null;
    const entry = {
      body,
      collider,
      position: position.clone(),
      radius,
      active: true,
    };
    this.colliders.push(entry);
    return entry;
  }

  addBox(position, size) {
    if (!this.world) return null;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z),
    );
    const colliderDescription = RAPIER.ColliderDesc.cuboid(
      size.x * HALF,
      size.y * HALF,
      size.z * HALF,
    );
    const collider = this.world.createCollider(colliderDescription, body);
    const radius = Math.sqrt((size.x * HALF) ** 2 + (size.z * HALF) ** 2);
    this.#register({ body, collider, position, radius });
    return body;
  }

  addConvexHullFromObject(root) {
    if (!this.world || !root) return null;
    root.updateWorldMatrix(true, true);
    const meshes = meshesWithPositions(root);
    if (meshes.length === 0) return null;

    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    root.matrixWorld.decompose(position, rotation, scale);

    const unscaledRoot = new THREE.Matrix4().compose(
      position,
      rotation,
      new THREE.Vector3(1, 1, 1),
    );
    const inverseRoot = unscaledRoot.clone().invert();
    const transform = new THREE.Matrix4();
    const vertex = new THREE.Vector3();
    const points = [];

    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      transform.multiplyMatrices(inverseRoot, mesh.matrixWorld);
      const positions = mesh.geometry.attributes.position;
      for (let index = 0; index < positions.count; index += 1) {
        vertex.fromBufferAttribute(positions, index).applyMatrix4(transform);
        points.push(vertex.x, vertex.y, vertex.z);
      }
    }

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(position.x, position.y, position.z)
        .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }),
    );
    const colliderDescription = RAPIER.ColliderDesc.convexHull(new Float32Array(points));
    if (!colliderDescription) {
      this.world.removeRigidBody(body);
      return null;
    }
    colliderDescription.setFriction(COLLIDER_FRICTION);
    const collider = this.world.createCollider(colliderDescription, body);
    this.#register({
      body,
      collider,
      position,
      radius: horizontalRadius(root, position),
    });
    return body;
  }

  addTrimeshFromObject(root) {
    if (!this.world || !root) return null;
    root.updateWorldMatrix(true, true);

    const vertices = [];
    const indices = [];
    const transform = new THREE.Matrix4();
    const vertex = new THREE.Vector3();
    let vertexOffset = 0;

    root.traverse((object) => {
      if (!object.isMesh || !object.geometry?.attributes?.position) return;
      object.updateWorldMatrix(true, false);
      transform.copy(object.matrixWorld);
      const geometry = object.geometry;
      const positions = geometry.attributes.position;

      for (let index = 0; index < positions.count; index += 1) {
        vertex.fromBufferAttribute(positions, index).applyMatrix4(transform);
        vertices.push(vertex.x, vertex.y, vertex.z);
      }

      if (geometry.index) {
        for (let index = 0; index < geometry.index.count; index += 1) {
          indices.push(geometry.index.getX(index) + vertexOffset);
        }
      } else {
        for (let index = 0; index < positions.count; index += 3) {
          indices.push(vertexOffset + index, vertexOffset + index + 1, vertexOffset + index + 2);
        }
      }
      vertexOffset += positions.count;
    });

    if (vertices.length === 0 || indices.length === 0) return null;

    const position = root.getWorldPosition(new THREE.Vector3());
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const colliderDescription = RAPIER.ColliderDesc.trimesh(
      new Float32Array(vertices),
      new Uint32Array(indices),
    );
    colliderDescription.setFriction(COLLIDER_FRICTION);
    const collider = this.world.createCollider(colliderDescription, body);
    this.#register({
      body,
      collider,
      position,
      radius: horizontalRadius(root, position),
    });
    return body;
  }

  update() {
    if (!this.player) return;
    this.player.getWorldPosition(this.playerPosition);

    for (const entry of this.colliders) {
      const dx = this.playerPosition.x - entry.position.x;
      const dz = this.playerPosition.z - entry.position.z;
      const distanceSq = dx * dx + dz * dz;
      const activeRadius = this.activeDistance + entry.radius;
      const inactiveRadius = this.inactiveDistance + entry.radius;

      if (entry.active && distanceSq > inactiveRadius * inactiveRadius) {
        entry.collider.setEnabled(false);
        entry.active = false;
        continue;
      }
      if (!entry.active && distanceSq < activeRadius * activeRadius) {
        entry.collider.setEnabled(true);
        entry.active = true;
      }
    }
  }

  dispose() {
    if (this.world) {
      for (const entry of this.colliders) this.world.removeRigidBody(entry.body);
    }
    this.colliders.length = 0;
    this.world = null;
    this.player = null;
    this.scene = null;
  }
}
