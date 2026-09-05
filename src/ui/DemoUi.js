const DEFAULT_CONTROL_RANGES = Object.freeze({
  windStrength: { min: 0, max: 3, step: 0.1 },
  grassHeight: { min: 0.5, max: 3, step: 0.1 },
  simulationSpeed: { min: 0, max: 2, step: 0.05 },
  pixelRatio: { min: 0.5, max: 2, step: 0.25 },
});

const PRESET_LABEL_OVERRIDES = Object.freeze({
  bowed: 'Bowed (Only Blades)',
  moonlight: 'Moon Light',
});

function range(config, name) {
  return config.ui.controls?.[name] ?? DEFAULT_CONTROL_RANGES[name];
}

function rangeInput(name, value, limits, attributes) {
  return `
    <div class="control-range">
      <input type="range" min="${limits.min}" max="${limits.max}" step="${limits.step}" value="${value}" ${attributes}>
      <output data-output="${name}">${value}</output>
    </div>`;
}

function presetLabel(key, preset) {
  return PRESET_LABEL_OVERRIDES[key] ?? preset.label;
}

function choiceControl(name, label, options, selectedValue) {
  const selected = options.find((option) => option.value === selectedValue) ?? options[0];
  const buttons = options.map((option) => `
    <button type="button" class="choice-option ${option.value === selectedValue ? 'is-active' : ''}"
      data-choice-option="${name}" data-value="${option.value}">${option.label}</button>`).join('');

  return `
    <div class="choice-field" data-choice-field="${name}">
      <span class="control-label">${label}</span>
      <button type="button" class="choice-trigger" data-choice-trigger="${name}" aria-expanded="false">
        <span data-choice-value="${name}">${selected.label}</span><span class="choice-caret" aria-hidden="true">⌄</span>
      </button>
      <div class="choice-menu" data-choice-menu="${name}" hidden>${buttons}</div>
    </div>`;
}

export class DemoUi {
  constructor(root, config, actions) {
    this.config = config;
    this.actions = actions;
    this.frames = 0;
    this.elapsed = 0;
    this.fps = 0;
    this.currentPreset = config.ui.initialPreset;
    this.currentGrassType = config.grass.type;
    this.painterButton = null;
    this.abortController = new AbortController();
    this.element = this.#create(root);
  }

