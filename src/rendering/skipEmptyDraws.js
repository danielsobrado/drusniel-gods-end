// Foliage systems keep their instanced meshes visible and publish instance
// counts as the view changes, so at any moment about twenty of them hold zero
// instances. Three still prepares each one fully (node updates, uniform
// uploads, bind groups, pipeline) before issuing a draw of nothing, in every
// pass. This skips them at the renderer's per-object entry point instead of
// making every system couple its visibility to its count.
//
// Warmup and draw preparation set empty meshes to one instance while they
// compile, so pipelines are still prepared ahead of first use.
export function isEmptyInstancedDraw(object, geometry) {
  if (object.isInstancedMesh && object.count === 0) return true;
  return geometry?.isInstancedBufferGeometry === true && geometry.instanceCount === 0 && !object.isInstancedMesh;
}

export function installEmptyDrawSkip(renderer) {
  const renderObject = renderer.renderObject;
  if (typeof renderObject !== 'function' || renderObject.skipsEmptyDraws) return () => {};
  const skipping = function (object, scene, camera, geometry, ...rest) {
    if (isEmptyInstancedDraw(object, geometry)) return undefined;
    return renderObject.call(this, object, scene, camera, geometry, ...rest);
  };
  skipping.skipsEmptyDraws = true;
  renderer.renderObject = skipping;
  return () => {
    if (renderer.renderObject === skipping) renderer.renderObject = renderObject;
  };
}
