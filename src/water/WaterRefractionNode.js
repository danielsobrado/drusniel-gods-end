import { ViewportTextureNode } from 'three/webgpu';

// A global shared framebuffer can retain the canvas format when a recreated
// renderer starts rendering into the HDR scene pass. Keep captures local to
// this material and let Three select a separate texture per render target.
export class WaterRefractionNode extends ViewportTextureNode {
  constructor(...args) {
    super(...args);
    this.ownedTextures = new Set([this.defaultFramebuffer]);
  }

  getTextureForReference(reference = null) {
    const texture = super.getTextureForReference(reference);
    this.getBase().ownedTextures.add(texture);
    return texture;
  }

  dispose() {
    for (const texture of this.ownedTextures) texture.dispose();
    this.ownedTextures.clear();
    super.dispose();
  }
}
