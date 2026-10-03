import * as THREE from "three";
import { AttackShape, type AttackWorld, type GroundPoint, type WaveSpec } from "../attack-shape.js";
import type { AttackDirection } from "../attack-gesture.js";
import { AttackBandVisual } from "../melee-wave-visual.js";

export class AttackPreview {
  private readonly band = new AttackBandVisual(0xffd77a, 0.16, 4);
  private readonly boundary = new AttackBandVisual(0xffd77a, 0.65, 4.2);
  private readonly triangles: number[] = [];
  private readonly arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 80, 0xffd77a, 12, 7);

  constructor(scene: THREE.Scene, private readonly world: AttackWorld) {
    scene.add(this.band.mesh, this.boundary.mesh, this.arrow);
  }

  update(origin: GroundPoint, direction: AttackDirection, spec: Readonly<WaveSpec>, canceled = false) {
    const shape = new AttackShape(origin, direction, spec, this.world);
    const color = canceled ? 0xff7373 : 0xffd77a;
    this.band.mesh.material.color.setHex(color); this.boundary.mesh.material.color.setHex(color);
    this.band.update(shape.writeBand(0, spec.range, this.triangles), canceled ? 0.07 : 0.16);
    this.boundary.update(shape.writeBand(spec.range - 2, spec.range, this.triangles), canceled ? 0.2 : 0.65);
    this.arrow.visible = !canceled;
    this.arrow.position.set(origin.x, 9, origin.z);
    this.arrow.setDirection(new THREE.Vector3(direction.x, 0, direction.z).normalize());
    const limit = this.world.raycastObstacleDistance(origin.x, origin.z, direction.x, direction.z, spec.range);
    this.arrow.setLength(Math.max(1, limit - 5), Math.min(12, limit / 3), Math.min(7, limit / 4));
  }

  hide() { this.band.mesh.visible = false; this.boundary.mesh.visible = false; this.arrow.visible = false; }
  dispose() { this.band.dispose(); this.boundary.dispose(); this.arrow.dispose(); this.arrow.removeFromParent(); }
}
