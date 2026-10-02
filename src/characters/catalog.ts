import type { CharacterModelConfig } from "./animated-character";
import type { EnemyKind } from "../config";

export const CHARACTER_MODELS = {
  playerUnarmed: {
    url: new URL("../../ksman_v3_unarmed_moves_review_1k_meshopt.glb", import.meta.url).href,
    height: 118,
    runSpeedThreshold: 1.4,
    movingUpperBodyActions: ["punchJab", "punchCombo", "punchHook"],
    clips: {
      idle: /^Idle$/i,
      walk: /^Walk$/i,
      run: /^UnarmedRun$/i,
      punchJab: /^PunchJab$/i,
      punchCombo: /^PunchFourCombo$/i,
      punchHook: /^PunchHook$/i,
      kickSide: /^KickSide$/i,
      kickLow: /^KickLow$/i,
      kickRoundhouse: /^KickRoundhouse$/i,
      kickHurricane: /^KickHurricane$/i,
    },
  },
  player: {
    url: new URL("../../ksman_v3_walk_1k_meshopt.glb", import.meta.url).href,
    height: 118,
    idlePose: 0.5,
    shootUpperBodyOnly: true,
    shootPulseEndSeconds: 0.3,
    jogFromWalkRun: true,
    runShootFromRun: true,
    heldWeapon: "smg",
    clips: {
      idle: /^RifleIdle$/i,
      walk: /^RifleWalk$/i,
      run: /^RifleRun$/i,
      shoot: /^Shoot$/i,
      reload: /^Reload$/i,
    },
  },
  bug: {
    url: new URL("../../bug_walk_1k_meshopt.glb", import.meta.url).href,
    height: 102,
    idlePose: 0.5,
    walkStrideScale: 1.2,
    clips: {
      walk: /walk/i,
    },
  },
  ppt: {
    url: new URL("../../ppt_walk_1k_meshopt.glb", import.meta.url).href,
    height: 110,
    idlePose: 0.5,
    walkStrideScale: 1.1,
    clips: {
      walk: /walk/i,
    },
  },
  changeRequest: {
    url: new URL("../../change_request_walk_1k_meshopt.glb", import.meta.url).href,
    height: 104,
    idlePose: 0.5,
    walkStrideScale: 1.2,
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
