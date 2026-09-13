The browser package contains the complete 256 × 256 m forest viewer and only its required models and shared textures. It does not need npm packages at runtime. Extract it and run `node serve.mjs`, then open http://127.0.0.1:4174. Keep the assets and textures directories together. Opening index.html directly as a file is not supported.

The separate optimized objects archive contains 32 self-contained GLBs for reuse. These require a Meshopt decoder in GLTFLoader:

```js
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
```

Optimization preserves triangle counts, node transforms, UV seams and full position/normal precision. It welds identical vertices, reorders geometry for compression and uses Meshopt encoding. Alpha atlases remain up to 1024 pixels; ground and bark maps use up to 512 pixels. WebP color quality is 78 with full alpha quality. Original textures, Blender projects and uncompressed GLBs remain available in the authoring project.

The runtime uses content-addressed shared textures, so the main scene and tree LODs do not download separate copies. JavaScript is bundled and minified. The included server negotiates precompressed Brotli files, sends content lengths and caches hashed resources for a year. Other static hosts work with the ordinary files; configure Brotli content negotiation and the correct Content-Encoding header to obtain the same transfer savings. Do not serve .br bytes as an unencoded file.

Rebuild from the repository with `npm ci --prefix web` then `npm run build --prefix web`. Settings are in config/browser_optimization.yaml. Start the optimized viewer with `npm run preview --prefix web`, then run `npm run test:optimized --prefix web`. After verification, run `python scripts/package_browser.py`. The verification checks exact vertex attributes, instance arrays and transforms for every optimized model, then exercises all three views, movement, frustum culling and tree LODs in Chromium.

Compression reduces download size, not the number of visible triangles. The existing instancing, frustum/distance culling and tree LODs control rendering cost. WebP is decoded before GPU upload; this package does not use KTX2 GPU texture compression. Browser evidence includes the actual renderer and resource transfer sizes; software-rendered timings are not a hardware performance guarantee.
