# Audio System

This document describes the current recovered audio path on `main`.

## Source files

```text
src/audio/AudioSystem.js
src/audio/AmbientAudioSystem.js
src/audio/RandomAudioEmitters.js
src/audio/FootstepAudioSystem.js
src/audio/audioUtils.js
src/app/GrassDemo.js
src/world/EnvironmentController.js
public/config.yaml
```

## Architecture

The current implementation uses Three.js/Web Audio rather than HTML audio elements:

```text
THREE.AudioListener attached to the gameplay camera
THREE.Audio for global/transition sounds
THREE.PositionalAudio for recovered spatial emitters
THREE.AudioLoader for buffers
```

`AudioSystem` owns the listener and shared loader and composes three focused subsystems:

```text
AmbientAudioSystem
RandomAudioEmitters
FootstepAudioSystem
```

## Initialization versus playback

Construction and `init()` prepare audio objects and buffers but leave playback disabled:

```text
enabled = false
started = false
```

The recovered application does not unlock audio from an arbitrary window click or key press. The public Start button is the explicit audio gate.

`GrassDemo` calls:

```text
await audio.start()
```

from the Start-button click handler. `start()` resumes the Three.js audio context when suspended, verifies that it is running, enables audio, starts the active ambient preset and enables random emitters.

This explicit gate is important for both browser autoplay rules and parity with the recovered startup flow.

## Ambient audio

Ambient loops are preset-aware. The configured sound bank includes recovered wind, rain, insect and lake ambience where the corresponding repository assets exist.

Preset changes are coordinated by `EnvironmentController` through `AudioSystem.setPreset()`.

Audio preset transitions maintain previous/target preset state and interpolate emitter/ambient volume multipliers over the configured audio fade duration.

## Random spatial emitters

`RandomAudioEmitters` reproduces recovered scene/camera-aware one-shot emitters rather than playing every bird/insect call globally.

Emitter state includes position, playback timing, preset multiplier and volume attenuation through Three.js positional audio.

Some recovered Moonlight emitter paths referenced `insect1.mp3`, `insect2.mp3` and `insect3.mp3`; those files are not present in the repository and are intentionally not fabricated. Missing optional assets therefore remain absent instead of being substituted with invented sounds.

## Footsteps

`FootstepAudioSystem` is driven by the player movement/animation state and uses the detected surface:

```text
water
grass
mud
```

Surface detection happens in `GrassDemo` before `audio.update()` each frame.

The runtime reuses loaded footstep buffers and follows the recovered no-immediate-repeat selection and playback-rate variation behavior.

## Transition sound

The configured transition clip is loaded into a shared `THREE.Audio` object. Preset changes stop an already-playing transition clip before replaying it and apply the configured transition volume multiplied by master volume.

## Runtime volume controls

`AudioSystem` owns:

```text
masterVolume
ambientVolume
environmentVolume
```

Changing one propagates the resulting levels to ambient audio, random emitters and footsteps.

## Frame update

After player surface detection, `AudioSystem.update(deltaSeconds)` performs:

```text
preset transition interpolation
ambient updates
footstep updates
random-emitter updates
```

Updates are skipped until initialization, explicit Start-gate enablement and audio-context startup have all completed.

## Lifecycle

`dispose()`:

```text
stops ambient/random playback
stops and disconnects transition audio
disposes child audio systems
removes the AudioListener from the camera
```

The audio subsystem does not own the camera, scene or player controller.

## Parity boundary

Current footstep corrections: character setup samples each selected walk/run clip's foot heights once to derive landing phases; unsupported rigs retain the configured phase fallback. Playback follows the active animation time, including its speed adjustment. The grass source files include multi-step recordings, so decoding extracts one impact (up to 0.4 seconds), trims the lead-in and fades the tail without modifying shared source buffers. Idle, airborne, disabled controls/audio and frame gaps above 0.25 seconds cancel active footsteps and reset phase tracking. No delayed contact is replayed on resumption.

The target is recovered observable audio behavior and scene awareness, not the unavailable original class/file layout. Missing source audio assets remain a documented asset gap rather than a reason to invent replacements.
