import * as THREE from "three";

export type HeldWeaponVisual = {
  weapon: THREE.Group;
  muzzleSocket: THREE.Object3D;
  updatePose(shootWeight: number): void;
};

const LOWERED_GUN_ROTATION = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.42, 0, 0));
const AIMED_GUN_ROTATION = new THREE.Quaternion();

/** A lightweight blockout prop; it has no skeleton or animation of its own. */
export function attachPlayerSmg(root: THREE.Object3D): HeldWeaponVisual {
  const hand = root.getObjectByName("mixamorigRightHand");
  if (!(hand instanceof THREE.Bone)) throw new Error("Player SMG requires mixamorigRightHand");

  const socket = new THREE.Group();
  socket.name = "weaponSocket";
  hand.add(socket);

  const weapon = new THREE.Group();
  weapon.name = "heldSmg";
  socket.add(weapon);

  const body = new THREE.MeshStandardMaterial({ color: 0x222a2d, metalness: 0.48, roughness: 0.55 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x11181b, metalness: 0.65, roughness: 0.42 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x343b38, metalness: 0.12, roughness: 0.86 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x46b8bd, metalness: 0.36, roughness: 0.44 });

  const addBox = (
    name: string, size: [number, number, number],
    position: [number, number, number], material: THREE.Material,
    rotationX = 0,
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.rotation.x = rotationX;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    weapon.add(mesh);
  };
  const addTube = (
    name: string, radius: number, length: number,
    position: [number, number, number], material: THREE.Material,
  ) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8), material);
    mesh.name = name;
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(...position);
    mesh.castShadow = true;
    weapon.add(mesh);
  };

  // The grip stays in the right palm. The upper receiver steps toward the
  // left palm used by the Shoot clip, and a connected support ledge sits
  // directly under its fingers. The barrel still points along local +Z.
  addBox("stock", [0.090, 0.060, 0.125], [0.053, 0.040, -0.087], grip);
  addBox("receiver", [0.130, 0.083, 0.205], [0.102, 0.057, 0.095], body);
  addBox("handguard", [0.130, 0.067, 0.125], [0.108, 0.054, 0.248], grip);
  // The rifle Idle/Walk left palm rests slightly farther back and lower than
  // the Shoot palm. Keep one continuous handguard surface under all three.
  addBox("supportLedge", [0.060, 0.060, 0.180], [0.180, 0.005, 0.120], grip);
  addBox("pistolGrip", [0.052, 0.120, 0.061], [0.001, -0.072, 0.009], grip, -0.16);
  addBox("triggerGuard", [0.070, 0.018, 0.073], [0.040, -0.038, 0.079], steel);
  addBox("magazine", [0.050, 0.142, 0.067], [0.101, -0.074, 0.167], steel, 0.13);
  addBox("topRail", [0.075, 0.014, 0.230], [0.105, 0.105, 0.132], steel);
  addBox("rearSight", [0.055, 0.030, 0.019], [0.105, 0.129, 0.053], body);
  addBox("frontSight", [0.045, 0.034, 0.016], [0.105, 0.127, 0.270], body);
  addBox("sideStripe", [0.007, 0.014, 0.132], [0.176, 0.070, 0.159], accent);
  addTube("barrel", 0.014, 0.120, [0.108, 0.054, 0.353], steel);
  addTube("muzzleBrake", 0.025, 0.049, [0.108, 0.054, 0.428], body);

  const supportHandSocket = new THREE.Group();
  supportHandSocket.name = "supportHandSocket";
  supportHandSocket.position.set(0.180, 0.010, 0.145);
  weapon.add(supportHandSocket);

  const muzzleSocket = new THREE.Group();
  muzzleSocket.name = "muzzleSocket";
  muzzleSocket.position.set(0.108, 0.054, 0.458);
  weapon.add(muzzleSocket);

  const handWorld = new THREE.Quaternion();
  const rootWorld = new THREE.Quaternion();
  const desiredGunRotation = new THREE.Quaternion();
  const updatePose = (shootWeight: number) => {
    // Keep the grip in the palm while counter-rotating the animated wrist.
    // The unarmed Idle/Walk wrist would point the gun at the feet; the Shoot
    // wrist is about 32 degrees off the gameplay aim line at its firing frame.
    // Blend from lowered-forward to level-forward as Shoot takes over.
    hand.getWorldQuaternion(handWorld);
    root.getWorldQuaternion(rootWorld);
    desiredGunRotation.copy(LOWERED_GUN_ROTATION)
      .slerp(AIMED_GUN_ROTATION, THREE.MathUtils.clamp(shootWeight, 0, 1));
    socket.quaternion.copy(handWorld).invert().multiply(rootWorld).multiply(desiredGunRotation);
  };
  updatePose(0);
  return { weapon, muzzleSocket, updatePose };
}
