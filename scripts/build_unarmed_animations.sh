#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Preserve the established armed-clip corrections in the combined review asset.
/Applications/Blender.app/Contents/MacOS/Blender -b --python-exit-code 1 \
  --python scripts/merge_character_animations.py -- \
  ksman_v3_walk.fbx ksman_v3_unarmed_moves_review.glb \
  --clip Idle=ksman_v3_idle.fbx --clip-range Idle=61:151 --clip-loop-blend Idle=18 \
  --clip Shoot=ksman_v3_shoot.fbx --clip-forearm-twist Shoot=Left:0.5 \
  --clip RifleIdle=ksman_v3_rifle_idle.fbx --clip-forearm-twist RifleIdle=Left:0.5 \
  --clip RifleWalk=ksman_v3_rifle_walk.fbx --clip-forearm-twist RifleWalk=Left:0.5 --clip-walk-legs RifleWalk=3 \
  --clip RifleRun=ksman_v3_rifle_run.fbx --clip-loop-blend RifleRun=5 --clip-forearm-twist RifleRun=Left:0.5 \
  --clip Reload=ksman_v3_reload.fbx --clip-forearm-twist Reload=Left:0.5 \
  --clip UnarmedRun=ksman_v3_unarmed_run.fbx \
  --clip PunchJab=ksman_v3_punch_jab_punch.fbx \
  --clip PunchRightCross=ksman_v3_punch_right_cross_punch.fbx \
  --clip PunchFourCombo=ksman_v3_punch_four_punch_combo.fbx \
  --clip PunchHook=ksman_v3_punch_hook_punch.fbx \
  --clip KickSide=ksman_v3_kick_mma_side_kick.fbx \
  --clip KickLow=ksman_v3_kick_mma_low_kick.fbx \
  --clip KickRoundhouse=ksman_v3_kick_mma_roundhouse_kick.fbx \
  --clip KickHurricane=ksman_v3_kick_hurricane_kick.fbx --force
npx --yes @gltf-transform/cli@4.5.0 optimize \
  ksman_v3_unarmed_moves_review.glb ksman_v3_unarmed_moves_review_1k_meshopt.glb \
  --compress meshopt --meshopt-level medium --resample false \
  --texture-compress webp --texture-size 1024
