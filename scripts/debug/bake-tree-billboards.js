import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

window.__billboardBaker = (async () => {
  const renderer = new THREE.WebGPURenderer({ alpha: true, antialias: true });
  await renderer.init();
  renderer.setPixelRatio(1); renderer.setClearColor(0, 0);
  document.body.appendChild(renderer.domElement);
  const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader().setDRACOLoader(draco);
  let scene, high, mesh, positions, uv, width, height;
  return {
    async load(type) {
      const gltf = await loader.loadAsync(`/Assets/terrain/fantasy/tree${type}.glb?bake=${Date.now()}`);
      high = gltf.scene.getObjectByName(`Tree${type}_High`);
      const low = gltf.scene.getObjectByName(`Tree${type}_Low`);
      high.position.set(0, 0, 0); low.position.set(0, 0, 0);
      gltf.scene.updateMatrixWorld(true);
      low.traverse(o => { if (o.isMesh) mesh = o; });
      positions = mesh.geometry.attributes.position.array.slice();
      uv = mesh.geometry.attributes.uv;
      const image = mesh.material.map.image;
      width = image.width; height = image.height;
      high.traverse(o => {
        if (!o.isMesh) return;
        // The alpine conifers carry their colour in the vertices.
        o.material = new THREE.MeshBasicNodeMaterial({ map: o.material.map, color: o.material.color,
          vertexColors: o.material.vertexColors, side: THREE.DoubleSide, alphaTest: o.material.alphaTest || 0, transparent: false });
      });
      scene = new THREE.Scene(); scene.add(high); scene.updateMatrixWorld(true);
      return { width, height };
    },
    async render(side) {
      // The authored low meshes contain two four-vertex atlas cards.
      const groups = [];
      const indices = mesh.geometry.index.array;
      for (let i=0;i<indices.length;i+=3) {
        const triangle = [indices[i],indices[i+1],indices[i+2]];
        const touching = groups.filter(group => triangle.some(vertex => group.has(vertex)));
        const combined = new Set([...triangle,...touching.flatMap(group=>[...group])]);
        for (const group of touching) groups.splice(groups.indexOf(group),1);
        groups.push(combined);
      }
      groups.sort((a,b)=>[...a].reduce((sum,i)=>sum+uv.getX(i),0)/a.size-[...b].reduce((sum,i)=>sum+uv.getX(i),0)/b.size);
      const ids = [...groups[side]];
      if (ids.length !== 4) throw new Error(`Expected four billboard corners, got ${ids.length}`);
      const u0 = Math.min(...ids.map(i => uv.getX(i))), u1 = Math.max(...ids.map(i => uv.getX(i)));
      const v0 = Math.min(...ids.map(i => uv.getY(i))), v1 = Math.max(...ids.map(i => uv.getY(i)));
      const corner = (u, v) => {
        const i = ids.reduce((best, j) => Math.hypot(uv.getX(j)-u, uv.getY(j)-v) < Math.hypot(uv.getX(best)-u, uv.getY(best)-v) ? j : best);
        return new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i).applyMatrix4(mesh.matrixWorld);
      };
      const topLeft = corner(u0, v0);
      const right = corner(u1, v0).sub(topLeft).normalize();
      // Pin the card's up axis to world up. Deriving it from the card's UV
      // layout made the atlas and the rewritten corners self-consistent for
      // either V convention, but the generators disagree on that convention,
      // so every billboard type rendered upside down.
      const up = new THREE.Vector3(0, 1, 0);
      const normal = new THREE.Vector3().crossVectors(right, up).normalize();
      const box = new THREE.Box3().setFromObject(high), corners = [];
      for (const x of [box.min.x,box.max.x]) for (const y of [box.min.y,box.max.y]) for (const z of [box.min.z,box.max.z]) corners.push(new THREE.Vector3(x,y,z));
      const r0 = Math.min(...corners.map(p=>p.dot(right))), r1 = Math.max(...corners.map(p=>p.dot(right)));
      const t0 = Math.min(...corners.map(p=>p.dot(up))), t1 = Math.max(...corners.map(p=>p.dot(up)));
      // Leave a transparent gutter inside each card: the two cards share the
      // u=0.5 seam, and bilinear filtering at the edge otherwise bleeds the
      // neighbouring card's column in as a vertical line through the tree.
      const gutter = 3;
      const cardWidth = Math.round(u1*width)-Math.round(u0*width), cardHeight = Math.round(v1*height)-Math.round(v0*height);
      const w = (r1-r0)*1.02*cardWidth/(cardWidth-2*gutter), h = (t1-t0)*1.02*cardHeight/(cardHeight-2*gutter);
      const center = right.clone().multiplyScalar((r0+r1)/2).addScaledVector(up,(t0+t1)/2);
      const camera = new THREE.OrthographicCamera(-w/2,w/2,h/2,-h/2,0.1,1000);
      camera.position.copy(center).addScaledVector(normal,300); camera.up.copy(up); camera.lookAt(center);
      const inverse = mesh.matrixWorld.clone().invert();
      for (const i of ids) {
        const p = center.clone().addScaledVector(right, ((uv.getX(i)-u0)/(u1-u0)-0.5)*w)
          .addScaledVector(up, (0.5-(uv.getY(i)-v0)/(v1-v0))*h).applyMatrix4(inverse);
        p.toArray(positions,i*3);
      }
      const left=Math.round(u0*width), top=Math.round(v0*height);
      const pixelWidth=Math.round(u1*width)-left, pixelHeight=Math.round(v1*height)-top;
      renderer.setSize(pixelWidth,pixelHeight);
      await renderer.compileAsync(scene,camera);
      renderer.render(scene,camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      // UVs travel with the positions so the embed can match corners by UV:
      // this runtime (draco-decoded) vertex order differs from the authored one.
      return {left,top,positions:Array.from(positions),uvs:Array.from(uv.array)};
    },
  };
})();
