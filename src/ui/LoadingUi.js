import {
  LOADING_REVEAL_RADIUS_VMAX,
  LOADING_REVEAL_SECONDS,
  LOADING_STAGES,
  power4InOut,
} from './loadingStages.js';

const LOGO_FILL_SECONDS = 1;

function power2Out(value) {
  const t = Math.max(0, Math.min(1, value));
  return 1 - (1 - t) ** 2;
}

export class LoadingUi {
  constructor(root) {
    this.logoFillPercent = 0;
    this.logoAnimationFrame = null;
    this.revealAnimationFrame = null;
    this.element = document.createElement('div');
    this.element.className = 'loading-overlay';
    this.element.innerHTML = `
      <div class="loading-logo" aria-label="RPG Grass">
        <span class="logo-outline">RPG GRASS</span>
        <span class="logo-fill">RPG GRASS</span>
      </div>
      <div class="loading-progress" aria-live="polite">
        <div class="loading-progress-track"><i class="progress-bar"></i></div>
        <div class="loading-row"><span id="status-label">Initializing...</span><strong id="percent-label">0%</strong></div>
      </div>
      <button id="startButton" class="loading-start" type="button">START</button>`;
    root.appendChild(this.element);

    this.progressBar = this.element.querySelector('.progress-bar');
    this.percentLabel = this.element.querySelector('#percent-label');
    this.statusLabel = this.element.querySelector('#status-label');
    this.logoFill = this.element.querySelector('.logo-fill');
    this.startButton = this.element.querySelector('#startButton');
    this.stage('initializing');
  }

  stage(name) {
    const stage = LOADING_STAGES[name];
    if (!stage) return;
    this.#setProgress(stage.message, stage.progress);
  }

  update(message, progress) {
    const percent = progress <= 1 ? progress * 100 : progress;
    this.#setProgress(message, percent);
  }

  #setProgress(message, progress) {
    const percent = Math.max(0, Math.min(100, Number(progress) || 0));
    this.progressBar.style.transform = `scaleX(${percent / 100})`;
    this.percentLabel.textContent = `${Math.round(percent)}%`;
    this.statusLabel.textContent = message;
    this.#animateLogoFill(percent);

    if (percent >= 100) this.element.classList.add('is-ready');
  }

  #animateLogoFill(targetPercent) {
    if (this.logoAnimationFrame !== null) cancelAnimationFrame(this.logoAnimationFrame);
    const from = this.logoFillPercent;
    const to = Math.max(0, Math.min(100, targetPercent));
    const startedAt = performance.now();
    const durationMs = LOGO_FILL_SECONDS * 1000;

    const tick = (now) => {
      const raw = Math.min(1, (now - startedAt) / durationMs);
      this.logoFillPercent = from + (to - from) * power2Out(raw);
      const top = 100 - this.logoFillPercent;
      this.logoFill.style.clipPath = `polygon(0 100%, 100% 100%, 100% ${top}%, 0 ${top}%)`;
      if (raw < 1) {
        this.logoAnimationFrame = requestAnimationFrame(tick);
      } else {
        this.logoAnimationFrame = null;
      }
    };

    this.logoAnimationFrame = requestAnimationFrame(tick);
  }

  async waitForStart(onStart) {
    if (!this.element?.isConnected) return;

    await new Promise((resolve) => {
      this.startButton.addEventListener('click', async () => {
        this.startButton.disabled = true;
        this.startButton.style.pointerEvents = 'none';
        this.element.style.pointerEvents = 'none';
        await onStart?.();
        await this.#revealScene();
        this.element.remove();
        resolve();
      }, { once: true });
    });
  }

  #revealScene() {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const durationMs = LOADING_REVEAL_SECONDS * 1000;

      const tick = (now) => {
        const raw = Math.min(1, (now - startedAt) / durationMs);
        const radius = power4InOut(raw) * LOADING_REVEAL_RADIUS_VMAX;
        this.element.style.setProperty('--r', `${radius}vmax`);
        if (raw < 1) {
          this.revealAnimationFrame = requestAnimationFrame(tick);
          return;
        }
        this.revealAnimationFrame = null;
        resolve();
      };

      this.revealAnimationFrame = requestAnimationFrame(tick);
    });
  }

  dispose() {
    if (this.logoAnimationFrame !== null) cancelAnimationFrame(this.logoAnimationFrame);
    if (this.revealAnimationFrame !== null) cancelAnimationFrame(this.revealAnimationFrame);
    this.element?.remove();
    this.element = null;
  }
}
