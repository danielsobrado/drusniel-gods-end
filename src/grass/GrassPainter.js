import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GrassPainterUi } from '../ui/GrassPainterUi.js';
import {
  brushRadiusPixels,
  heightToPaintValue,
  strokeSpacingUv,
} from './painterMath.js';

const MODE_ADD = 'add';
const MODE_ERASE = 'erase';
const EMPTY_MASK_VALUE = 255;

export class GrassPainter {
  constructor({
    scene,
    camera,
    renderer,
    terrain,
    mask,
    config,
    player,
    onChange,
    onClose,
  }) {
    this.scene = scene;
    this.gameCamera = camera;
    this.orbitCamera = camera.clone();
    this.renderer = renderer;
    this.domElement = renderer.domElement;
    this.terrain = terrain;
    this.mask = mask;
    this.config = config;
    this.player = player;
    this.onChange = onChange;
    this.pendingChange = false;
    this.onClose = onClose;
    this.enabled = false;
    this.mode = MODE_ADD;
    this.brushRadius = config.painter.brushRadius;
    this.uiHeight = config.painter.height;
    this.paintValue = config.painter.initialPaintValue;
    this.lastUv = null;
    this.lastMouse = { x: 0, y: 0 };
    this.painting = false;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.eventController = null;

    this.controls = new OrbitControls(this.orbitCamera, this.domElement);
    this.controls.enablePan = true;
    this.controls.enabled = false;
    this.cursor = this.#createCursor();
    this.preview = this.#createPreview();
    this.ui = this.#createUi();
    this.scene.add(this.cursor);
    this.#drawPreview();
  }

  #createCursor() {
    const cursor = this.config.painter.cursor;
    const geometry = new THREE.RingGeometry(
      cursor.innerRadius,
      cursor.outerRadius,
      cursor.segments,
    );
    const material = new THREE.MeshBasicMaterial({
      color: cursor.color,
      transparent: true,
      opacity: cursor.opacity,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    return mesh;
  }

  #createPreview() {
    const preview = this.config.painter.preview;
    const canvas = document.createElement('canvas');
    canvas.width = preview.size;
    canvas.height = preview.size;
    canvas.className = 'grass-mask-preview';
    canvas.style.setProperty('--grass-mask-preview-size', `${preview.size}px`);
    canvas.style.setProperty('--grass-mask-preview-top', `${preview.top}px`);
    canvas.style.setProperty('--grass-mask-preview-left', `${preview.left}px`);
    canvas.style.opacity = '0';
    document.body.appendChild(canvas);
    return canvas;
  }

