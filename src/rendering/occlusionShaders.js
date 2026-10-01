// Max depth, not min: a candidate can only disappear if its entire projected
// rectangle lies behind the farthest occluder sample. Empty pixels remain 1.
export const depthCopyShader = /* wgsl */ `
@group(0) @binding(0) var source: texture_depth_2d;
@group(0) @binding(1) var destination: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination);
  if (any(id.xy >= size)) { return; }
  var depth = 1.0;
  if (all(id.xy < textureDimensions(source))) {
    depth = textureLoad(source, vec2i(id.xy), 0);
  }
  textureStore(destination, vec2i(id.xy), vec4f(depth));
}`;

export const depthReduceShader = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(destination))) { return; }
  let p = vec2i(id.xy * 2u);
  let limit = vec2i(textureDimensions(source)) - 1;
  let depth = max(max(textureLoad(source, min(p, limit), 0).r,
                      textureLoad(source, min(p + vec2i(1, 0), limit), 0).r),
                  max(textureLoad(source, min(p + vec2i(0, 1), limit), 0).r,
                      textureLoad(source, min(p + vec2i(1, 1), limit), 0).r));
  textureStore(destination, vec2i(id.xy), vec4f(depth));
}`;

export const visibilityShader = /* wgsl */ `
struct Candidate {
  rect: vec4f,
  depth: vec4f,
  draw: vec4u,
}
@group(0) @binding(0) var pyramid: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> candidates: array<Candidate>;
@group(0) @binding(2) var<storage, read_write> draws: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&candidates)) { return; }
  let item = candidates[id.x];
  let span = max(item.rect.z - item.rect.x + 1.0, item.rect.w - item.rect.y + 1.0);
  // Cover the rectangle with up to 9x9 samples. A single very coarse cell
  // includes too much sky beside long, shallow grass tiles to reject them.
  let level = min(u32(max(0.0, ceil(log2(max(1.0, span))) - 3.0)), textureNumLevels(pyramid) - 1u);
  let scale = exp2(f32(level));
  let first = vec2i(floor(item.rect.xy / scale));
  let last = vec2i(floor(item.rect.zw / scale));
  var farthest = 0.0;
  for (var y = first.y; y <= last.y; y++) {
    for (var x = first.x; x <= last.x; x++) {
      farthest = max(farthest, textureLoad(pyramid, vec2i(x, y), i32(level)).r);
    }
  }
  let hidden = item.depth.x > farthest + item.depth.y;
  let offset = id.x * 5u;
  draws[offset] = item.draw.x;
  draws[offset + 1u] = select(item.draw.y, 0u, hidden);
  draws[offset + 2u] = item.draw.z;
  draws[offset + 3u] = 0u;
  draws[offset + 4u] = 0u;
}`;
