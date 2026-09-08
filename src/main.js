import './styles.css';
import './loading.css';
import './cinematic.css';
import { GrassDemo } from './app/GrassDemo.js';
import { loadConfig } from './config/loadConfig.js';
import { RendererRecovery } from './rendering/RendererRecovery.js';
import { resolveRendererRequest } from './rendering/RendererSession.js';

async function bootstrap() {
  const root = document.querySelector('#app');
  let demo;
  let disposed = false;
  let recovery;
  let unsubscribeLoss;
  const release = () => { unsubscribeLoss?.(); unsubscribeLoss = null; demo?.dispose(); };
  const showFailure = (error) => {
    console.error('Failed to start grass demo', error);
    root.textContent = '';
    const element = document.createElement('div');
    element.className = 'fatal';
    element.textContent = `Unable to start the demo: ${error.message}`;
    root.appendChild(element);
  };
  const pagehide = (event) => {
    if (event.persisted) return;
    disposed = true;
    recovery?.dispose();
    release();
    window.removeEventListener('pagehide', pagehide);
  };
  window.addEventListener('pagehide', pagehide);

  try {
    const config = await loadConfig();
    if (disposed) return;
    const requested = resolveRendererRequest(window.location.search, config.renderer.forceWebGL);
    const start = async (backend, state) => {
      if (disposed) return;
      demo = new GrassDemo(root, state?.config ?? structuredClone(config));
      const candidate = demo;
      demo.rendererRequest = backend;
      demo.resumeState = state;
      demo.onRendererReady = (session) => {
        root.dataset.renderer = session.diagnostics.actual;
        console.info('[Renderer]', session.diagnostics);
        unsubscribeLoss = session.subscribeDeviceLoss((info) => {
          if (recovery.pending) {
            // This is the replacement's device: the old session unsubscribed
            // during release. Abort its startup so recovery tries the fallback.
            candidate.dispose();
            return;
          }
          void recovery.recover(requested, session.diagnostics.actual, info);
        });
      };
      if (import.meta.env.DEV) window.__grassDemo = demo;
      try {
        await candidate.start();
      } catch (error) {
        // A replacement owns the UI and renderer now; obsolete startup work
        // must never tear it down through bootstrap's outer failure handler.
        if (candidate !== demo || disposed) return;
        throw error;
      }
    };
    recovery = new RendererRecovery({ capture: () => demo.captureSessionState(), release,
      restart: start, onFailure: showFailure });
    await start(requested);
  } catch (error) {
    release();
    window.removeEventListener('pagehide', pagehide);
    if (disposed) return;
    showFailure(error);
  }
}

bootstrap();
