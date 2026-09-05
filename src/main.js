import './styles.css';
import './loading.css';
import { GrassDemo } from './app/GrassDemo.js';
import { loadConfig } from './config/loadConfig.js';

async function bootstrap() {
  const root = document.querySelector('#app');

  try {
    const config = await loadConfig();
    const demo = new GrassDemo(root, config);
    await demo.start();
  } catch (error) {
    console.error('Failed to start grass demo', error);
    root.innerHTML = '<div class="fatal">Unable to start the demo. Check the browser console.</div>';
  }
}

bootstrap();
