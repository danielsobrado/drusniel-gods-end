import './styles.css';
import './loading.css';
import './cinematic.css';
import { GrassDemo } from './app/GrassDemo.js';
import { loadConfig } from './config/loadConfig.js';
import { ExplorationSpeedMode } from './player/ExplorationSpeedMode.js';
import { RendererRecovery } from './rendering/RendererRecovery.js';
import { resolveRendererRequest } from './rendering/RendererSession.js';
import { SurfaceAnisotropyController } from './rendering/SurfaceAnisotropyController.js';

async function bootstrap() {
  const root = document.querySelector('#app');
  let demo;
  let disposed = false;
  let explorationSpeedMode;
  let recovery;
  let surfaceAnisotropy;
  let unsubscribeLoss;
  const release = () => {
    unsubscribeLoss?.();
    unsubscribeLoss = null;
    surfaceAnisotropy?.dispose();
    surfaceAnisotropy = null;
    demo?.dispose();
  };
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
    explorationSpeedMode?.dispose();
    recovery?.dispose();
    release();
    window.removeEventListener('pagehide', pagehide);
  };
  window.addEventListener('pagehide', pagehide);

  try {
    const config = await loadConfig();
    if (disposed) return;
    explorationSpeedMode = new ExplorationSpeedMode({
      eventTarget: window,
      isEnabled: () => !demo?.navigation?.freeFly.active,
      onChange: ({ active, multiplier }) => {
        root.dataset.explorationSpeed = active ? String(multiplier) : '1';
        console.info(`[Exploration] ${active ? `${multiplier}x movement enabled` : 'normal movement restored'}`);
      },
    });
    const requested = resolveRendererRequest(window.location.search, config.renderer.forceWebGL);
    const start = async (backend, state) => {
      if (disposed) return;
      const runtimeConfig = state?.config ?? structuredClone(config);
      explorationSpeedMode.setConfig(runtimeConfig);
      demo = new GrassDemo(root, runtimeConfig);
      const candidate = demo;
      const anisotropyController = new SurfaceAnisotropyController(candidate);
      demo.rendererRequest = backend;
      demo.resumeState = state;
      demo.onRendererReady = (session) => {
        surfaceAnisotropy?.dispose();
        surfaceAnisotropy = anisotropyController;
        anisotropyController.apply();
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
      if (import.meta.env.DEV) {
        window.__grassDemo = demo;
        if (new URLSearchParams(window.location.search).get('profile') === '1') {
          demo.profiling = true;
        }
      }
      try {
        await candidate.start();
        if (candidate === demo && !disposed) anisotropyController.mount();
      } catch (error) {
        anisotropyController.dispose();
        if (surfaceAnisotropy === anisotropyController) surfaceAnisotropy = null;
        // A replacement owns the UI and renderer now; obsolete startup work
        // must never tear it down through bootstrap's outer failure handler.
        if (candidate !== demo || disposed) return;
        throw error;
      }
    };
    recovery = new RendererRecovery({ capture: () => explorationSpeedMode.captureSessionState(demo), release,
      restart: start, onFailure: showFailure });
    await start(requested);
  } catch (error) {
    explorationSpeedMode?.dispose();
    release();
    window.removeEventListener('pagehide', pagehide);
    if (disposed) return;
    showFailure(error);
  }
}

bootstrap();
