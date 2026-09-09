import * as THREE from 'three';

export class ScenicTour {
  constructor(world, player, trees, water) {
    this.world = world;
    this.player = player;
    this.trees = trees;
    this.water = water;
    this.active = false;
    this.elapsed = 0;
    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
  }

  start() {
    if (this.active) { this.stop(); return false; }
    this.saved = { position: this.world.camera.position.clone(), quaternion: this.world.camera.quaternion.clone() };
    const start = this.player.getPosition().clone();
    const terrain = this.world.terrainSampler;
    if (this.world.expansion?.river) {
      const river = this.world.expansion.river;
      const reach = fraction => river.samples[Math.round((river.samples.length - 1) * fraction)];
      const riverView = (fraction, offset, lift) => {
        const p = reach(fraction);
        const x = p.x - p.dz * offset, z = p.z + p.dx * offset;
        return new THREE.Vector3(x, Math.max(p.y, terrain.sampleHeight(x, z)) + lift, z);
      };
      const points = [
        start.clone().setY(terrain.sampleHeight(start.x, start.z) + 12),
        new THREE.Vector3(-170, terrain.sampleHeight(-170, 35) + 30, 35),
        riverView(0.12, 55, 55), riverView(0.42, 28, 28),
        riverView(0.72, -20, 16), riverView(0.9, 18, 12),
        new THREE.Vector3(135, 5, 118),
      ];
      if (this.water.params.sea?.enabled) points.push(
        new THREE.Vector3(580, terrain.sampleHeight(580, 170) + 35, 170),
        new THREE.Vector3(950, terrain.sampleHeight(950, 80) + 20, 80),
        new THREE.Vector3(1060, 0, 65),
      );
      this.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
      this.elapsed = 0; this.active = true; this.player.setEnabled(false);
      this.player.root.visible = false; document.exitPointerLock?.();
      return true;
    }
    const grove = (this.trees.trees ?? []).filter(tree => {
      const distance = tree.position.distanceTo(start);
      return distance > 18 && distance < 85;
    }).sort((a, b) => a.position.distanceToSquared(start) - b.position.distanceToSquared(start))[0]?.position.clone()
      ?? start.clone().add(new THREE.Vector3(30, 0, -25));
    let shore = null;
    let score = Infinity;
    const bounds = this.water.bounds;
    for (let x = bounds.min.x; x <= bounds.max.x; x += 8) {
      for (let z = bounds.min.z; z <= bounds.max.z; z += 8) {
        if (!terrain.contains(x, z, 5)) continue;
        const y = terrain.sampleHeight(x, z);
        const height = y - this.water.mesh.position.y;
        if (height < 0.3 || height > 5) continue;
        const distance = Math.hypot(x - start.x, z - start.z);
        if (distance < score) { shore = new THREE.Vector3(x, y, z); score = distance; }
      }
    }
    shore ??= grove.clone().add(new THREE.Vector3(30, 0, 35));
    const points = [start, start.clone().lerp(grove, 0.5), grove, grove.clone().lerp(shore, 0.5), shore];
    for (const point of points) point.y = terrain.sampleHeight(point.x, point.z) + 7;
    this.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    this.elapsed = 0;
    this.active = true;
    this.player.setEnabled(false);
    this.player.root.visible = false;
    document.exitPointerLock?.();
    return true;
  }

  update(delta) {
    if (!this.active) return;
    this.elapsed += delta;
    const t = Math.min(this.elapsed / 30, 1);
    this.curve.getPoint(t, this.position);
    this.curve.getPoint(Math.min(t + 0.045, 1), this.target);
    this.position.y = Math.max(this.position.y, this.world.terrainSampler.sampleHeight(this.position.x, this.position.z) + 4);
    if (t > 0.94 && this.water.params?.sea?.enabled) this.target.set(1500, this.water.params.sea.level + 2, 65);
    else if (t > 0.94) this.target.copy(this.water.mesh.position).setY(this.water.mesh.position.y + 2);
    else this.target.y -= 2;
    this.world.camera.position.copy(this.position);
    this.world.camera.lookAt(this.target);
    if (t >= 1) this.stop();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.player.root.visible = true;
    this.player.setEnabled(true);
    this.world.camera.position.copy(this.saved.position);
    this.world.camera.quaternion.copy(this.saved.quaternion);
  }
}
