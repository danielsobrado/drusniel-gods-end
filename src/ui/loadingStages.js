export const LOADING_STAGES = Object.freeze({
  initializing: Object.freeze({ message: 'Starting...', progress: 0 }),
  renderer: Object.freeze({ message: 'Initializing renderer...', progress: 0 }),
  environment: Object.freeze({ message: 'Loading environment...', progress: 0 }),
  world: Object.freeze({ message: 'Loading world...', progress: 5 }),
  player: Object.freeze({ message: 'Loading player...', progress: 25 }),
  collision: Object.freeze({ message: 'Setting up collision system...', progress: 40 }),
  foliage: Object.freeze({ message: 'Setting up foliage', progress: 55 }),
  grass: Object.freeze({ message: 'Growing grass...', progress: 65 }),
  audio: Object.freeze({ message: 'Loading audio...', progress: 75 }),
  shaders: Object.freeze({ message: 'Compiling shaders...', progress: 80 }),
  ready: Object.freeze({ message: 'Here we are', progress: 100 }),
});

export const LOADING_REVEAL_SECONDS = 3;
export const LOADING_REVEAL_RADIUS_VMAX = 120;

export function power4InOut(value) {
  const t = Math.max(0, Math.min(1, value));
  return t < 0.5
    ? 8 * t ** 4
    : 1 - ((-2 * t + 2) ** 4) / 2;
}
