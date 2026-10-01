import { Node, Vector2 } from 'three/webgpu';
import { uniform, varyingProperty } from 'three/tsl';

// Weather state shared by the ambient effects that live inside other
// materials (the snow and sand streaks, the grass gust sheen). The
// AmbientEffectsSystem writes them once a frame; with it absent they stay at
// values that switch those effects off.
export const ambientUniforms = {
  // Preset wind relative to the reference breeze: 1 on a sunny day, about 0.3
  // when calm, above 1 in the windy preset.
  windiness: uniform(0),
  // Normalised prevailing wind of the meadow presets, (cos, sin) of the
  // grass wind direction in the XZ plane.
  windDirection: uniform(new Vector2(1, 0)),
  // Distance the blown surface streaks have travelled along the wind, in
  // metres. Integrated on the CPU so a change of wind never makes them jump.
  snowStreakTravel: uniform(0),
  sandStreakTravel: uniform(0),
  // Strength of each surface effect, 0 when off.
  snowStreaks: uniform(0),
  sandStreaks: uniform(0),
  grassGustSheen: uniform(0),
};

// The cinematic wind's gust envelope at each grass vertex, handed from the
// wind deformation (vertex stage) to the meadow shading, which brightens the
// tips of the blades a gust front is bending.
export const grassGustVarying = varyingProperty('float', 'vGrassGust');

// Writes a varying from inside a vertex-stage stack. The grass deformation
// stack is also built into the fragment shader, where a varying is an
// immutable input and a plain assign fails WGSL validation, so the write is
// emitted in the vertex stage only.
class VertexStageWrite extends Node {
  static get type() { return 'VertexStageWrite'; }

  constructor(target, source) {
    super('void');
    this.target = target;
    this.source = source;
  }

  generate(builder) {
    if (builder.shaderStage !== 'vertex') return '';
    const type = this.target.getNodeType(builder);
    builder.addLineFlowCode(`${this.target.build(builder)} = ${this.source.build(builder, type)}`, this);
    return '';
  }
}

/** Records the gust envelope for the meadow shading (vertex stage only). */
export function writeGrassGust(value) {
  new VertexStageWrite(grassGustVarying, value).toStack();
}
