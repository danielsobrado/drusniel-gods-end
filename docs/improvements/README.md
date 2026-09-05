# Improvement workstreams

These are **working documents**, not parity specification. They record an audit of the repository and the plan for acting on it.

Nothing in this directory is evidence for parity work. The evidence order in [../README.md](../README.md) is unchanged, and these documents sit below all six of its levels. If one of these documents disagrees with current code, the code wins and the document is wrong.

## Why

Every finding below was verified against source before being written down. The audit found four classes of problem:

```text
W1  the acceptance oracle itself asserts wrong values, and builds are not reproducible
W2  there is no automated check of any kind beyond `npm run build`
W3  the frame does measurable work that provably cannot affect output
W4  nothing is ever torn down, and failures surface as cryptic errors or a frozen frame
```

The finding that sets the order: **[visual-parity-checklist.md](../visual-parity-checklist.md) is wrong in six places.** It is the document that defines acceptance for this project. A refactor cannot be validated against an oracle that is wrong, and running its sign-off today produces false failures on camera framing, character scale and terrain scale. Documentation is therefore the prerequisite, not the cleanup.

The drift is systematic rather than incidental. `modelOffsetY: -0.2` is copy-pasted across seven documents while only the unindexed [player-system.md](../player-system.md) carries the effective `-2.2` — and that file explicitly warns that `-0.2` puts the model two units too high. Meanwhile [camera-system.md](../camera-system.md) line 16 already records that FOV 52 / far 6000 is "obsolete for parity work." Someone already found this drift, corrected it in one file, and it never propagated. **A one-time correction has already been tried and already failed**, so W1 makes the check mechanical.

## Workstreams

| # | Document | Effort | What it buys |
|---|---|---|---|
| W1 | [Oracle and reproducibility](W1-oracle-and-reproducibility.md) | ~6-8h | A usable acceptance oracle; reproducible builds; drift that cannot silently recur |
| W2 | [Verification net](W2-verification-net.md) | ~6-8h | Proof rather than argument that W3's two riskiest changes are byte-exact |
| W3 | [Hot path](W3-hot-path.md) | ~7-9h | ~65,536 loop iterations, a 256KB GPU upload, ~30 uniform writes and ~500 allocations removed per frame |
| W4 | [Lifecycle and robustness](W4-lifecycle-and-robustness.md) | ~7h | Real teardown; actionable errors instead of a silently frozen frame |

## Sequencing

```text
W1  gates everything (oracle + reproducibility)
 └─ W2  gates only section 3 of W3
      ├─ W3  ┐
      └─ W4  ┴ parallel, disjoint concerns
```

W3 and W4 touch disjoint concerns and can run in either order or together.

## Standing constraint

The repository rule from [../../README.md](../../README.md) governs all of this:

```text
current code + merged current configuration = source of truth
```

> If a document and current code ever disagree, update the document rather than silently changing behavior during parity work.

**No commit in W1-W4 is intended to change rendered output.** Each behavior-neutral claim carries an explicit argument in its workstream document, and several "obvious" optimizations were deliberately rejected because the neutrality argument does not hold. Where a finding *would* require a behavior change to fix, it is documented instead — see W1 section 4 item 9 (`painterEnabled`) and W3 section 3 (interaction-map scroll truncation).

Because of that, during and after this work **any visible difference is a regression**, not an improvement.

## Status

| Workstream | Status |
|---|---|
| Phase 0 — these documents | done |
| W1 — oracle and reproducibility | done |
| W2 — verification net | done |
| W3 — hot path | done |
| W4 — lifecycle and robustness | done |
| Wheel zoom | done |
| Parity captures | **partial -- 5 of 9 states** |

### Outstanding

The root `README.md` requires fixed-camera captures for Sunny, Golden Hour,
Rain, Wind, Moonlight, multiple quality levels, both grass types and Grass
Painter.

The app has been driven in Chrome over CDP (WebGPU adapter acquired, 130 FPS,
5.6M triangles, zero page errors) and these were captured:

```text
captured      Sunny, Golden Hour, High quality, Performance quality, Blade grass
not captured  Rain, Wind, Moonlight, Billboard grass, Grass Painter
```

Rain and Grass Painter matter most of the four remaining: both exercise code
paths W3 touched -- the player-following rain volume, and the painter's forced
`low` LOD in `GrassField.update()`.

Behaviour verified interactively so far: boot renders, wheel zoom moves and
clamps at both ends, walking and camera follow work, grass flattens underfoot,
quality switching drops triangles 5,645,813 -> 2,026,503, and a preset
transition runs and settles.

### Checks now in CI

```text
npm run lint         minimal ESLint
npm test             66 tests
npm run check:docs   314 annotated assertions against the merged config
npm run build
```

Division of labour worth knowing: `npm test` proves merge *precedence* (which
YAML file wins), while `check:docs` pins the effective *values* against the
annotated blocks in `docs/`. Duplicating values in both is what previously
went stale.

Plus `npm run config:dump` for reading effective configuration.

### Rejected as unsafe, not merely deferred

Recorded so they are not rediscovered and applied later:

```text
InteractionMap keyed on the enabled flag   freezes bends; violates checklist
EnvironmentController latch without        silently stops updating fog density
  a setQuality re-apply
ZoneIndex same-zone-first shortcut         can flip which zone wins on overlap
shared getObjectByName helper              changes failure-path behavior
unifying the rainRoughness constant        0.4 for trees is not the 0.1 default
normalizing texture setup                  two sites set flipY, one does not
wiring painterEnabled live                 changes painter rendering
accumulating the scroll remainder          changes flattening everywhere
```
