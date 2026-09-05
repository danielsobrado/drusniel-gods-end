export class Hud {
  constructor(root, presets, initialPreset, onPresetChange) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <section class="brand-card">
        <strong>DRUSNIEL WILDS</strong>
        <span>Procedural environment</span>
      </section>
      <section class="control-card">
        <label for="preset">Weather</label>
        <select id="preset" data-preset></select>
        <div class="hint"><b>WASD</b> move · <b>Shift</b> run · drag mouse to look</div>
      </section>`;

    const select = this.root.querySelector('[data-preset]');
    for (const [key, preset] of Object.entries(presets)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = preset.label;
      option.selected = key === initialPreset;
      select.appendChild(option);
    }
    select.addEventListener('change', () => onPresetChange(select.value));
    root.appendChild(this.root);
  }

  dispose() {
    this.root.remove();
  }
}
