const SHIFT_CODES = new Set(['ShiftLeft', 'ShiftRight']);
const SPEED_FIELDS = Object.freeze([
  ['player', 'walkSpeed'],
  ['player', 'runSpeed'],
  ['player', 'motion', 'acceleration'],
  ['player', 'motion', 'deceleration'],
  ['cinematic', 'motion', 'walkSpeedInHeights'],
  ['cinematic', 'motion', 'runSpeedInHeights'],
]);

function isFormControl(target) {
  return Boolean(target?.matches?.('input, select, textarea, button, [contenteditable="true"]'));
}

function valueAt(root, path) {
  let value = root;
  for (const key of path) value = value?.[key];
  return value;
}

function setValueAt(root, path, value) {
  let target = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    target = target?.[path[index]];
    if (!target) return;
  }
  target[path.at(-1)] = value;
}

function resolveSettings(config) {
  const settings = config?.player?.motion?.explorationBoost;
  if (!settings) throw new Error('player.motion.explorationBoost configuration is required.');
  const doubleTapWindowMs = Number(settings.doubleTapWindowMs);
  const speedMultiplier = Number(settings.speedMultiplier);
  if (!(doubleTapWindowMs > 0) || !Number.isFinite(doubleTapWindowMs)) {
    throw new Error('player.motion.explorationBoost.doubleTapWindowMs must be a positive finite number.');
  }
  if (!(speedMultiplier > 1) || !Number.isFinite(speedMultiplier)) {
    throw new Error('player.motion.explorationBoost.speedMultiplier must be a finite number greater than one.');
  }
  return { doubleTapWindowMs, speedMultiplier };
}

function captureBaseline(config) {
  return SPEED_FIELDS.map((path) => ({ path, value: valueAt(config, path) }))
    .filter(({ value }) => Number.isFinite(value));
}

function applyBaseline(config, baseline, multiplier) {
  for (const { path, value } of baseline) setValueAt(config, path, value * multiplier);
}

export class ExplorationSpeedMode {
  constructor({ eventTarget = globalThis.window, now = () => performance.now(), onChange } = {}) {
    this.eventTarget = eventTarget;
    this.now = now;
    this.onChange = onChange;
    this.active = false;
    this.lastShiftTap = Number.NEGATIVE_INFINITY;
    this.config = null;
    this.settings = null;
    this.baseline = [];
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.eventTarget?.addEventListener?.('keydown', this.handleKeyDown);
  }

  setConfig(config) {
    if (this.config === config) return;
    this.#restoreCurrentConfig();
    this.config = config;
    this.settings = resolveSettings(config);
    this.baseline = captureBaseline(config);
    if (this.active) this.#applyCurrentConfig();
  }

  handleKeyDown(event) {
    if (!this.config || event?.repeat || !SHIFT_CODES.has(event?.code) || isFormControl(event?.target)) return false;
    const now = this.now();
    if (now - this.lastShiftTap <= this.settings.doubleTapWindowMs) {
      this.lastShiftTap = Number.NEGATIVE_INFINITY;
      this.setActive(!this.active);
      return true;
    }
    this.lastShiftTap = now;
    return false;
  }

  setActive(active) {
    const next = Boolean(active);
    if (next === this.active) return;
    this.#restoreCurrentConfig();
    this.active = next;
    if (this.active) this.#applyCurrentConfig();
    this.onChange?.({ active: this.active, multiplier: this.settings?.speedMultiplier ?? 1 });
  }

  captureSessionState(demo) {
    const state = demo.captureSessionState();
    if (this.active && state?.config) applyBaseline(state.config, this.baseline, 1);
    return state;
  }

  dispose() {
    this.eventTarget?.removeEventListener?.('keydown', this.handleKeyDown);
    this.#restoreCurrentConfig();
    this.config = null;
    this.baseline = [];
  }

  #applyCurrentConfig() {
    if (!this.config) return;
    applyBaseline(this.config, this.baseline, this.settings.speedMultiplier);
  }

  #restoreCurrentConfig() {
    if (!this.config || this.baseline.length === 0) return;
    applyBaseline(this.config, this.baseline, 1);
  }
}
