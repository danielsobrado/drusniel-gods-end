import {
  formatShaderCompileCategories,
  formatShaderMaterialTypes,
  SHADER_COMPILE_END_EVENT,
  SHADER_COMPILE_START_EVENT,
} from '../rendering/ShaderCompileDiagnostics.js';
import { LoadingArt } from './LoadingArt.js';
import {
  LOADING_REVEAL_RADIUS_VMAX,
  LOADING_REVEAL_SECONDS,
  LOADING_STAGES,
  power4InOut,
} from './loadingStages.js';

const LOGO_FILL_SECONDS = 1;
const SHADER_STATUS_INTERVAL_MS = 100;
// A beat at 100% so the ring visibly closes before the overlay irises away.
const AUTO_START_DELAY_MS = 900;

function power2Out(value) {
  const t = Math.max(0, Math.min(1, value));
  return 1 - (1 - t) ** 2;
}

// Small line glyphs for the roster cards, drawn on a 24px grid with currentColor
// strokes so the palette stays in CSS. Unknown ids fall back to the monogram.
const CHARACTER_ICONS = {
  drusniel: '<path d="M5 20 19 4"/><path d="M19 4c-4 1-8 5-9 9"/><path d="M5 20c1-4 5-8 9-9"/><path d="M15 4h4v4"/>',
  enanillo: '<path d="M14 10 5 19"/><path d="M11 5c3-2 7-1 9 1l-3 3c-1-1-3-2-6-4z"/><path d="M4 18l2 2"/>',
  paladin: '<path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z"/><path d="M12 8v8M9 11h6"/>',
  cleric: '<path d="M12 21V11"/><path d="M12 11C8 11 6 8 6 4c4 0 6 3 6 7z"/><path d="M12 14c3 0 5-2 6-5-3 0-5 2-6 5z"/>',
  serpent: '<path d="M7 20c-3 0-3-4 0-4h8c3 0 3-4 0-4H9c-3 0-3-4 0-4h6"/><circle cx="17" cy="8" r="2"/>',
  wizard: '<path d="M12 3 7 17h10z"/><path d="M5 17h14"/><path d="M11 10l1-2 1 2"/><path d="M8 21h8"/>',
};

