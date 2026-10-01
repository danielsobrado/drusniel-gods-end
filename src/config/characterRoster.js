// The playable roster is resolved before the player model is fetched, because the
// selected character decides which GLB is loaded and how tall the capsule ends up.
// Applying a character rewrites assets.player and merges its overrides over the
// effective player block, so every system downstream keeps reading config.player.
import { mergeConfig } from './loadConfig.js';

export function getRoster(config) {
  const roster = config?.characters?.roster;
  if (!Array.isArray(roster)) return [];
  return roster.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.model === 'string');
}

export function findCharacter(config, id) {
  return getRoster(config).find((entry) => entry.id === id) ?? null;
}

export function defaultCharacterId(config) {
  const roster = getRoster(config);
  if (roster.length === 0) return null;
  const preferred = config?.characters?.default;
  return roster.some((entry) => entry.id === preferred) ? preferred : roster[0].id;
}

// `?character=enanillo` skips the picker entirely, which keeps headless runs and
// screenshot passes from stalling on a gate that needs a click.
export function requestedCharacterId(search, config) {
  const requested = new URLSearchParams(search ?? '').get('character');
  return requested && findCharacter(config, requested) ? requested : null;
}

export function applyCharacter(config, id) {
  const character = findCharacter(config, id) ?? findCharacter(config, defaultCharacterId(config));
  if (!character) return null;

  config.assets.player = character.model;
  if (character.player) mergeConfig(config.player, structuredClone(character.player));
  config.characters.selected = character.id;
  return character;
}
