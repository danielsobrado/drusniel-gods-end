import { logger } from '../utils/logger.js';
import { FreeFlyController } from './FreeFlyController.js';

function validateLocations(locations) {
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error('navigation.locations must contain at least one destination.');
  }
  const ids = new Set();
  for (const location of locations) {
    if (!location?.id || !location?.label) throw new Error('Every navigation location requires id and label.');
    if (ids.has(location.id)) throw new Error(`Duplicate navigation location id: ${location.id}`);
    ids.add(location.id);
    if (!['ground', 'fly'].includes(location.mode)) {
      throw new Error(`navigation location ${location.id} has unsupported mode: ${location.mode}`);
    }
    const expectedLength = location.mode === 'fly' ? 3 : 2;
    if (!Array.isArray(location.position) || location.position.length !== expectedLength
      || location.position.some((value) => !Number.isFinite(Number(value)))) {
      throw new Error(`navigation location ${location.id} has an invalid position.`);
    }
    if (location.target && (!Array.isArray(location.target) || location.target.length !== 3
      || location.target.some((value) => !Number.isFinite(Number(value))))) {
      throw new Error(`navigation location ${location.id} has an invalid target.`);
    }
  }
  return locations;
}

export class WorldNavigation {
  constructor({ world, player, tour, config }) {
    this.world = world;
    this.player = player;
    this.tour = tour;
    this.tour.configure?.(config.navigation?.scenicTour);
    this.locations = validateLocations(config.navigation?.locations);
    this.locationById = new Map(this.locations.map((location) => [location.id, location]));
    this.freeFly = new FreeFlyController({
      camera: world.camera,
      player,
      domElement: world.renderer.domElement,
      config: config.navigation?.freeFly,
      onBeforeActivate: () => this.tour.stop(),
      onChange: (active) => logger.info(`Free-fly mode ${active ? 'enabled' : 'disabled'}.`),
    });
  }

  getLocationOptions() {
    return this.locations.map(({ id, label }) => ({ value: id, label }));
  }

  teleport(id) {
    const location = this.locationById.get(id);
    if (!location) {
      logger.warn(`Unknown navigation location: ${id}`);
      return false;
    }

    this.tour.stop();
    if (location.mode === 'fly') {
      if (!this.freeFly.active) this.freeFly.start();
      this.freeFly.teleport(location.position, location.target);
      logger.info(`Teleported free-fly camera to ${location.label}.`);
      return true;
    }

    this.freeFly.stop();
    return this.#teleportPlayer(location);
  }

  toggleFreeFly() {
    if (!this.freeFly.active) this.tour.stop();
    return this.freeFly.toggle();
  }

  startTour() {
    if (this.tour.active) {
      this.tour.stop();
      return false;
    }
    this.freeFly.stop();
    return this.tour.start();
  }

  stopTour() {
    this.tour.stop();
  }

  update(deltaSeconds) {
    this.freeFly.update(deltaSeconds);
    const walking = !this.freeFly.active && !this.tour.active
      && this.player.enabled && this.player.moving && this.player.grounded;
    const playerPosition = this.player.getPosition();
    const influencePoints = walking ? this.player.getInfluencePoints() : [];
    this.world.snowDeformation?.update(
      deltaSeconds,
      playerPosition,
      influencePoints,
      walking,
    );
    this.world.snowPowder?.update(
      deltaSeconds,
      playerPosition,
      influencePoints,
      walking,
      this.player.running,
    );
  }

  getFocusPosition() {
    return this.tour.active || this.freeFly.active
      ? this.world.camera.position
      : this.player.getPosition();
  }

  captureState() {
    return { freeFly: this.freeFly.captureState() };
  }

  restoreState(state) {
    return this.freeFly.restoreState(state?.freeFly);
  }

  dispose() {
    this.freeFly.dispose();
  }

  #teleportPlayer(location) {
    const [x, z] = location.position.map(Number);
    const terrain = this.world.terrainSampler;
    if (!terrain.contains(x, z, 0)) {
      logger.warn(`Navigation location ${location.label} is outside the playable terrain.`);
      return false;
    }

    const y = terrain.sampleHeight(x, z)
      + this.player.metrics.rootToFeet
      + this.player.metrics.groundOffset
      + Number(location.heightOffset ?? 0);
    this.player.setEnabled(false);
    this.player.translateRoot(x, y, z);
    if (Number.isFinite(Number(location.yaw))) {
      const yaw = Number(location.yaw);
      this.player.cameraYaw = yaw;
      this.player.playerYaw = yaw;
      this.player.root.rotation.y = yaw;
    }
    this.player.setEnabled(true);
    logger.info(`Teleported player to ${location.label}.`);
    return true;
  }
}