  #createUi() {
    return new GrassPainterUi({
      brushRadius: this.brushRadius,
      height: this.uiHeight,
      onClose: () => this.onClose?.(),
      onMode: (mode) => this.setMode(mode),
      onBrushRadius: (value) => this.setBrushRadius(value),
      onHeight: (value) => this.setBladeHeight(value),
      onClear: () => this.clear(),
      onSave: () => this.download(),
    });
  }

  #addEventListeners() {
    this.eventController?.abort();
    this.eventController = new AbortController();
    const { signal } = this.eventController;

    this.domElement.addEventListener('mousedown', (event) => this.#onMouseDown(event), { signal });
    this.domElement.addEventListener('mousemove', (event) => this.#onMouseMove(event), { signal });
    this.domElement.addEventListener('mouseup', () => this.#onMouseUp(), { signal });
    this.domElement.addEventListener('keydown', (event) => this.#onKeyDown(event), { signal });
    this.domElement.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse' || event.button !== 2) return;
      this.controls.mouseButtons.RIGHT = event.shiftKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    }, { signal, capture: true });
    this.domElement.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse' && event.button === 2) {
        this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
      }
    }, { signal, capture: true });
    this.domElement.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
  }

  #removeEventListeners() {
    this.eventController?.abort();
    this.eventController = null;
  }

  #getTerrainHit(clientX, clientY) {
    if (!this.terrain) return null;
    this.pointer.set(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.orbitCamera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    if (!hit?.uv) return null;

    const uv = hit.uv.clone();
    if (this.config.painter.flipU) uv.x = 1 - uv.x;
    if (this.config.painter.flipV) uv.y = 1 - uv.y;
    return { uv, point: hit.point };
  }

  #paintStamp(uv) {
    const brush = this.config.painter.brush;
    const radius = brushRadiusPixels(
      this.brushRadius,
      this.mask.resolution,
      brush.terrainSpan,
    );
    const value = this.mode === MODE_ADD ? this.paintValue : EMPTY_MASK_VALUE;
    this.mask.paintUvHard(uv, radius, value);
  }

  #paintStroke(uv) {
    if (!this.lastUv) {
      this.#paintStamp(uv);
      this.lastUv = uv.clone();
      return;
    }

    const brush = this.config.painter.brush;
    const spacing = strokeSpacingUv(
      this.brushRadius,
      brush.terrainSpan,
      brush.strokeSpacing,
    );
    const distance = uv.distanceTo(this.lastUv);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 1; step <= steps; step += 1) {
      this.#paintStamp(this.lastUv.clone().lerp(uv, step / steps));
    }
    this.lastUv = uv.clone();
  }

  #onMouseDown(event) {
    if (event.button !== 0) return;
    this.painting = true;
    const hit = this.#getTerrainHit(event.clientX, event.clientY);
    if (!hit?.uv) return;
    this.#paintStamp(hit.uv);
    this.lastUv = hit.uv.clone();
    this.#afterPaint();
  }

  #onMouseMove(event) {
    this.lastMouse.x = event.clientX;
    this.lastMouse.y = event.clientY;
    const hit = this.#getTerrainHit(event.clientX, event.clientY);
    if (!hit?.point) {
      this.cursor.visible = false;
      return;
    }

    this.cursor.visible = true;
    this.cursor.position.copy(hit.point);
    if (!this.painting || !hit.uv) return;
    this.#paintStroke(hit.uv);
    this.#afterPaint();
  }

  #onMouseUp() {
    this.painting = false;
    this.lastUv = null;
  }

  #onKeyDown(event) {
    const brush = this.config.painter.brush;
    switch (event.key) {
      case '[':
        this.setBrushRadius(Math.max(brush.minRadius, this.brushRadius - brush.keyboardStep));
        break;
      case ']':
        this.setBrushRadius(Math.min(brush.maxRadius, this.brushRadius + brush.keyboardStep));
        break;
      case '1':
        this.setMode(MODE_ADD);
        break;
      case '2':
        this.setMode(MODE_ERASE);
        break;
      case '8':
        this.download();
        break;
      case 'p':
        this.#toggleContinuousPaint();
        break;
      default:
        break;
    }
  }

  #toggleContinuousPaint() {
    if (this.painting) {
      this.painting = false;
      this.lastUv = null;
      this.cursor.visible = false;
      return;
    }

    this.painting = true;
    const hit = this.#getTerrainHit(this.lastMouse.x, this.lastMouse.y);
    if (!hit?.uv) return;
    this.#paintStamp(hit.uv);
    this.lastUv = hit.uv.clone();
    this.#afterPaint();
  }

  #afterPaint() {
    this.mask.commitPixels();
    this.#drawPreview();
    // The clearance dilation of the painted region is deferred to update(), which
    // then fires onChange so tile compaction rebuilds from the fresh data.
    this.pendingChange = true;
  }

  #drawPreview() {
    if (!this.preview) return;
    const context = this.preview.getContext('2d');
    context.clearRect(0, 0, this.preview.width, this.preview.height);
    context.drawImage(this.mask.canvas, 0, 0, this.preview.width, this.preview.height);
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) return;
    this.enabled = next;
    this.preview.style.opacity = next ? '1' : '0';
    this.ui.setVisible(next);
    this.cursor.visible = false;
    document.body.style.cursor = next ? 'crosshair' : '';
    this.player?.setEnabled(!next);

    if (next) {
      document.exitPointerLock?.();
      this.orbitCamera.position.copy(this.gameCamera.position);
      this.orbitCamera.quaternion.copy(this.gameCamera.quaternion);
      this.orbitCamera.updateMatrixWorld();
      this.orbitCamera.position.y = this.config.painter.orbitCameraHeight;
      this.controls.mouseButtons.LEFT = null;
      this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
      this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
      this.controls.enabled = true;
      this.#addEventListeners();
      this.#drawPreview();
      return;
    }

    this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.enabled = false;
    this.painting = false;
    this.lastUv = null;
    this.#removeEventListeners();
  }

  setMode(mode) {
    if (mode !== MODE_ADD && mode !== MODE_ERASE) return;
    this.mode = mode;
    this.ui.setMode(mode);
  }

  setBrushRadius(value) {
    const brush = this.config.painter.brush;
    this.brushRadius = THREE.MathUtils.clamp(
      Number(value),
      brush.minRadius,
      brush.maxRadius,
    );
    this.ui.setBrushRadius(this.brushRadius);
  }

  setBladeHeight(value) {
    const control = this.config.painter.heightControl;
    this.uiHeight = THREE.MathUtils.clamp(
      Math.floor(Number(value)),
      control.min,
      control.max,
    );
    this.paintValue = heightToPaintValue(this.uiHeight, {
      minHeight: control.min,
      maxHeight: control.max,
      maskRange: control.maskRange,
    });
    this.ui.setHeight(this.uiHeight);
  }

  clear() {
    this.mask.clear(EMPTY_MASK_VALUE);
    this.#drawPreview();
    this.onChange?.();
  }

  download() {
    this.mask.download('grass-mask.jpg');
  }

  update() {
    if (!this.enabled) return;
    if (this.pendingChange) {
      this.mask.flushVegetation();
      this.pendingChange = false;
      this.onChange?.();
    }
    this.controls.update();
    this.gameCamera.position.copy(this.orbitCamera.position);
    this.gameCamera.quaternion.copy(this.orbitCamera.quaternion);
    this.gameCamera.updateMatrixWorld();
  }

  dispose() {
    this.setEnabled(false);
    this.#removeEventListeners();
    this.controls?.dispose?.();
    this.scene?.remove(this.cursor);
    this.cursor?.geometry?.dispose?.();
    this.cursor?.material?.dispose?.();
    this.preview?.remove?.();
    this.ui?.dispose?.();
    this.cursor = null;
    this.preview = null;
    this.ui = null;
    this.player = null;
  }
}
