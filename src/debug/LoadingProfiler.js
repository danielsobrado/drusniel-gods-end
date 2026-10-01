// Named spans across startup, for the loading harness
// (scripts/browser/measure-loading.mjs). Spans overlap -- terrain downloads
// while the environment decodes -- so each is kept on its own and never summed
// into a "startup time". With profiling off every call is a no-op and no
// history is collected.
const noopEnd = () => {};

class LoadingProfiler {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.spans = [];
    this.marks = [];
  }

  begin(name, detail) {
    const span = { name, start: this.now(), end: null, ...(detail ? { detail } : {}) };
    this.spans.push(span);
    return (outcome) => {
      if (span.end !== null) return;
      span.end = this.now();
      if (outcome) span.outcome = outcome;
    };
  }

  async measure(name, work, detail) {
    const end = this.begin(name, detail);
    try {
      const value = await (typeof work === 'function' ? work() : work);
      end();
      return value;
    } catch (error) {
      end(error?.name === 'AbortError' ? 'aborted' : 'failed');
      throw error;
    }
  }

  mark(name) {
    this.marks.push({ name, time: this.now() });
  }

  results() {
    return {
      spans: this.spans.map((span) => ({ ...span, ms: span.end === null ? null : span.end - span.start })),
      marks: this.marks.slice(),
    };
  }
}

const disabled = {
  enabled: false,
  begin: () => noopEnd,
  measure: (_name, work) => (typeof work === 'function' ? work() : work),
  mark: () => {},
  results: () => null,
};

let active = disabled;

/** The profiler of the demo being loaded; a no-op unless one was started. */
export function loadingProfiler() {
  return active;
}

export function startLoadingProfiler(enabled) {
  active = enabled ? Object.assign(new LoadingProfiler(), { enabled: true }) : disabled;
  return active;
}
