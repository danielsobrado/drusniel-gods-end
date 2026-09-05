export class GrassPainterUi {
  constructor({ brushRadius, height, onClose, onMode, onBrushRadius, onHeight, onClear, onSave }) {
    this.callbacks = { onClose, onMode, onBrushRadius, onHeight, onClear, onSave };
    this.element = document.createElement('div');
    this.element.id = 'grass-painter-ui';
    this.element.className = 'grass-painter-ui';
    this.element.innerHTML = `
      <div class="grass-painter-header">
        <div>
          <div class="grass-painter-kicker">Terrain Tool</div>
          <div class="grass-painter-title">Grass Painter</div>
        </div>
        <button id="painter-close" class="grass-painter-close" type="button">×</button>
      </div>
      <div class="grass-painter-section">
        <div class="grass-painter-label">Brush Mode</div>
        <div class="grass-painter-row">
          <button id="painter-add" class="grass-painter-mode" data-mode="add" type="button">Add Grass</button>
          <button id="painter-erase" class="grass-painter-mode" data-mode="erase" type="button">Erase</button>
        </div>
      </div>
      <div class="grass-painter-section grass-painter-control">
        <label><span>Brush Size</span><strong id="painter-size-val">${brushRadius}</strong></label>
        <input type="range" id="painter-size" min="1" max="100" value="${brushRadius}">
      </div>
      <div class="grass-painter-section grass-painter-control">
        <label><span>Blade Height</span><strong id="painter-height-val">${height}</strong></label>
        <input type="range" id="painter-height" min="1" max="10" value="${height}">
        <div class="grass-painter-scale"><span>Short</span><span>Tall</span></div>
      </div>
      <div class="grass-painter-actions">
        <button id="painter-clear" class="grass-painter-clear" type="button">Clear All</button>
        <button id="painter-download" class="grass-painter-save" type="button">Save Mask</button>
      </div>
      <div class="grass-painter-help">
        <div><kbd>LMB</kbd><span>Paint</span></div>
        <div><kbd>RMB</kbd><span>Rotate view</span></div>
        <div><kbd>⇧ RMB</kbd><span>Pan view</span></div>
        <div><kbd>MMB</kbd><span>Zoom</span></div>
        <div><kbd>[ ]</kbd><span>Resize brush</span></div>
        <div><kbd>1 / 2</kbd><span>Change mode</span></div>
      </div>`;
    document.body.appendChild(this.element);
    this.#bind();
    this.setMode('add');
    this.setVisible(false);
  }

  #bind() {
    this.element.querySelector('#painter-close').addEventListener('click', () => this.callbacks.onClose?.());
    this.element.querySelector('#painter-add').addEventListener('click', () => this.callbacks.onMode?.('add'));
    this.element.querySelector('#painter-erase').addEventListener('click', () => this.callbacks.onMode?.('erase'));

    const size = this.element.querySelector('#painter-size');
    size.addEventListener('input', () => this.callbacks.onBrushRadius?.(Number(size.value)));

    const height = this.element.querySelector('#painter-height');
    height.addEventListener('input', () => this.callbacks.onHeight?.(Number(height.value)));

    this.element.querySelector('#painter-clear').addEventListener('click', () => {
      if (window.confirm('Clear entire grass mask?')) this.callbacks.onClear?.();
    });
    this.element.querySelector('#painter-download').addEventListener('click', () => this.callbacks.onSave?.());
  }

  setVisible(visible) {
    this.element.style.display = visible ? 'block' : 'none';
  }

  setMode(mode) {
    for (const button of this.element.querySelectorAll('.grass-painter-mode')) {
      button.classList.toggle('is-active', button.dataset.mode === mode);
    }
  }

  setBrushRadius(value) {
    this.element.querySelector('#painter-size-val').textContent = value;
    this.element.querySelector('#painter-size').value = value;
  }

  setHeight(value) {
    this.element.querySelector('#painter-height-val').textContent = value;
    this.element.querySelector('#painter-height').value = value;
  }

  dispose() {
    this.element?.remove();
    this.element = null;
    this.callbacks = null;
  }
}
