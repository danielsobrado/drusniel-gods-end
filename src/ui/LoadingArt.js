import { assetUrl } from '../assets/assetUrl.js';
import {
  LOADING_ART_HEIGHT,
  LOADING_ART_LQIP,
  LOADING_ART_SRC,
  LOADING_ART_WIDTH,
} from '../generated/loadingArt.js';

// The painted key art behind the loading overlay, plus the small amount of motion
// that keeps it from reading as a static JPEG: every brazier in the illustration
// breathes and throws embers, and the spell in the mage's hand crackles.
//
// This is a 2D canvas rather than a WebGL pass on purpose. The loading screen is
// on screen precisely while three.js is building its device and compiling the
// scene's shaders, so a second GPU context here would contend for the one
// resource the player is actually waiting on, and would add its own program
// compile to the critical path. Pre-baked sprites drawn with `lighter` get the
// same additive glow for a setup cost of about a millisecond.

// Emitters are in the art's own normalised space, so they stay pinned to the
// painted flames under any viewport aspect once the cover transform is applied.
// `glow` and `rise` are fractions of the art's width and height respectively.
const FIRES = [
  { x: 0.082, y: 0.145, glow: 0.070, rise: 0.10, spread: 0.016, rate: 5.5 },
  { x: 0.159, y: 0.062, glow: 0.052, rise: 0.06, spread: 0.013, rate: 3.5 },
  { x: 0.213, y: 0.050, glow: 0.034, rise: 0.04, spread: 0.009, rate: 2.0 },
  { x: 0.049, y: 0.290, glow: 0.030, rise: 0.04, spread: 0.008, rate: 2.0 },
  { x: 0.682, y: 0.085, glow: 0.052, rise: 0.07, spread: 0.013, rate: 3.5 },
  { x: 0.673, y: 0.458, glow: 0.072, rise: 0.11, spread: 0.017, rate: 5.5 },
  { x: 0.553, y: 0.532, glow: 0.034, rise: 0.05, spread: 0.009, rate: 2.0 },
  // The candles along the bottom edge are painted far out of focus, so they get
  // the breathing glow but no embers -- sharp sparks there would break the depth.
  { x: 0.152, y: 0.930, glow: 0.038, rise: 0, spread: 0, rate: 0 },
];

// The spell tangle around the open palm, measured off the illustration.
const ARCANE = { x: 0.447, y: 0.415, rx: 0.050, ry: 0.088 };
const ARCANE_SPARK_RATE = 22;
const ARC_INTERVAL = [0.35, 1.15];
const ARC_SECONDS = 0.11;

const MAX_EMBERS = 90;
const MAX_SPARKS = 46;
// A long shader compile parks the main thread, and an unclamped delta would then
// teleport every particle off screen in the frame after it resumes.
const MAX_DELTA_SECONDS = 0.05;
// The art is behind a scrim at partial opacity; there is nothing here worth
// shading at 3x, and the fill cost is what would steal frames from compilation.
const MAX_PIXEL_RATIO = 1.5;
const SPRITE_SIZE = 64;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// Layered incommensurate sines: cheaper than noise and, with no shared period,
// no two braziers ever pulse together.
function flicker(seconds, phase) {
  return 0.58
    + 0.26 * Math.sin(seconds * 7.3 + phase)
    + 0.11 * Math.sin(seconds * 13.1 + phase * 2.1)
    + 0.05 * Math.sin(seconds * 23.7 + phase * 3.7);
}

function buildSprite(stops) {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const context = canvas.getContext('2d');
  const half = SPRITE_SIZE / 2;
  const gradient = context.createRadialGradient(half, half, 0, half, half, half);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  context.fillStyle = gradient;
  context.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return canvas;
}

