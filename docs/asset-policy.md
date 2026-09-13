# Asset policy

The default application ships without external art, audio or model assets. The scene is generated from Three.js primitives.

Future assets must be added intentionally and documented with:

- source URL or internal source record,
- author or vendor,
- license,
- required attribution text,
- local file path,
- date acquired.

Do not add an asset when its redistribution rights are unclear. Prefer original work, CC0/public-domain material, or permissive licenses compatible with redistribution.

The coastal-jungle pack under `public/Assets/terrain/coastal-jungle/` records source, author, rights and import date in that folder's `manifest.json`. The v1 combined scene is the currently active runtime asset; the v2 object kit, textures, and combined scene are staged beside it. `public/coastal-jungle.yaml` remains reference-only composition data. The source repository publishes an MIT LICENSE; do not invent broader rights than that license states.
