export const LOADING_STAGES = Object.freeze({
  initializing: Object.freeze({ message: 'Opening the way...', progress: 0 }),
  renderer: Object.freeze({ message: 'Lighting the horizon...', progress: 0 }),
  environment: Object.freeze({ message: 'Waking the sky...', progress: 0 }),
  world: Object.freeze({ message: 'Shaping the wilds...', progress: 5 }),
  character: Object.freeze({ message: 'Choose your traveler...', progress: 20 }),
  player: Object.freeze({ message: 'Preparing your traveler...', progress: 25 }),
  collision: Object.freeze({ message: 'Setting the boundaries...', progress: 40 }),
  foliage: Object.freeze({ message: 'Awakening the forest...', progress: 55 }),
  grass: Object.freeze({ message: 'Weaving the undergrowth...', progress: 65 }),
  audio: Object.freeze({ message: 'Waking the soundscape...', progress: 75 }),
  shaders: Object.freeze({ message: 'Polishing the final details...', progress: 80 }),
  ready: Object.freeze({ message: 'The way is open', progress: 100 }),
});

export const LOADING_REVEAL_SECONDS = 3;
export const LOADING_REVEAL_RADIUS_VMAX = 120;

// Scene-change iris. Closing is quicker than opening so the cut lands early and
// the new scene gets the longer, more generous reveal.
export const IRIS_CLOSE_SECONDS = 0.45;
export const IRIS_OPEN_SECONDS = 0.6;
export const IRIS_RADIUS_VMAX = LOADING_REVEAL_RADIUS_VMAX;

export function power4InOut(value) {
  const t = Math.max(0, Math.min(1, value));
  return t < 0.5
    ? 8 * t ** 4
    : 1 - ((-2 * t + 2) ** 4) / 2;
}
