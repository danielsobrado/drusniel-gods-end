import base64
from pathlib import Path
import tempfile
import unittest

from pygltflib import Buffer, BufferView, GLTF2, Image
from tools.glb_inspect import load_image_bytes


class ImageBufferTests(unittest.TestCase):
    def test_image_uses_its_buffer_view_buffer(self):
        image_bytes = b"image payload"
        gltf = GLTF2(
            buffers=[Buffer(byteLength=4), Buffer(byteLength=16, uri="textures%20data.bin")],
            bufferViews=[BufferView(buffer=1, byteOffset=3, byteLength=len(image_bytes))],
            images=[Image(bufferView=0, mimeType="image/png")],
        )
        gltf.set_binary_blob(b"wrong buffer")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scene.gltf"
            (path.parent / "textures data.bin").write_bytes(b"pad" + image_bytes)
            data, _ = load_image_bytes(gltf, path, 0)
        self.assertEqual(data, image_bytes)

    def test_buffer_view_can_use_a_data_uri_buffer(self):
        payload = b"embedded texture"
        uri = "data:application/octet-stream;base64," + base64.b64encode(payload).decode()
        gltf = GLTF2(buffers=[Buffer(byteLength=len(payload), uri=uri)],
                     bufferViews=[BufferView(buffer=0, byteLength=len(payload))],
                     images=[Image(bufferView=0)])
        self.assertEqual(load_image_bytes(gltf, Path("scene.gltf"), 0)[0], payload)

    def test_external_image_uris_are_percent_decoded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scene.gltf"
            (path.parent / "leaf color.png").write_bytes(b"png")
            gltf = GLTF2(images=[Image(uri="leaf%20color.png")])
            self.assertEqual(load_image_bytes(gltf, path, 0)[0], b"png")

    def test_glb_image_buffer_remains_supported(self):
        gltf = GLTF2(buffers=[Buffer(byteLength=7)],
                     bufferViews=[BufferView(buffer=0, byteOffset=4, byteLength=3)],
                     images=[Image(bufferView=0)])
        gltf.set_binary_blob(b"pad!png")
        self.assertEqual(load_image_bytes(gltf, Path("scene.glb"), 0)[0], b"png")


if __name__ == "__main__":
    unittest.main()
