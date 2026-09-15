import {
  formatShaderCompileCategories,
  formatShaderMaterialTypes,
  SHADER_COMPILE_END_EVENT,
  SHADER_COMPILE_START_EVENT,
} from '../rendering/ShaderCompileDiagnostics.js';
import {
  LOADING_REVEAL_RADIUS_VMAX,
  LOADING_REVEAL_SECONDS,
  LOADING_STAGES,
  power4InOut,
} from './loadingStages.js';

const LOGO_FILL_SECONDS = 1;
const SHADER_STATUS_INTERVAL_MS = 100;

function power2Out(value) {
  const t = Math.max(0, Math.min(1, value));
  return 1 - (1 - t) ** 2;
}

function backendLabel(value) {
  if (value === 'webgpu') return 'WebGPU';
  if (value === 'webgl2') return 'WebGL 2';
  return value || 'GPU';
}

export class LoadingUi {
  constructor(root, presentation, characterChoice = null) {
    this.logoFillPercent = 0;
    this.characterChoice = characterChoice;
    this.selectedCharacterId = null;
    this.characterList = null;
    this.resolveCharacter = null;
    this.characterPromise = new Promise((resolve) => { this.resolveCharacter = resolve; });
    this.logoAnimationFrame = null;
    this.revealAnimationFrame = null;
    this.shaderTimer = null;
    this.shaderStartedAt = 0;
    this.onShaderCompileStart = (event) => this.#beginShaderCompilation(event.detail);
    this.onShaderCompileEnd = (event) => this.#finishShaderCompilation(event.detail);
    globalThis.addEventListener?.(SHADER_COMPILE_START_EVENT, this.onShaderCompileStart);
    globalThis.addEventListener?.(SHADER_COMPILE_END_EVENT, this.onShaderCompileEnd);
    this.element = document.createElement('div');
    this.element.className = 'loading-overlay';
    this.element.innerHTML = `
      <div class="loading-logo" aria-label="Drusniel: Gods’ End">
        <span class="logo-outline">Drusniel: Gods’ End</span>
        <span class="logo-fill">Drusniel: Gods’ End</span>
      </div>
      <div class="loading-progress" aria-live="polite">
        <div class="loading-progress-track"><i class="progress-bar"></i></div>
        <div class="loading-row"><span id="status-label">Opening the way...</span><strong id="percent-label">0%</strong></div>
        <div id="status-detail" class="loading-detail"></div>
        <div id="status-tech" class="loading-detail loading-detail-tech"></div>
      </div>
      <button id="startButton" class="loading-start" type="button">START</button>`;
    root.appendChild(this.element);
    if (presentation) {
      this.element.classList.add('cinematic-loading');
      this.element.querySelectorAll('.logo-outline, .logo-fill').forEach(element => { element.textContent = presentation.title; });
      this.element.querySelector('.loading-logo').setAttribute('aria-label', presentation.title);
      this.element.querySelector('#startButton').textContent = 'Enter Gods’ End';
    }

    this.progressBar = this.element.querySelector('.progress-bar');
    this.percentLabel = this.element.querySelector('#percent-label');
    this.statusLabel = this.element.querySelector('#status-label');
    this.statusDetail = this.element.querySelector('#status-detail');
    this.statusTech = this.element.querySelector('#status-tech');
    this.logoFill = this.element.querySelector('.logo-fill');
    this.startButton = this.element.querySelector('#startButton');
    this.#createCharacterPicker();
    this.stage('initializing');
  }

  // The roster gate sits inside the loading overlay because the choice has to be
  // made before the player GLB is fetched, which is long before START lights up.
  #createCharacterPicker() {
    const roster = this.characterChoice?.roster ?? [];
    if (roster.length < 2) {
      this.resolveCharacter(this.characterChoice?.selectedId ?? roster[0]?.id ?? null);
      return;
    }

    this.characterList = document.createElement('div');
    this.characterList.className = 'character-select';
    this.characterList.setAttribute('role', 'radiogroup');
    this.characterList.setAttribute('aria-label', 'Choose your character');

    for (const entry of roster) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'character-card';
      card.dataset.characterId = entry.id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', 'false');
      card.innerHTML = '<span class="character-monogram"></span>'
        + '<span class="character-copy"><strong></strong><em></em><small></small></span>';
      card.querySelector('.character-monogram').textContent = (entry.name ?? entry.id).slice(0, 1);
      card.querySelector('strong').textContent = entry.name ?? entry.id;
      card.querySelector('em').textContent = entry.title ?? '';
      card.querySelector('small').textContent = entry.blurb ?? '';
      card.addEventListener('click', () => this.#chooseCharacter(entry.id));
      this.characterList.appendChild(card);
    }

