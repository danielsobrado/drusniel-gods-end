import * as THREE from 'three';
import { logger } from '../utils/logger.js';
import { MAP_BIOMES, bakeMinimap, biomeAt, stampTrees } from './minimapBake.js';

const MIN_RADIUS = 90;
const MAX_RADIUS = 720;
const DEFAULT_RADIUS = 240;
const BACKDROP = '#0d1a22';
const PLAYER = '#f6efdc';
const PIN = '#ead29c';
// A redraw is skipped until the view has moved this far or turned this much.
const REDRAW_DISTANCE = 0.25;
const REDRAW_ANGLE = 0.004;

const forward = new THREE.Vector3();

// Heading of the camera around the Y axis, 0 looking north (-Z) and growing
// clockwise, so looking east (+X) is +PI/2.
function cameraHeading(camera) {
  camera.getWorldDirection(forward);
  return Math.atan2(forward.x, -forward.z);
}

function drawArrow(context, x, y, heading, size) {
  context.save();
  context.translate(x, y);
  context.rotate(heading);
  context.beginPath();
  context.moveTo(0, -size);
  context.lineTo(size * 0.72, size * 0.78);
  context.lineTo(0, size * 0.38);
  context.lineTo(-size * 0.72, size * 0.78);
  context.closePath();
  context.fillStyle = PLAYER;
  context.strokeStyle = 'rgba(10,15,20,.85)';
  context.lineWidth = Math.max(1, size * 0.18);
  context.lineJoin = 'round';
  context.stroke();
  context.fill();
  context.restore();
}

