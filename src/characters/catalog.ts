import type { CharacterModelConfig } from "./animated-character";

export const CHARACTER_MODELS = {
  player: {
    url: new URL("../../ksman_walk_1k_meshopt.glb", import.meta.url).href,
    height: 118,
    idlePose: 0.5,
    clips: {
      walk: /walk/i,
    },
  },
  bug: {
    url: new URL("../../bug_walk_1k_meshopt.glb", import.meta.url).href,
    height: 102,
    idlePose: 0.5,
    clips: {
      walk: /walk/i,
    },
  },
} satisfies Record<string, CharacterModelConfig>;

export type CharacterModelId = keyof typeof CHARACTER_MODELS;
