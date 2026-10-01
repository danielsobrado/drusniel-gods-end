import { RTTNode } from 'three/webgpu';
import { NodeUpdateType, nodeObject } from 'three/tsl';

// These targets depend on one scene pass per frame. RTTNode otherwise updates
// once per nested render and its inherited dispose does not release its GPU resources.
export class EffectTarget extends RTTNode {
  constructor(node, options) {
    super(nodeObject(node), null, null, options);
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.isActive = () => true;
    this.initialized = false;
  }

  updateBefore(frame) {
    // Prepare even dormant passes once, so entering a region needs no first-use compilation.
    if (this.initialized && !this.isActive()) return;
    super.updateBefore(frame);
    this.initialized = true;
  }

  dispose() {
    super.dispose();
  }
}