function drawViewCone(context, x, y, heading, length) {
  const gradient = context.createRadialGradient(x, y, 0, x, y, length);
  gradient.addColorStop(0, 'rgba(246,239,220,.34)');
  gradient.addColorStop(1, 'rgba(246,239,220,0)');
  context.save();
  context.translate(x, y);
  context.rotate(heading);
  context.translate(-x, -y);
  context.beginPath();
  context.moveTo(x, y);
  context.arc(x, y, length, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();
  context.restore();
}

// A heading-up circular minimap in the lower-right corner, and a north-up map
// of the whole world that opens from it (click or tap, or M). The terrain image
// is baked once in the background from the CPU terrain queries; until it is
// ready the minimap stays hidden.
export class Minimap {
  constructor({ root, terrain, config, trees = [], locations = [], onTravel = null }) {
    this.terrain = terrain;
    this.config = config;
    this.treePositions = trees.map(tree => ({ x: tree.position.x, z: tree.position.z }));
    this.locations = locations
      .filter(location => Array.isArray(location.position))
      .map(location => ({
        id: location.id,
        label: location.label,
        x: Number(location.position[0]),
        z: Number(location.mode === 'fly' ? location.position[2] : location.position[1]),
      }))
      .filter(location => Number.isFinite(location.x) && Number.isFinite(location.z));
    this.onTravel = onTravel;
    this.radius = DEFAULT_RADIUS;
    this.map = null;
    this.image = null;
    this.expanded = false;
    this.biome = null;
    this.last = { x: NaN, z: NaN, heading: NaN, radius: NaN, width: 0 };
    this.bakeTimer = 0;
    this.abortController = new AbortController();
    this.#create(root);
    this.#bake();
  }

  #create(root) {
    const element = document.createElement('div');
    element.className = 'minimap';
    element.hidden = true;
    element.innerHTML = `
      <button type="button" class="minimap-dial" data-minimap-open aria-label="Open world map (M)" title="World map (M)">
        <canvas class="minimap-canvas" aria-hidden="true"></canvas>
        <span class="minimap-north" aria-hidden="true">N</span>
      </button>
      <span class="minimap-biome" data-minimap-biome aria-live="polite"></span>`;
    // A sibling of the dial rather than a child: the dial's entry animation and
    // tour dimming must not become the full-screen map's frame or opacity.
    const worldMap = document.createElement('div');
    worldMap.className = 'world-map';
    worldMap.hidden = true;
    worldMap.setAttribute('role', 'dialog');
    worldMap.setAttribute('aria-modal', 'true');
    worldMap.setAttribute('aria-label', 'World map');
    worldMap.innerHTML = `
      <div class="world-map-frame">
        <div class="world-map-header">
          <strong>World map</strong>
          <span class="world-map-hint">Select a place to travel · <kbd>M</kbd> close</span>
          <button type="button" class="world-map-close" data-world-map-close aria-label="Close map">✕</button>
        </div>
        <div class="world-map-stage">
          <canvas class="world-map-canvas" data-world-map-canvas></canvas>
        </div>
        <ul class="world-map-legend">${MAP_BIOMES.map(biome => `
          <li><i style="background: rgb(${biome.color.join(',')})"></i>${biome.label}</li>`).join('')}
        </ul>
      </div>`;
    root.append(element, worldMap);
    this.element = element;
    this.dial = element.querySelector('[data-minimap-open]');
    this.canvas = element.querySelector('.minimap-canvas');
    this.context = this.canvas.getContext('2d');
    this.north = element.querySelector('.minimap-north');
    this.biomeLabel = element.querySelector('[data-minimap-biome]');
    this.worldMap = worldMap;
    this.worldCanvas = worldMap.querySelector('[data-world-map-canvas]');
    this.worldContext = this.worldCanvas.getContext('2d');

    const { signal } = this.abortController;
    this.dial.addEventListener('click', () => this.setExpanded(true), { signal });
    this.dial.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.radius = THREE.MathUtils.clamp(this.radius * Math.exp(event.deltaY * 0.0015), MIN_RADIUS, MAX_RADIUS);
    }, { signal, passive: false });
    worldMap.querySelector('[data-world-map-close]').addEventListener('click', () => this.setExpanded(false), { signal });
    this.worldMap.addEventListener('click', (event) => {
      if (event.target === this.worldMap) this.setExpanded(false);
    }, { signal });
    this.worldCanvas.addEventListener('click', (event) => this.#travelFromMap(event), { signal });
    window.addEventListener('keydown', (event) => {
      if (event.target.matches?.('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'KeyM' && !event.repeat) this.setExpanded(!this.expanded);
      else if (event.code === 'Escape' && this.expanded) this.setExpanded(false);
    }, { signal });
    window.addEventListener('resize', () => { this.last.width = 0; }, { signal });
  }

  // Bakes a few rows per task, so loading and the first frames stay responsive.
  #bake() {
    let steps;
    try {
      steps = bakeMinimap({ terrain: this.terrain, config: this.config, rowsPerStep: 4 });
    } catch (error) {
      logger.warn('Minimap could not be baked; continuing without it.', error);
      return;
    }
    const run = () => {
      this.bakeTimer = 0;
      if (this.abortController.signal.aborted) return;
      try {
        const started = performance.now();
        let step = steps.next();
        while (!step.done && performance.now() - started < 8) step = steps.next();
        if (!step.done) {
          this.bakeTimer = setTimeout(run, 0);
          return;
        }
        this.#finishBake(step.value);
      } catch (error) {
        logger.warn('Minimap could not be baked; continuing without it.', error);
      }
    };
    this.bakeTimer = setTimeout(run, 0);
  }

  #finishBake(map) {
    stampTrees(map, this.treePositions);
    const image = document.createElement('canvas');
    image.width = map.width;
    image.height = map.height;
    const context = image.getContext('2d');
    const pixels = context.createImageData(map.width, map.height);
    pixels.data.set(map.rgba);
    context.putImageData(pixels, 0, 0);
    this.map = map;
    this.image = image;
    this.worldMap.style.setProperty('--world-map-aspect', String(map.sizeX / map.sizeZ));
    this.element.hidden = false;
  }

  setExpanded(expanded) {
    if (!this.image || expanded === this.expanded) return;
    this.expanded = expanded;
    this.worldMap.hidden = !expanded;
    this.element.classList.toggle('is-expanded', expanded);
    this.last.width = 0;
    if (expanded) {
      if (document.pointerLockElement) document.exitPointerLock?.();
      this.worldMap.querySelector('[data-world-map-close]').focus({ preventScroll: true });
    }
  }

  update(focus, camera) {
    if (!this.image || !focus) return;
    const heading = cameraHeading(camera);
    const biome = biomeAt(this.map, focus.x, focus.z);
    if (biome !== this.biome) {
      this.biome = biome;
      this.biomeLabel.textContent = biome?.label ?? 'Wilderness';
    }
    if (this.expanded) {
      this.#drawWorldMap(focus, heading);
      return;
    }
    const last = this.last;
    if (Math.hypot(focus.x - last.x, focus.z - last.z) < REDRAW_DISTANCE
      && Math.abs(heading - last.heading) < REDRAW_ANGLE && last.radius === this.radius && last.width) return;
    last.x = focus.x; last.z = focus.z; last.heading = heading; last.radius = this.radius;
    this.#drawMinimap(focus, heading);
  }

  #fitCanvas(canvas, width, height) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    return ratio;
  }

  #drawMinimap(focus, heading) {
    const size = this.canvas.clientWidth;
    if (!size) return;
    this.last.width = size;
    const ratio = this.#fitCanvas(this.canvas, size, size);
    const context = this.context;
    const half = size * ratio / 2;
    const scale = half / this.radius;
    const map = this.map;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = BACKDROP;
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Heading-up: rotate the world so the camera looks toward the top.
    context.setTransform(1, 0, 0, 1, half, half);
    context.rotate(-heading);
    context.scale(scale, scale);
    context.translate(-focus.x, -focus.z);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(this.image, map.minX, map.minZ, map.sizeX, map.sizeZ);

    context.setTransform(1, 0, 0, 1, 0, 0);
    const cos = Math.cos(-heading), sin = Math.sin(-heading);
    for (const location of this.locations) {
      const dx = (location.x - focus.x) * scale, dz = (location.z - focus.z) * scale;
      const px = half + dx * cos - dz * sin, pz = half + dx * sin + dz * cos;
      if (Math.hypot(px - half, pz - half) > half - 6 * ratio) continue;
      this.#drawPin(context, px, pz, 3.2 * ratio);
    }
    drawViewCone(context, half, half, 0, half * 0.55);
    drawArrow(context, half, half, 0, 7 * ratio);

    // The N tick rides the rim opposite the direction the map turned.
    const rim = size / 2 - 9;
    this.north.style.transform = `translate(${Math.sin(-heading) * rim}px, ${-Math.cos(-heading) * rim}px)`;
  }

  #drawPin(context, x, y, radius) {
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = PIN;
    context.strokeStyle = 'rgba(10,15,20,.8)';
    context.lineWidth = radius * 0.5;
    context.stroke();
    context.fill();
  }

  // Fits the whole baked map, north up, inside the stage element.
  #worldLayout() {
    const stage = this.worldCanvas.parentElement;
    const map = this.map;
    const scale = Math.min(stage.clientWidth / map.sizeX, stage.clientHeight / map.sizeZ);
    return { width: map.sizeX * scale, height: map.sizeZ * scale, scale };
  }

  #drawWorldMap(focus, heading) {
    const layout = this.#worldLayout();
    if (!layout.width || !layout.height) return;
    this.worldCanvas.style.width = `${layout.width}px`;
    this.worldCanvas.style.height = `${layout.height}px`;
    const ratio = this.#fitCanvas(this.worldCanvas, layout.width, layout.height);
    const context = this.worldContext;
    const map = this.map;
    const scale = layout.scale * ratio;
    const toCanvas = (x, z) => [(x - map.minX) * scale, (z - map.minZ) * scale];
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(this.image, 0, 0, this.worldCanvas.width, this.worldCanvas.height);

    const fontSize = Math.round(THREE.MathUtils.clamp(layout.width / 70, 10, 13) * ratio);
    context.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    const pins = this.locations.map(location => ({ location, point: toCanvas(location.x, location.z) }));
    for (const { point } of pins) this.#drawPin(context, point[0], point[1], 4.5 * ratio);
    // Each label takes the first side of its pin (above, below, right, left)
    // that neither overlaps an earlier label nor leaves the map.
    const placed = [];
    const gap = 7 * ratio;
    const overlaps = box => placed.some(other => box.x < other.x + other.w && other.x < box.x + box.w
      && box.y < other.y + other.h && other.y < box.y + box.h);
    this.pinHits = [];
    for (const { location, point: [x, y] } of pins) {
      const w = context.measureText(location.label).width, h = fontSize * 1.1;
      const sides = [
        { x: x - w / 2, y: y - gap - h },
        { x: x - w / 2, y: y + gap },
        { x: x + gap, y: y - h / 2 },
        { x: x - gap - w, y: y - h / 2 },
      ].map(side => ({ ...side, w, h }));
      const inside = box => box.x >= 0 && box.y >= 0
        && box.x + box.w <= this.worldCanvas.width && box.y + box.h <= this.worldCanvas.height;
      const box = sides.find(side => inside(side) && !overlaps(side))
        ?? sides.find(side => !overlaps(side)) ?? sides[0];
      placed.push(box);
      context.lineWidth = 3 * ratio;
      context.strokeStyle = 'rgba(10,15,20,.75)';
      context.strokeText(location.label, box.x, box.y + h / 2);
      context.fillStyle = '#f4ecd8';
      context.fillText(location.label, box.x, box.y + h / 2);
      this.pinHits.push({
        id: location.id,
        x: x / ratio,
        y: y / ratio,
        label: { x: box.x / ratio, y: box.y / ratio, w: box.w / ratio, h: box.h / ratio },
      });
    }
    const [px, py] = toCanvas(focus.x, focus.z);
    drawViewCone(context, px, py, heading, 60 * ratio);
    drawArrow(context, px, py, heading, 9 * ratio);
  }

  #travelFromMap(event) {
    if (!this.onTravel || !this.pinHits?.length) return;
    const rect = this.worldCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    // Generous hit area so a fingertip can pick a pin or its label.
    let best = null, bestDistance = 22;
    for (const pin of this.pinHits) {
      const { label } = pin;
      const labelDistance = Math.hypot(Math.max(label.x - x, 0, x - label.x - label.w),
        Math.max(label.y - y, 0, y - label.y - label.h));
      const distance = Math.min(Math.hypot(pin.x - x, pin.y - y), labelDistance + 4);
      if (distance < bestDistance) { best = pin; bestDistance = distance; }
    }
    if (!best) return;
    this.setExpanded(false);
    this.onTravel(best.id);
  }

  dispose() {
    this.abortController.abort();
    clearTimeout(this.bakeTimer);
    this.element?.remove();
    this.worldMap?.remove();
    this.element = null;
    this.worldMap = null;
    this.image = null;
    this.map = null;
  }
}