  #create(root) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const presetOptions = Object.entries(this.config.presets).map(([key, preset]) => ({
      value: key,
      label: presetLabel(key, preset),
    }));
    const grassOptions = [
      { value: 'blade', label: 'Blade' },
      { value: 'billboard', label: 'Billboard' },
    ];
    const qualityOptions = Object.entries(this.config.quality).map(([key, quality]) => ({
      value: key,
      label: quality.label,
    }));
    const initialPreset = this.config.presets[this.currentPreset];
    const initialGrass = initialPreset.grass[this.currentGrassType] ?? initialPreset.grass.blade;
    const pixelRatio = this.actions.getPixelRatio?.()
      ?? this.config.ui.pixelRatio
      ?? Math.min(window.devicePixelRatio, this.config.renderer.pixelRatioCap);
    const interactionEnabled = this.config.grass.interaction.enabled !== false;

    overlay.innerHTML = `
      <button class="mobile-panel-toggle" type="button" data-panel-toggle aria-expanded="false">Controls</button>
      <section class="controls panel" data-controls-panel>
        <strong class="controls-title">Controls</strong>
        ${choiceControl('preset', 'Preset', presetOptions, this.currentPreset)}
        ${choiceControl('grassType', 'Grass Type', grassOptions, this.currentGrassType)}
        ${choiceControl('quality', 'Quality', qualityOptions, this.config.ui.initialQuality)}
        <label>Wind Strength${rangeInput('windStrength', initialGrass.windIntensity, range(this.config, 'windStrength'), 'data-grass-param="windIntensity"')}</label>
        <label>Grass Height${rangeInput('grassHeight', initialGrass.bladeHeight, range(this.config, 'grassHeight'), 'data-grass-param="bladeHeight"')}</label>
        <label>Simulation Speed${rangeInput('simulationSpeed', initialGrass.simulationSpeed, range(this.config, 'simulationSpeed'), 'data-grass-param="simulationSpeed"')}</label>
        <label>Pixel Ratio${rangeInput('pixelRatio', pixelRatio, range(this.config, 'pixelRatio'), 'data-pixel-ratio')}</label>
        <label class="toggle-row"><span>Foot Interaction</span><input data-interaction type="checkbox" ${interactionEnabled ? 'checked' : ''}></label>
        <button class="tool-button" type="button" data-painter>Grass Painter</button>
      </section>
      <section class="metrics ${this.config.ui.showStats ? '' : 'hidden'}">
        <span>FPS <strong data-fps>0</strong></span>
        <span>TRIS <strong data-triangles>0</strong></span>
      </section>
      <section class="reference-hud" aria-label="Demo controls">
        <div class="reference-brand"><strong>THREEJS RPG GRASS</strong><span>DEMO</span></div>
        <div class="control-hints">
          <div><strong>MOUSE</strong><span>Look around</span></div>
          <div><strong>WASD</strong><span>Walk</span></div>
          <div><strong>SHIFT</strong><span>Run</span></div>
        </div>
      </section>`;

    root.appendChild(overlay);
    this.#bind(overlay);
    return overlay;
  }

  #bind(overlay) {
    const { signal } = this.abortController;
    const controlsPanel = overlay.querySelector('[data-controls-panel]');
    const panelToggle = overlay.querySelector('[data-panel-toggle]');
    panelToggle.addEventListener('click', () => {
      const open = controlsPanel.classList.toggle('mobile-open');
      panelToggle.setAttribute('aria-expanded', String(open));
    }, { signal });

    overlay.querySelectorAll('[data-choice-trigger]').forEach((trigger) => {
      trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        this.#toggleChoice(overlay, trigger.dataset.choiceTrigger);
      }, { signal });
    });

    overlay.querySelectorAll('[data-choice-option]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.#selectChoice(overlay, button.dataset.choiceOption, button.dataset.value);
      }, { signal });
    });

    window.addEventListener('pointerdown', (event) => {
      if (event.target.closest?.('[data-choice-field]')) return;
      this.#closeChoices(overlay);
    }, { signal });

    overlay.querySelectorAll('[data-grass-param]').forEach((input) => {
      input.addEventListener('input', () => {
        this.#setOutput(overlay, input, input.value);
        this.actions.setGrassParameter(input.dataset.grassParam, Number(input.value));
      }, { signal });
    });

    const pixelRatio = overlay.querySelector('[data-pixel-ratio]');
    pixelRatio.addEventListener('input', () => {
      this.#setOutput(overlay, pixelRatio, pixelRatio.value);
      this.actions.setPixelRatio(Number(pixelRatio.value));
    }, { signal });

    overlay.querySelector('[data-interaction]').addEventListener('change', (event) => {
      this.actions.setInteractionEnabled(event.target.checked);
    }, { signal });

    this.painterButton = overlay.querySelector('[data-painter]');
    this.painterButton.addEventListener('click', () => {
      const enabled = this.actions.togglePainter();
      this.painterButton.classList.toggle('active', enabled);
    }, { signal });
  }

  #toggleChoice(overlay, name) {
    const menu = overlay.querySelector(`[data-choice-menu="${name}"]`);
    const trigger = overlay.querySelector(`[data-choice-trigger="${name}"]`);
    const willOpen = menu.hidden;
    this.#closeChoices(overlay);
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
  }

  #closeChoices(overlay) {
    overlay.querySelectorAll('[data-choice-menu]').forEach((menu) => {
      menu.hidden = true;
    });
    overlay.querySelectorAll('[data-choice-trigger]').forEach((trigger) => {
      trigger.setAttribute('aria-expanded', 'false');
    });
  }

  #selectChoice(overlay, name, value) {
    const option = overlay.querySelector(`[data-choice-option="${name}"][data-value="${value}"]`);
    const valueElement = overlay.querySelector(`[data-choice-value="${name}"]`);
    if (!option || !valueElement) return;

    valueElement.textContent = option.textContent;
    overlay.querySelectorAll(`[data-choice-option="${name}"]`).forEach((button) => {
      button.classList.toggle('is-active', button === option);
    });
    this.#closeChoices(overlay);

    if (name === 'preset') {
      this.currentPreset = value;
      this.actions.setPreset(value);
      this.#syncPresetControls(overlay);
      return;
    }
    if (name === 'grassType') {
      this.currentGrassType = value;
      this.actions.setGrassType(value);
      this.#syncPresetControls(overlay);
      return;
    }
    if (name === 'quality') this.actions.setQuality(value);
  }

  #setOutput(overlay, input, value) {
    const name = input.closest('.control-range')?.querySelector('output')?.dataset.output;
    if (!name) return;
    overlay.querySelector(`[data-output="${name}"]`).textContent = value;
  }

  #syncPresetControls(overlay) {
    const preset = this.config.presets[this.currentPreset];
    const grass = preset.grass[this.currentGrassType] ?? preset.grass.blade;
    const values = {
      windIntensity: grass.windIntensity,
      bladeHeight: grass.bladeHeight,
      simulationSpeed: grass.simulationSpeed,
    };

    for (const [name, value] of Object.entries(values)) {
      const input = overlay.querySelector(`[data-grass-param="${name}"]`);
      if (!input) continue;
      input.value = value;
      this.#setOutput(overlay, input, value);
    }
  }

  update(deltaSeconds) {
    const painterEnabled = this.actions.isPainterEnabled?.() ?? false;
    this.painterButton?.classList.toggle('active', painterEnabled);

    if (!this.config.ui.showStats) return;
    this.frames += 1;
    this.elapsed += deltaSeconds;
    if (this.elapsed < 0.5) return;
    this.fps = Math.round(this.frames / this.elapsed);
    this.frames = 0;
    this.elapsed = 0;
    this.element.querySelector('[data-fps]').textContent = this.fps;
    this.element.querySelector('[data-triangles]').textContent = this.actions.getTriangleCount().toLocaleString();
  }

  dispose() {
    this.abortController.abort();
    this.element?.remove();
    this.element = null;
    this.painterButton = null;
  }
}
