import * as THREE from 'three';
import {assetLoader,assetUrl} from './asset-loader.js';

export function elevation(x,z) {
  const y=-z;
  return .065*(y+10)+.36*Math.sin(x*.15)*Math.cos(y*.12)+.12*Math.sin(y*.3);
}

export async function createForestWorld(gltf, config) {
  const root=new THREE.Group(), catalog=new Map(), geometryAssets=new Map(), materials=new Map();
  const chunks=new Map(), batches=new Map(), seen=new Set();
  let sourceCount=0, seed=config.seed;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const matrix=new THREE.Matrix4(), position=new THREE.Vector3(), rotation=new THREE.Quaternion(), scale=new THREE.Vector3();
  const up=new THREE.Vector3(0,1,0);
  const kindOf=asset=>asset.replace(/_\d+$/,'');
  async function register(source) {
    for(let i=0;i<source.parser.json.meshes.length;i++) {
      const asset=source.parser.json.meshes[i].name;
      const object=await source.parser.getDependency('mesh',i);
      const parts=[];
      object.traverse(mesh=>{
        if(!mesh.isMesh)return;
        if(materials.has(mesh.material.name)) mesh.material=materials.get(mesh.material.name);
        else materials.set(mesh.material.name,mesh.material);
        parts.push({geometry:mesh.geometry,material:mesh.material});
        geometryAssets.set(mesh.geometry.uuid,asset);
      });
      const bounds=new THREE.Box3();
      for(const part of parts){part.geometry.computeBoundingBox();bounds.union(part.geometry.boundingBox);}
      catalog.set(asset,{parts,size:bounds.getSize(new THREE.Vector3()),sphere:bounds.getBoundingSphere(new THREE.Sphere())});
    }
  }
  await register(gltf);
  const loader=assetLoader();
  const lods=await Promise.all([1,2,3].map(i=>loader.loadAsync(assetUrl(`objects/tree_lod_0${i}`))));
  for(const lod of lods) await register(lod);
  function add(asset, transform) {
    const x=transform.elements[12], y=transform.elements[13], z=transform.elements[14];
    const key=`${Math.floor(x/config.chunk_size)},${Math.floor(z/config.chunk_size)}`;
    if(!chunks.has(key)) {
      const cx=Math.floor(x/config.chunk_size)*config.chunk_size,cz=Math.floor(z/config.chunk_size)*config.chunk_size;
      const heights=[elevation(cx,cz),elevation(cx+config.chunk_size,cz),elevation(cx,cz+config.chunk_size),elevation(cx+config.chunk_size,cz+config.chunk_size)];
      chunks.set(key,{records:[],bounds:new THREE.Box3(),groundBounds:new THREE.Box3(new THREE.Vector3(cx,Math.min(...heights)-1,cz),new THREE.Vector3(cx+config.chunk_size,Math.max(...heights)+1,cz+config.chunk_size)),lod:false});
    }
    const chunk=chunks.get(key), padding=Math.max(2,catalog.get(asset).size.length()*.8);
    chunk.bounds.expandByPoint(new THREE.Vector3(x-padding,y-padding,z-padding));
    chunk.bounds.expandByPoint(new THREE.Vector3(x+padding,y+padding,z+padding));
    const sphere=catalog.get(asset).sphere.clone().applyMatrix4(transform);
    sphere.radius+=.05;
    chunk.records.push({asset,kind:kindOf(asset),matrix:new Float32Array(transform.elements),sphere,lod:false});
    sourceCount++;
  }
  gltf.scene.updateMatrixWorld(true);
  const statics=[];
  gltf.scene.traverse(mesh=>{
    if(!mesh.isMesh)return;
    const asset=geometryAssets.get(mesh.geometry.uuid);
    if(!asset)throw Error(`Unmapped scene geometry: ${mesh.name}`);
    if(asset==='ForestFloor'||asset==='ForestPath') {statics.push(mesh);return;}
    const count=mesh.isInstancedMesh?mesh.count:1;
    if(mesh.isInstancedMesh)mesh.getMatrixAt(0,matrix);else matrix.identity();
    const key=asset+':'+count+':'+matrix.elements.join(',')+':'+mesh.matrixWorld.elements.join(',');
    if(seen.has(key))return;
    seen.add(key);
    for(let i=0;i<count;i++) {
      if(mesh.isInstancedMesh)mesh.getMatrixAt(i,matrix);else matrix.identity();
      matrix.premultiply(mesh.matrixWorld);
      add(asset,matrix);
    }
  });
  for(const mesh of statics)root.attach(mesh);
  const choose=prefix=>[...catalog.keys()].filter(key=>key.startsWith(prefix+'_'));
  const grass=choose('grass'), cover=choose('groundcover'), understory=[...choose('fern'),...choose('broadleaf'),...choose('palm')];
  for(let x=-config.extent;x<config.extent;x+=config.chunk_size) {
    for(let z=-config.extent;z<config.extent;z+=config.chunk_size) {
      for(const [assets,count] of [[grass,config.grass_per_chunk],[cover,config.groundcover_per_chunk],[understory,config.undergrowth_per_chunk]]) {
        for(let i=0;i<count;i++) {
          const px=x+random()*config.chunk_size,pz=z+random()*config.chunk_size;
          if(Math.abs(px)<config.plant_extent&&Math.abs(pz)<config.plant_extent)continue;
          if(Math.abs(px-1.8*Math.sin(-pz*.11))<.5)continue;
          const asset=assets[Math.floor(random()*assets.length)],s=.65+random()*.65;
          matrix.compose(position.set(px,elevation(px,pz),pz),rotation.setFromAxisAngle(up,random()*Math.PI*2),scale.set(s,s,s));
          add(asset,matrix);
        }
      }
    }
  }
  for(const [asset,entry] of catalog) {
    if(asset==='ForestFloor'||asset==='ForestPath')continue;
    const meshes=entry.parts.map(part=>{
      const mesh=new THREE.InstancedMesh(part.geometry,part.material,config.max_instances_per_asset);
      mesh.name=asset;mesh.count=0;mesh.frustumCulled=false;mesh.receiveShadow=true;
      mesh.castShadow=!asset.startsWith('grass')&&!asset.startsWith('groundcover');
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);root.add(mesh);return mesh;
    });
    batches.set(asset,{meshes,count:0});
  }
  const cells=[...chunks.values()];
  for(const cell of cells)cell.center=cell.bounds.getCenter(new THREE.Vector3());
  const frustum=new THREE.Frustum(),projection=new THREE.Matrix4(),oldPosition=new THREE.Vector3(Infinity,Infinity,Infinity),oldRotation=new THREE.Quaternion();
  let stats={sourceInstances:sourceCount,totalChunks:cells.length,visibleInstances:0,visibleChunks:0,lodInstances:0,capacityDrops:0};
  function update(camera,force=false) {
    if(!force&&camera.position.distanceToSquared(oldPosition)<.04&&1-Math.abs(camera.quaternion.dot(oldRotation))<.00002)return stats;
    oldPosition.copy(camera.position);oldRotation.copy(camera.quaternion);
    camera.updateMatrixWorld();frustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
    for(const batch of batches.values())batch.count=0;
    stats={sourceInstances:sourceCount,totalChunks:cells.length,visibleInstances:0,visibleChunks:0,lodInstances:0,capacityDrops:0,byKind:{},cameraPosition:camera.position.toArray(),revision:(stats.revision||0)+1};
    const visible=cells.filter(cell=>frustum.intersectsBox(cell.bounds));
    visible.sort((a,b)=>a.center.distanceToSquared(camera.position)-b.center.distanceToSquared(camera.position));
    for(const cell of visible) {
      const distance=cell.groundBounds.distanceToPoint(camera.position);
      if(distance>config.tree_distance)continue;
      stats.visibleChunks++;
      cell.lod=distance>config.tree_lod_distance+(cell.lod?-4:4);
      for(const record of cell.records) {
        if(!frustum.intersectsSphere(record.sphere))continue;
        const tree=['tree','background_tree'].includes(record.kind);
        const tall=tree||record.kind.startsWith('palm');
        const limit=record.kind==='grass'?config.grass_distance:record.kind==='groundcover'?config.groundcover_distance: tall?config.tree_distance:config.undergrowth_distance;
        const actualDistance=Math.hypot(record.matrix[12]-camera.position.x,record.matrix[13]-camera.position.y,record.matrix[14]-camera.position.z);
        if(actualDistance>limit+(tree?record.sphere.radius:1))continue;
        // Stable thinning retains nearby grass and avoids drawing dense distant cards.
        const fraction=record.matrix[12]*13-Math.floor(record.matrix[12]*13);
        if(record.kind==='grass'&&actualDistance>14&&fraction>THREE.MathUtils.lerp(1,.2,THREE.MathUtils.smoothstep(actualDistance,14,config.grass_distance)))continue;
        let asset=record.asset;
        matrix.fromArray(record.matrix);
        record.lod=actualDistance>config.tree_lod_distance+(record.lod?-4:4);
        if(tree&&record.lod) {
          asset=`tree_lod_0${((Number(record.asset.slice(-2))||1)-1)%3+1}`;
          const original=catalog.get(record.asset).size,target=catalog.get(asset).size;
          matrix.scale(scale.set(original.x/target.x,original.y/target.y,original.z/target.z));
          stats.lodInstances++;
        }
        const batch=batches.get(asset);
        if(batch.count>=config.max_instances_per_asset){stats.capacityDrops++;continue;}
        for(const mesh of batch.meshes)mesh.setMatrixAt(batch.count,matrix);
        batch.count++;stats.visibleInstances++;
        stats.byKind[record.kind]=(stats.byKind[record.kind]||0)+1;
      }
    }
    for(const batch of batches.values())for(const mesh of batch.meshes){
      mesh.count=batch.count;mesh.visible=batch.count>0;
      mesh.instanceMatrix.clearUpdateRanges();
      if(batch.count){mesh.instanceMatrix.addUpdateRange(0,batch.count*16);mesh.instanceMatrix.needsUpdate=true;}
    }
    return stats;
  }
  return {root,update,config,get stats(){return stats;}};
}