function characterIcon(entry) {
  const paths = CHARACTER_ICONS[entry.id];
  if (!paths) return null;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// Wraps each capitalised word initial so the wordmark can shade D, G and E apart.
function setLogoText(element, text) {
  element.replaceChildren();
  const wrapper = document.createElement('span');
  for (const part of text.split(/(\b\p{Lu})/u)) {
    if (!part) continue;
    if (/^\p{Lu}$/u.test(part)) {
      const initial = document.createElement('span');
      initial.className = 'logo-initial';
      initial.textContent = part;
      wrapper.appendChild(initial);
    } else {
      wrapper.appendChild(document.createTextNode(part));
    }
  }
  element.appendChild(wrapper);
}

function backendLabel(value) {
  if (value === 'webgpu') return 'WebGPU';
  if (value === 'webgl2') return 'WebGL 2';
  return value || 'GPU';
}

export class LoadingUi {
  constructor(root, presentation, characterChoice = null) {
    this.logoFillPercent = 0;
    this.isReady = false;
    this.isStarting = false;
    this.onStart = null;
    this.autoStartTimer = null;
    this.characterRing = null;
    this.characterPercent = null;
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
      <div class="loading-links">
        <a class="loading-lore-link" href="https://www.drusniel.com/" target="_blank" rel="noopener noreferrer">Read about Drusniel ↗</a>
        <a class="loading-lore-link" href="https://discord.gg/pNfJPWprgB" target="_blank" rel="noopener noreferrer">Come to Discord, get the source code ↗</a>
      </div>`;
    root.appendChild(this.element);
    // Constructed after the markup so the picture is the last thing inserted but
    // the first thing painted -- its fetch starts inside the constructor.
    this.art = new LoadingArt();
    this.art.mount(this.element);
    const logoText = presentation?.title ?? 'Drusniel: Gods’ End';
    this.element.querySelectorAll('.logo-outline, .logo-fill').forEach(element => setLogoText(element, logoText));
    if (presentation) {
      this.element.classList.add('cinematic-loading');
      this.element.querySelector('.loading-logo').setAttribute('aria-label', presentation.title);
    }

    this.progressBar = this.element.querySelector('.progress-bar');
    this.percentLabel = this.element.querySelector('#percent-label');
    this.statusLabel = this.element.querySelector('#status-label');
    this.statusDetail = this.element.querySelector('#status-detail');
    this.statusTech = this.element.querySelector('#status-tech');
    this.logoFill = this.element.querySelector('.logo-fill');
    this.#createCharacterPicker();
    this.stage('initializing');
  }

  // The roster gate sits inside the loading overlay because the choice has to be
  // made before the player GLB is fetched, which is long before the world is ready.
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
        + '<span class="character-copy"><strong></strong><em></em></span>';
      const monogram = card.querySelector('.character-monogram');
      const icon = characterIcon(entry);
      if (icon) monogram.innerHTML = icon;
      else monogram.textContent = (entry.name ?? entry.id).slice(0, 1);
      card.querySelector('strong').textContent = entry.name ?? entry.id;
      card.querySelector('em').textContent = entry.title ?? '';
      if (entry.blurb) card.title = entry.blurb;
      card.addEventListener('click', () => this.#chooseCharacter(entry.id));
      this.characterList.appendChild(card);
    }

    // Loading stalls at the character stage until a card is picked, so the gate
    // carries its own headline rather than relying on the small status line.
    this.characterGate = document.createElement('section');
    this.characterGate.className = 'character-gate';
    this.characterGate.innerHTML = '<h2 class="character-prompt">Choose your character</h2>'
      + '<p class="character-hint">Loading continues once you pick one</p>';
    this.characterPrompt = this.characterGate.querySelector('.character-prompt');
    this.characterHint = this.characterGate.querySelector('.character-hint');
    this.characterGate.appendChild(this.characterList);
    this.element.insertBefore(this.characterGate, this.element.querySelector('.loading-links'));
    const preselected = this.characterChoice?.selectedId;
    if (preselected) this.#chooseCharacter(preselected);
  }

  #chooseCharacter(id) {
    if (this.selectedCharacterId) return;
    this.selectedCharacterId = id;
    this.characterList.classList.add('is-locked');
    this.element.classList.remove('is-awaiting-character');
    this.characterGate.classList.add('is-locked');
    let chosenName = id;
    let chosenCard = null;
    // The unpicked travellers leave the screen entirely rather than dimming: past
    // this point the gate is a progress readout for one character, not a choice.
    for (const card of this.characterList.querySelectorAll('.character-card')) {
      const chosen = card.dataset.characterId === id;
      card.setAttribute('aria-checked', String(chosen));
      card.classList.toggle('is-chosen', chosen);
      card.disabled = true;
      if (!chosen) card.remove();
      else {
        chosenCard = card;
        chosenName = card.querySelector('strong').textContent;
      }
    }
    if (chosenCard) this.#mountCharacterRing(chosenCard);
    this.characterPrompt.textContent = `Traveling as ${chosenName}`;
    this.characterHint.textContent = '';
    this.resolveCharacter(id);
  }

  // The dial rides beside the chosen card and becomes the screen's main readout.
  // `pathLength` normalises the circumference to 100, so the dash offset is the
  // percentage itself and the radius can change in CSS without touching this.
  #mountCharacterRing(card) {
    const ring = document.createElement('span');
    ring.className = 'character-progress';
    ring.innerHTML = '<svg viewBox="0 0 120 120" aria-hidden="true">'
      + '<circle class="character-ring-track" cx="60" cy="60" r="52" pathLength="100"/>'
      + '<circle class="character-ring-fill" cx="60" cy="60" r="52" pathLength="100"/>'
      + '</svg><span class="character-percent">0%</span>';
    card.appendChild(ring);
    this.characterRing = ring.querySelector('.character-ring-fill');
    this.characterPercent = ring.querySelector('.character-percent');
    this.#setCharacterRing(this.logoFillPercent);
  }

  #setCharacterRing(percent) {
    if (!this.characterRing) return;
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    this.characterRing.style.strokeDashoffset = String(100 - clamped);
    this.characterPercent.textContent = `${Math.round(clamped)}%`;
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
    if (name === 'character' && this.needsCharacterChoice()) {
      this.element.classList.add('is-awaiting-character');
      this.characterGate.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
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
    this.#setCharacterRing(percent);

    if (percent >= 100) {
      this.element.classList.add('is-ready');
      this.isReady = true;
      this.#tryAutoStart();
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
    this.#setCharacterRing(92);
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
    this.#setCharacterRing(98);
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

  // No gate button any more: the overlay hands itself over as soon as the ring
  // closes. `ready` is reached before this is awaited, so the 100% mark latches
  // and whichever of the two lands last fires the entry.
  async waitForStart(onStart) {
    if (!this.element?.isConnected) return;

    await new Promise((resolve) => {
      this.resolveStart = resolve;
      this.onStart = onStart ?? (() => {});
      this.#tryAutoStart();
    });
  }

  #tryAutoStart() {
    if (!this.isReady || !this.onStart || this.isStarting) return;
    if (this.autoStartTimer !== null) return;
    this.autoStartTimer = setTimeout(() => {
      this.autoStartTimer = null;
      this.#enterScene();
    }, AUTO_START_DELAY_MS);
  }

  async #enterScene() {
    if (this.isStarting || !this.element) return;
    this.isStarting = true;
    const onStart = this.onStart;
    this.onStart = null;
    this.element.classList.add('is-starting');
    this.element.style.pointerEvents = 'none';
    this.statusLabel.textContent = 'Entering Gods’ End…';
    try {
      await onStart?.();
      if (this.element) await this.#revealScene();
    } finally {
      // Stops the ember loop before the frame budget belongs to the scene.
      this.art?.dispose();
      this.art = null;
      this.element?.remove();
      const resolve = this.resolveStart;
      this.resolveStart = null;
      resolve?.();
    }
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
    if (this.autoStartTimer !== null) clearTimeout(this.autoStartTimer);
    this.autoStartTimer = null;
    this.onStart = null;
    this.#stopShaderTimer();
    globalThis.removeEventListener?.(SHADER_COMPILE_START_EVENT, this.onShaderCompileStart);
    globalThis.removeEventListener?.(SHADER_COMPILE_END_EVENT, this.onShaderCompileEnd);
    if (this.logoAnimationFrame !== null) cancelAnimationFrame(this.logoAnimationFrame);
    if (this.revealAnimationFrame !== null) cancelAnimationFrame(this.revealAnimationFrame);
    this.art?.dispose();
    this.art = null;
    this.element?.remove();
    this.element = null;
  }
}
