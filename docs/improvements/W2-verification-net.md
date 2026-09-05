# W2 — Verification net

**Effort** ~6-8h · **Depends on** W1 · **Gates** section 3 of W3 · **Render risk** none

There is currently no automated check of any kind. CI runs checkout → setup-node → `npm install` → `npm run build`, and that is the entire pipeline. No lint, no tests, no type check. A successful build proves only that the modules parse and bundle.

That is the whole safety net for a 5,200-line refactor target.

## The framing

**Do not try to test rendering.** A WebGPU scene cannot be meaningfully unit-tested, and pretending otherwise produces slow, brittle tests that get deleted.

Test two things instead:

1. The genuinely pure logic — small, cheap, permanent value.
2. **The two risky W3 optimizations, differentially against the current implementation as reference.** This is the high-value half. It converts W3 section 3 from "argued exact" into "proven exact."

Use `node --test` with `node:assert`. Zero new dependencies.

### First action

**Verify that `three` core imports under Node** before writing anything else. `three/webgpu` and the addons under `three/examples/` almost certainly will not. Scope the test suite to modules that avoid them.

Module classification by import depth:

```text
no three at all — trivially testable
  utils/random.js
  world/getRendererPixelRatio.js        (needs a window stub)
  assets/assetUrl.js                    (needs a document stub)
  config/loadConfig.js
  world/loadTreeWorldData.js
  world/loadWorldPropData.js

three core only — testable if core imports under Node
  world/TerrainSampler.js
  world/ZoneIndex.js
  grass/InteractionMap.js
  world/EnvironmentController.js

three/webgpu or addons — not Node-testable, do not attempt
  grass/GrassMaterial.js, grass/GrassGeometry.js, grass/GrassPainter.js
  player/PlayerController.js, world/TreeSystem.js, world/createWorld.js
  and nine others
```

---

## Targets, ranked by value per line

### 1. `createRandom` golden sequence

[../../src/utils/random.js](../../src/utils/random.js) — about ten lines of test.

Determinism here is a **parity property**, not an implementation detail. Tree scale and rotation, bird orbit parameters and leaf placement all derive from this generator. If its constants drift, the entire world silently reshuffles and no other check in the repository would notice.

Assert a fixed prefix of the sequence for a known seed, and assert that the default seed is stable.

### 2. `mergeConfig`

Requires the export added in W1 section 2. The same exported function backs the config dump script and the doc checker, so tests and guard cannot diverge.

Cover:
- nested object merge
- later-file precedence
- null and non-object handling (`isRecord` rejects arrays and `null`)
- **array replacement** — the exact semantics that make `config.yaml`'s `trees.types` block dead. This is the case most likely to surprise someone later

### 3. Differential harness — `InteractionMap`

The highest-value test for W3, and the reason W2 gates W3 section 3.

Keep the current `#recover()` and `#scroll()` as a reference implementation inside the test file. Drive the reference and the optimized version through the same randomized walk:

```text
paint → move → idle → move → disable → idle → re-enable → paint → clear
```

Assert the `pixels` buffer is **byte-identical** after every single step.

The walk must include a long idle stretch after disabling, because that is where the naive optimization breaks: the checklist requires that disabling foot interaction lets existing bends *fade*, and a version that skips recovery on `enabled === false` freezes them instead. The harness catches that directly.

Seed the walk deterministically with `createRandom` so failures reproduce.

### 4. Differential harness — `EnvironmentController`

The highest-value test in the repository, because it catches a trap that is otherwise invisible.

`EnvironmentController` imports only `three` core. Inject fake `sun`, `hemisphere`, `ambient`, `sky`, `clouds`, `grass`, `trees` and `scene` sinks that record every property write. Run this script against both the current and latched versions:

```text
setPreset(A) → tick to settle → setQuality(other) → tick → setPreset(B) → tick to settle
```

Assert the recorded write *values* match, allowing the latched version to skip writes that are duplicates of the previous frame's.

**The `setQuality` step is the point of the test.** `#apply()` at `EnvironmentController.js:198-200` reads `config.quality[this.quality].fogMultiplier` and writes `scene.fog.density`, but `setQuality()` at `:139-141` only assigns `this.quality` and relies on the next `update()` to push it through. Once a settle-latch exists — and settled is the steady state, since quality is changed long after any preset transition — a quality change would never update fog density. That is a visible regression covered by two checklist sections, and this harness is what catches it automatically.

### 5. `TerrainSampler`

`sampleHeight`, `worldToUv` and `contains` against a hand-built heights array. Cover bilinear interpolation at known points, edge clamping, and the out-of-bounds branch at `TerrainSampler.js:119`.

Everything downstream — grass placement, tile visibility, interaction-map depth rejection, bird altitude — reads through these three functions, so a silent regression here is broad.

---

Total is roughly 300 lines. It will not tell you the scene looks right. It *will* prove the two riskiest changes in W3 are neutral, which is exactly where the risk sits.

**Checklist**
- [ ] `three` core import under Node confirmed (or suite scoped around it)
- [ ] `createRandom` golden sequence
- [ ] `mergeConfig`, including array replacement
- [ ] `InteractionMap` differential harness, including disable-then-idle
- [ ] `EnvironmentController` differential harness, including the `setQuality` step
- [ ] `TerrainSampler` math
- [ ] `npm test` wired into CI

---

## Lint

ESLint flat config, deliberately tiny:

```text
no-unused-vars
no-undef
no-unreachable
```

Its value here is the dead-code class in W3 section 1, plus arity mismatches. Three exist today:

| Call site | Signature | Note |
|---|---|---|
| `GrassDemo.js:188` `trees.update(deltaSeconds, elapsedSeconds)` | `TreeSystem.update(deltaSeconds)` `:412` | extra argument silently dropped |
| `GrassDemo.js:192` `water.update(elapsedSeconds)` | `WaterSurface.update() {}` `:58` | empty no-op called every frame |
| `GrassField.js:202` `painter?.update(deltaSeconds)` | `GrassPainter.update()` `:211` | extra argument silently dropped |

None is a bug in JavaScript, but each marks either a signature that drifted or an abstraction that never got filled in. Worth resolving deliberately rather than leaving ambiguous.

**Do not add Prettier.** Reformatting 5,200 lines produces a diff that makes every subsequent parity review unreadable, and parity review is the whole point of the surrounding work. Add `.editorconfig` only.

**Checklist**
- [ ] Minimal ESLint flat config, `npm run lint` green
- [ ] Three arity mismatches resolved deliberately
- [ ] `.editorconfig` added
- [ ] No Prettier
- [ ] Lint wired into CI

---

## Verification

```text
npm test    green
npm run lint    green
```

Then verify the tests actually bite, by breaking things on purpose:

- Change one constant in `createRandom` → the golden test must fail.
- Reintroduce the `setQuality` fog trap → the `EnvironmentController` harness must fail.
- Make the `InteractionMap` optimization skip recovery on `enabled === false` → the differential harness must fail during the disable-then-idle stretch.

A test suite that stays green under all three is not protecting anything. Confirm each one fails before trusting the suite in W3.
