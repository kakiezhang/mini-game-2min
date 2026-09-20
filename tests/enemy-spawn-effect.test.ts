import * as THREE from "three";
import { EnemySpawnEffectSystem } from "../src/effects/enemy-spawn-effect.js";

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
};

const testSpawnEffectLifecycle = () => {
  const scene = new THREE.Scene();
  const target = new THREE.Group();
  const healthBar = new THREE.Group();
  const effects = new EnemySpawnEffectSystem(scene);
  let completions = 0;

  effects.begin({
    id: 7,
    x: 120,
    z: 180,
    radius: 30,
    height: 100,
    color: 0xff7f50,
    target,
    healthBar,
    onComplete: () => { completions += 1; },
  });

  assertEqual(effects.isActive(7), true, "a started spawn effect should be active");
  assertEqual(target.visible, false, "the enemy should be hidden while bubbles form");
  assertEqual(healthBar.visible, false, "the health bar should stay hidden during spawning");

  effects.update(0.7);
  assertEqual(target.visible, false, "the enemy should remain hidden before the smoke reveal");
  effects.update(0.2);
  assertEqual(target.visible, true, "the enemy should reveal behind the smoke");
  assertEqual(completions, 0, "gameplay should not activate until the effect finishes");

  effects.update(0.4);
  assertEqual(effects.isActive(7), false, "the completed effect should remove itself");
  assertEqual(completions, 1, "spawn completion should be reported once");
  assertEqual(target.scale.x, 1, "the enemy should finish at its normal scale");
};

testSpawnEffectLifecycle();
console.info("enemy spawn effect tests passed");
