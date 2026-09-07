/** One bounded recovery sequence per page; repeated device failure cannot loop. */
export class RendererRecovery {
  constructor({ capture, release, restart, onFailure }) {
    this.capture = capture;
    this.release = release;
    this.restart = restart;
    this.onFailure = onFailure;
    this.pending = null;
    this.attempts = 0;
    this.disposed = false;
  }

  recover(request, actual, info) {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    // Publish before capture/release can synchronously raise another loss.
    let resolve;
    let reject;
    const pending = new Promise((done, failed) => { resolve = done; reject = failed; });
    this.pending = pending;
    void this.#recover(request, actual, info).then(
      () => { this.pending = null; resolve(); },
      error => { this.pending = null; reject(error); },
    );
    return pending;
  }

  async #recover(request, actual, info) {
    const errors = [];
    const release = () => {
      try { this.release(); return true; }
      catch (error) { errors.push(error); return false; }
    };
    const report = (reason = 'Renderer recovery failed.') => {
      if (!this.disposed) this.onFailure(new AggregateError(errors, reason), info);
    };
    if (this.attempts >= 2) {
      release(); report('Renderer recovery budget exhausted. Reload to retry.'); return;
    }
    let state;
    try { state = this.capture(); }
    catch (error) { errors.push(error); release(); report(); return; }
    if (!release()) { report(); return; }
    const backends = actual === 'webgpu' ? ['webgpu'] : ['webgl'];
    if (request === 'auto' && actual === 'webgpu') backends.push('webgl');
    for (const backend of backends) {
      if (this.disposed || this.attempts >= 2) break;
      this.attempts++;
      try { await this.restart(backend, state); }
      catch (error) {
        errors.push(error);
        if (!release()) break;
        continue;
      }
      if (this.disposed) release();
      return;
    }
    report();
  }

  dispose() { this.disposed = true; }
}
