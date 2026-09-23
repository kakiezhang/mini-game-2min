import type { CharacterModelConfig } from "./animated-character";
import type { EnemyKind } from "../config";

export const CHARACTER_MODELS = {
  player: {
    url: new URL("../../ksman_v3_walk_1k_meshopt.glb", import.meta.url).href,
    height: 118,
    idlePose: 0.5,
    clips: {
      idle: /idle/i,
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
  ppt: {
    url: new URL("../../ppt_walk_1k_meshopt.glb", import.meta.url).href,
    height: 110,
    idlePose: 0.5,
    clips: {
      walk: /walk/i,
    },
  },
  changeRequest: {
    url: new URL("../../change_request_walk_1k_meshopt.glb", import.meta.url).href,
    height: 104,
    idlePose: 0.5,
    clips: {
      walk: /walk/i,
    },
  },
} satisfies Record<string, CharacterModelConfig>;

export type CharacterModelId = keyof typeof CHARACTER_MODELS;

export const ENEMY_CHARACTER_MODELS: Partial<Record<EnemyKind, CharacterModelConfig>> = {
  bug: CHARACTER_MODELS.bug,
  changeRequest: CHARACTER_MODELS.changeRequest,
  meeting: CHARACTER_MODELS.ppt,
};