// Built once on first use: a per-frame createRadialGradient for every particle is
// the one thing that would make this loop expensive.
let sprites = null;
function getSprites() {
  sprites ??= {
    halo: buildSprite([
      [0, 'rgba(255, 216, 150, .85)'],
      [0.22, 'rgba(255, 152, 56, .42)'],
      [0.58, 'rgba(188, 72, 18, .12)'],
      [1, 'rgba(120, 40, 8, 0)'],
    ]),
    ember: buildSprite([
      [0, 'rgba(255, 248, 222, 1)'],
      [0.3, 'rgba(255, 178, 74, .78)'],
      [0.7, 'rgba(226, 96, 24, .2)'],
      [1, 'rgba(180, 60, 12, 0)'],
    ]),
    spark: buildSprite([
      [0, 'rgba(238, 246, 255, 1)'],
      [0.28, 'rgba(146, 194, 255, .72)'],
      [0.62, 'rgba(255, 196, 118, .3)'],
      [1, 'rgba(120, 150, 255, 0)'],
    ]),
  };
  return sprites;
}

export class LoadingArt {
  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'loading-art';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.innerHTML = '<div class="loading-art-lqip"></div>'
      + '<img class="loading-art-image" alt="" decoding="async" fetchpriority="high">'
      + '<div class="loading-art-scrim"></div>'
      + '<canvas class="loading-art-fx"></canvas>';

    this.placeholder = this.element.querySelector('.loading-art-lqip');
    this.image = this.element.querySelector('.loading-art-image');
    this.canvas = this.element.querySelector('.loading-art-fx');
    this.placeholder.style.backgroundImage = `url("${LOADING_ART_LQIP}")`;

    this.context = null;
    this.frame = null;
    this.lastFrameAt = 0;
    this.elapsed = 0;
    this.embers = [];
    this.sparks = [];
    this.arcs = [];
    this.nextArcAt = randomBetween(...ARC_INTERVAL);
    this.pending = FIRES.map(() => 0);
    this.arcanePending = 0;
    this.phases = FIRES.map((_, index) => index * 2.399963);
    this.artX = 0;
    this.artY = 0;
    this.artWidth = 0;
    this.artHeight = 0;

    this.onResize = () => { this.resized = true; };
    this.onVisibility = () => {
      if (document.visibilityState === 'hidden') this.#stop();
      else this.#start();
    };
    this.resized = true;

    // The whole point is that the picture is up before anything else, so the
    // fetch starts in the constructor rather than waiting on a mount or a stage.
    // If it never arrives the placeholder simply stays up, which is why there is
    // no error handler here.
    this.image.addEventListener('load', () => this.#onImageReady(), { once: true });
    this.image.src = assetUrl(LOADING_ART_SRC);
  }

  mount(parent) {
    parent.insertBefore(this.element, parent.firstChild);
  }