    this.element.insertBefore(this.characterList, this.startButton);
    const preselected = this.characterChoice?.selectedId;
    if (preselected) this.#chooseCharacter(preselected);
  }

  #chooseCharacter(id) {
    if (this.selectedCharacterId) return;
    this.selectedCharacterId = id;
    this.characterList.classList.add('is-locked');
    for (const card of this.characterList.querySelectorAll('.character-card')) {
      const chosen = card.dataset.characterId === id;
      card.setAttribute('aria-checked', String(chosen));
      card.classList.toggle('is-chosen', chosen);
      card.disabled = true;
    }
    this.resolveCharacter(id);
  }

  waitForCharacter() {
    return this.characterPromise;
  }

  needsCharacterChoice() {
    return Boolean(this.characterList) && this.selectedCharacterId === null;
  }

  stage(name) {
    const stage = LOADING_STAGES[name];
    if (!stage) return;
    if (name !== 'shaders') this.#clearShaderStatus();
    this.#setProgress(stage.message, stage.progress);
    if (name === 'shaders') {
      this.statusDetail.textContent = 'Preparing the final lighting and surfaces…';
      this.statusTech.textContent = 'Waiting for renderer pipeline inventory.';
    }
  }

  update(message, progress) {
    const percent = progress <= 1 ? progress * 100 : progress;
    this.#clearShaderStatus();
    this.#setProgress(message, percent);
  }

  #setProgress(message, progress) {
    const percent = Math.max(0, Math.min(100, Number(progress) || 0));
    this.progressBar.style.transform = `scaleX(${percent / 100})`;
    this.percentLabel.textContent = `${Math.round(percent)}%`;
    this.statusLabel.textContent = message;
    this.#animateLogoFill(percent);

    if (percent >= 100) {
      this.element.classList.add('is-ready');
      // On short phone screens the character cards push Start below the fold.
      this.startButton?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
  }

  #beginShaderCompilation(detail = {}) {
    const diagnostics = detail.diagnostics ?? { renderables: 0, materials: 0, categories: [], materialTypes: [] };
    this.#stopShaderTimer();
    this.element.classList.add('is-compiling-shaders');
    this.shaderStartedAt = performance.now();
    this.statusLabel.textContent = 'Polishing the final details…';
    this.statusDetail.textContent = 'Preparing surfaces, lighting, and effects…';
    const categories = formatShaderCompileCategories(diagnostics, 5);
    const types = formatShaderMaterialTypes(diagnostics, 3);
    this.statusTech.textContent = `${backendLabel(detail.backend)} · ${diagnostics.materials} materials · ${diagnostics.renderables} renderables`
      + `${categories ? ` · ${categories}` : ''}${types ? ` · ${types}` : ''}`;
    this.percentLabel.textContent = '0.0s';
    this.#animateLogoFill(92);
    this.shaderTimer = setInterval(() => {
      const elapsedSeconds = (performance.now() - this.shaderStartedAt) / 1000;
      this.percentLabel.textContent = `${elapsedSeconds.toFixed(1)}s`;
    }, SHADER_STATUS_INTERVAL_MS);
  }

  #finishShaderCompilation(detail = {}) {
    const diagnostics = detail.diagnostics ?? { renderables: 0, materials: 0, categories: [], materialTypes: [] };
    this.#stopShaderTimer();
    this.element.classList.remove('is-compiling-shaders');
    const elapsedMs = Number(detail.elapsedMs);
    const elapsedSeconds = Number.isFinite(elapsedMs) ? elapsedMs / 1000 : 0;
    this.progressBar.style.transform = 'scaleX(.98)';
    this.percentLabel.textContent = '98%';
    this.statusLabel.textContent = 'The world is ready';
    this.statusDetail.textContent = 'Everything is in place.';
    this.statusTech.textContent = `${backendLabel(detail.backend)} · ${diagnostics.materials} materials · ${diagnostics.renderables} renderables · ${elapsedSeconds.toFixed(1)}s`;
    this.#animateLogoFill(98);
  }

  #stopShaderTimer() {
    if (this.shaderTimer !== null) clearInterval(this.shaderTimer);
    this.shaderTimer = null;
  }

  #clearShaderStatus() {
    this.#stopShaderTimer();
    this.element?.classList.remove('is-compiling-shaders');
    if (this.statusDetail) this.statusDetail.textContent = '';
    if (this.statusTech) this.statusTech.textContent = '';
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
      this.resolveStart = resolve;
      this.startButton.addEventListener('click', async () => {
        this.startButton.disabled = true;
        this.startButton.style.pointerEvents = 'none';
        this.element.style.pointerEvents = 'none';
        try {
          await onStart?.();
          if (this.element) await this.#revealScene();
        } finally {
          this.element?.remove();
          this.resolveStart = null;
          resolve();
        }
      }, { once: true });
    });
  }

  #revealScene() {
    return new Promise((resolve) => {
      this.resolveReveal = resolve;
      const startedAt = performance.now();
      const durationMs = LOADING_REVEAL_SECONDS * 1000;

      const tick = (now) => {
        if (!this.element) { resolve(); return; }
        const raw = Math.min(1, (now - startedAt) / durationMs);
        const radius = power4InOut(raw) * LOADING_REVEAL_RADIUS_VMAX;
        this.element.style.setProperty('--r', `${radius}vmax`);
        if (raw < 1) {
          this.revealAnimationFrame = requestAnimationFrame(tick);
          return;
        }
        this.revealAnimationFrame = null;
        this.resolveReveal = null;
        resolve();
      };

      this.revealAnimationFrame = requestAnimationFrame(tick);
    });
  }

  dispose() {
    this.resolveCharacter?.(this.selectedCharacterId);
    this.resolveStart?.();
    this.resolveReveal?.();
    this.resolveStart = null;
    this.resolveReveal = null;
    this.#stopShaderTimer();
    globalThis.removeEventListener?.(SHADER_COMPILE_START_EVENT, this.onShaderCompileStart);
    globalThis.removeEventListener?.(SHADER_COMPILE_END_EVENT, this.onShaderCompileEnd);
    if (this.logoAnimationFrame !== null) cancelAnimationFrame(this.logoAnimationFrame);
    if (this.revealAnimationFrame !== null) cancelAnimationFrame(this.revealAnimationFrame);
    this.element?.remove();
    this.element = null;
  }
}
