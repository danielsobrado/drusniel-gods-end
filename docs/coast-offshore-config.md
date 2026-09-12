# Coast and offshore configuration

The coast and enhanced sea are configured below `water.sea` in `public/cinematic-look.yaml`. All groups are optional; runtime resolvers provide matching defaults for older configurations and reject non-finite values or invalid ordered bands with named configuration errors.

## Offshore wave controls

| Key | Default | Purpose |
| --- | ---: | --- |
| `offshoreAmplitude` | 1.6 | Offshore vertical envelope in world units |
| `beachAmplitude` | 0.25 | Near-shore surf envelope |
| `choppiness` | 4 | Crest sharpening, valid range 0–6 |
| `transitionStart` | 30 | Distance where offshore blending begins |
| `transitionEnd` | 180 | Distance where offshore blending completes |
| `detailStrength` | 1 | Medium/fine normal-detail multiplier |
| `whitecapStrength` | 1 | Offshore whitecap intensity multiplier |
| `crestTranslucency` | 1 | Backlit crest transmission multiplier |

`water.sea.detail` owns normal filtering distances, texture scales/scroll rates, whitecap thresholds and breakup, explicit specular roughness tuning, surf-depth fades and crest-transmission tuning. These controls affect shading only; they do not duplicate coastline, shelf or swash controls.

## Coast groups

`water.sea.coast` contains:

- `curve`: shoreline frequencies/amplitudes;
- `terrain`: inland blend, beach elevation and shelf depth bands;
- `wave`: 13-unit beach wavelength, phase speed and along-coast bend;
- `swash`: run-up reach, front/foam widths and breakup;
- `moisture`: permanent shoreline reach, wash decay and rain wet/dry time constants;
- `sand`: dry colors, roughness, film/foam response and multi-scale detail;
- `vegetation`: ordinary vegetation cutoff plus coastal groundcover band, seed, sizes, slope limit and quality fractions. `clusterRadius` (0.42), `groundOffset` (0.025), and `roughness` (0.9) tune the creeping patches; every clump samples its own ground height and slope;
- `scatter`: deterministic beach-debris seed, band, density, sizes, colors and slope threshold. `patchFrequencyX` (0.17), `patchFrequencyZ` (0.23), and `patchWarpFrequency` (0.12) control broad placement irregularity.

The default swash reaches 12 world units inland. Wetting and drying time constants remain 18 and 100 seconds. The default dry sand colors remain `#b39a72` and `#d6be96`; wetness modifies that dry mixture rather than treating those colors as a wet/dry pair.

## Quality geometry

Sea tiles use fixed coast-relative boundaries so neighboring meshes share the same border samples:

```text
across: [-180, 80, 180, 650, 1100, 2000, 4500]
along:  [-3000, -1200, -850, -425, 0, 425, 850, 1200, 3000]
```

Spacing varies by quality. The total 48-tile lattice contains approximately:

| Quality | Sea vertices | Sea triangles |
| --- | ---: | ---: |
| Performance | 59,976 | 113,256 |
| Balanced | 119,394 | 229,308 |
| High | 225,024 | 436,968 |
| Ultra | 318,912 | 622,224 |

Those are allocated totals, not per-frame rendered totals. Main-view cost is lower when frustum culling removes tiles. `water.stats.visibleSeaTiles`, `visibleSeaVertices` and `visibleSeaTriangles` report the current main-view subset.

The default maximum storm displacement bound is 2.64 world units. Changing water quality rebuilds only sea tile buffers; it does not reset the wave clock or reflection/refraction resources.