  #onImageReady() {
    // A renderer failure can tear the overlay down while the art is still in
    // flight, and the decode still lands afterwards.
    if (!this.element) return;
    this.element.classList.add('is-loaded');
    // Motion is the optional half of this; honour the OS switch and leave the
    // illustration perfectly still.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    this.context = this.canvas.getContext('2d');
    if (!this.context) return;
    getSprites();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.#start();
  }

  #start() {
    if (this.frame !== null || !this.context || !this.element) return;
    this.lastFrameAt = performance.now();
    this.frame = requestAnimationFrame((now) => this.#tick(now));
  }

  #stop() {
    if (this.frame === null) return;
    cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  #measure() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (width !== this.canvas.width || height !== this.canvas.height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    // Mirror the `object-fit: cover` the image itself gets, or the embers drift
    // away from the painted flames as soon as the window stops being 16:9.
    const scale = Math.max(width / LOADING_ART_WIDTH, height / LOADING_ART_HEIGHT);
    this.artWidth = LOADING_ART_WIDTH * scale;
    this.artHeight = LOADING_ART_HEIGHT * scale;
    this.artX = (width - this.artWidth) / 2;
    this.artY = (height - this.artHeight) / 2;
  }

  #tick(now) {
    this.frame = null;
    if (!this.context || !this.element) return;
    const delta = Math.min((now - this.lastFrameAt) / 1000, MAX_DELTA_SECONDS);
    this.lastFrameAt = now;
    this.elapsed += delta;

    if (this.resized) {
      this.resized = false;
      this.#measure();
    }

    const context = this.context;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.globalCompositeOperation = 'lighter';

    this.#drawBraziers(context);
    this.#updateEmbers(delta);
    this.#drawEmbers(context);
    this.#drawArcaneCore(context);
    this.#updateSparks(delta);
    this.#drawSparks(context);
    this.#updateArcs(delta);
    this.#drawArcs(context);

    context.globalAlpha = 1;
    this.frame = requestAnimationFrame((next) => this.#tick(next));
  }

  #toX(u) { return this.artX + u * this.artWidth; }
  #toY(v) { return this.artY + v * this.artHeight; }

  #drawBraziers(context) {
    const { halo } = getSprites();
    for (let index = 0; index < FIRES.length; index++) {
      const fire = FIRES[index];
      const pulse = flicker(this.elapsed, this.phases[index]);
      const radius = fire.glow * this.artWidth * (0.82 + 0.34 * pulse);
      // The halo sits above the base because that is where the painted flame is.
      const centerY = this.#toY(fire.y - fire.rise * 0.45);
      const centerX = this.#toX(fire.x);
      context.globalAlpha = Math.max(0, 0.16 + 0.2 * pulse);
      context.drawImage(halo, centerX - radius, centerY - radius, radius * 2, radius * 2);
    }
  }

  #updateEmbers(delta) {
    for (let index = 0; index < FIRES.length; index++) {
      const fire = FIRES[index];
      if (fire.rate === 0) continue;
      this.pending[index] += fire.rate * delta;
      while (this.pending[index] >= 1) {
        this.pending[index] -= 1;
        if (this.embers.length >= MAX_EMBERS) break;
        this.embers.push({
          x: fire.x + randomBetween(-fire.spread, fire.spread),
          y: fire.y + randomBetween(-fire.rise * 0.25, fire.rise * 0.1),
          vx: randomBetween(-0.006, 0.006),
          vy: -randomBetween(0.03, 0.075),
          life: randomBetween(2.2, 4.2),
          age: 0,
          size: randomBetween(0.0022, 0.0055),
          swayFrequency: randomBetween(1.4, 3.1),
          swayAmplitude: randomBetween(0.004, 0.013),
          phase: Math.random() * Math.PI * 2,
          twinkle: randomBetween(4, 11),
        });
      }
    }

    for (let index = this.embers.length - 1; index >= 0; index--) {
      const ember = this.embers[index];
      ember.age += delta;
      if (ember.age >= ember.life) {
        this.embers[index] = this.embers[this.embers.length - 1];
        this.embers.pop();
        continue;
      }
      // Embers cool as they climb, so the rise decays instead of running forever.
      ember.vy *= 1 - 0.34 * delta;
      const sway = Math.sin(this.elapsed * ember.swayFrequency + ember.phase) * ember.swayAmplitude;
      ember.x += (ember.vx + sway) * delta;
      ember.y += ember.vy * delta;
    }
  }

  #drawEmbers(context) {
    const sprite = getSprites().ember;
    for (const ember of this.embers) {
      const remaining = 1 - ember.age / ember.life;
      // Quick flare on birth, long decay after -- a linear fade reads as a bug.
      const envelope = Math.min(1, ember.age / (ember.life * 0.08)) * remaining ** 0.85;
      const twinkle = 0.74 + 0.26 * Math.sin(this.elapsed * ember.twinkle + ember.phase);
      const size = ember.size * this.artWidth * (0.6 + 0.4 * remaining);
      context.globalAlpha = Math.max(0, envelope * twinkle);
      context.drawImage(sprite, this.#toX(ember.x) - size, this.#toY(ember.y) - size, size * 2, size * 2);
    }
  }

  #drawArcaneCore(context) {
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 2.6);
    const shimmer = 0.5 + 0.5 * Math.sin(this.elapsed * 9.4 + 1.7);
    const radius = ARCANE.ry * this.artHeight * (0.78 + 0.22 * pulse);
    context.globalAlpha = 0.14 + 0.12 * shimmer;
    context.drawImage(
      getSprites().spark,
      this.#toX(ARCANE.x) - radius,
      this.#toY(ARCANE.y) - radius,
      radius * 2,
      radius * 2,
    );
  }

  #updateSparks(delta) {
    this.arcanePending += ARCANE_SPARK_RATE * delta;
    while (this.arcanePending >= 1) {
      this.arcanePending -= 1;
      if (this.sparks.length >= MAX_SPARKS) break;
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random());
      this.sparks.push({
        x: ARCANE.x + Math.cos(angle) * ARCANE.rx * radius,
        y: ARCANE.y + Math.sin(angle) * ARCANE.ry * radius,
        // Drift out along the spawn ray, with a bias upward like rising motes.
        vx: Math.cos(angle) * randomBetween(0.004, 0.016),
        vy: Math.sin(angle) * randomBetween(0.004, 0.016) - randomBetween(0.004, 0.018),
        life: randomBetween(0.7, 1.8),
        age: 0,
        size: randomBetween(0.0013, 0.0034),
        phase: Math.random() * Math.PI * 2,
        twinkle: randomBetween(9, 22),
      });
    }

    for (let index = this.sparks.length - 1; index >= 0; index--) {
      const spark = this.sparks[index];
      spark.age += delta;
      if (spark.age >= spark.life) {
        this.sparks[index] = this.sparks[this.sparks.length - 1];
        this.sparks.pop();
        continue;
      }
      spark.x += spark.vx * delta;
      spark.y += spark.vy * delta;
      spark.vx *= 1 - 0.8 * delta;
      spark.vy *= 1 - 0.8 * delta;
    }
  }

  #drawSparks(context) {
    const sprite = getSprites().spark;
    for (const spark of this.sparks) {
      const remaining = 1 - spark.age / spark.life;
      const envelope = Math.min(1, spark.age / (spark.life * 0.14)) * remaining ** 0.7;
      const twinkle = 0.45 + 0.55 * Math.sin(this.elapsed * spark.twinkle + spark.phase) ** 2;
      const size = spark.size * this.artWidth;
      context.globalAlpha = Math.max(0, envelope * twinkle);
      context.drawImage(sprite, this.#toX(spark.x) - size, this.#toY(spark.y) - size, size * 2, size * 2);
    }
  }

  // The painted spell is a tangle of lightning, so the sparks alone undersell it.
  // A short jagged flash every second or so is what makes it read as live.
  #updateArcs(delta) {
    this.nextArcAt -= delta;
    if (this.nextArcAt <= 0) {
      this.nextArcAt = randomBetween(...ARC_INTERVAL);
      const from = Math.random() * Math.PI * 2;
      const to = from + randomBetween(1.4, 4.9);
      const points = [];
      const segments = 5;
      for (let step = 0; step <= segments; step++) {
        const t = step / segments;
        const angle = from + (to - from) * t;
        // Bow the path inward at the middle, then roughen it.
        const reach = 0.45 + 0.55 * Math.abs(t * 2 - 1);
        points.push([
          ARCANE.x + Math.cos(angle) * ARCANE.rx * reach + randomBetween(-0.008, 0.008),
          ARCANE.y + Math.sin(angle) * ARCANE.ry * reach + randomBetween(-0.012, 0.012),
        ]);
      }
      this.arcs.push({ points, age: 0 });
    }

    for (let index = this.arcs.length - 1; index >= 0; index--) {
      this.arcs[index].age += delta;
      if (this.arcs[index].age >= ARC_SECONDS) this.arcs.splice(index, 1);
    }
  }

  #drawArcs(context) {
    if (this.arcs.length === 0) return;
    const unit = Math.max(1, this.artWidth / LOADING_ART_WIDTH);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const arc of this.arcs) {
      const fade = 1 - arc.age / ARC_SECONDS;
      context.beginPath();
      context.moveTo(this.#toX(arc.points[0][0]), this.#toY(arc.points[0][1]));
      for (let index = 1; index < arc.points.length; index++) {
        context.lineTo(this.#toX(arc.points[index][0]), this.#toY(arc.points[index][1]));
      }
      // Two passes rather than a shadowBlur: a wide dim halo under a hot core.
      context.globalAlpha = 0.16 * fade;
      context.lineWidth = 5 * unit;
      context.strokeStyle = 'rgba(150, 196, 255, 1)';
      context.stroke();
      context.globalAlpha = 0.7 * fade;
      context.lineWidth = 1.4 * unit;
      context.strokeStyle = 'rgba(236, 245, 255, 1)';
      context.stroke();
    }
  }

  dispose() {
    this.#stop();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.context = null;
    this.element?.remove();
    this.element = null;
  }
}
