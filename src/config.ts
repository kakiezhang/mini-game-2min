export const MAP = {
  width: 1080,
  depth: 1720,
};

export const GAME = {
  duration: 120,
  maxEnemies: 30,
  playerRadius: 20,
  elevatorHoldTime: 2,
};

export const COLORS = {
  floor: 0x29322f,
  wall: 0x8a938a,
  player: 0xf4f0da,
  playerAccent: 0x2fbf71,
  weapon: 0x303941,
  muzzle: 0xffd166,
  ammoBox: 0x32d583,
  ammoPack: 0x7dd3fc,
  bug: 0xff6f61,
  changeRequest: 0x60a5fa,
  meeting: 0xa78bfa,
  boss: 0xb45309,
  accessCard: 0xfacc15,
  elevatorClosed: 0x737b86,
  elevatorOpen: 0x22c55e,
};

export type EnemyKind = "bug" | "changeRequest" | "meeting" | "boss";

export type EnemyConfig = {
  color: number;
  radius: number;
  height: number;
  hp: number;
  speed: number;
  damage: number;
  expReward: number;
  contactCooldown: number;
};

export const ENEMY_CONFIG: Record<EnemyKind, EnemyConfig> = {
  bug: {
    color: COLORS.bug,
    radius: 15,
    height: 34,
    hp: 18,
    speed: 70,
    damage: 5,
    expReward: 6,
    contactCooldown: 0.6,
  },
  changeRequest: {
    color: COLORS.changeRequest,
    radius: 17,
    height: 46,
    hp: 45,
    speed: 95,
    damage: 8,
    expReward: 12,
    contactCooldown: 0.7,
  },
  meeting: {
    color: COLORS.meeting,
    radius: 18,
    height: 40,
    hp: 54,
    speed: 60,
    damage: 4,
    expReward: 15,
    contactCooldown: 0.8,
  },
  boss: {
    color: COLORS.boss,
    radius: 30,
    height: 88,
    hp: 900,
    speed: 115,
    damage: 20,
    expReward: 0,
    contactCooldown: 0.75,
  },
};

export type AttackMode = "manual" | "automatic";

export type WeaponConfig = {
  id: string;
  attackMode: AttackMode;
  damage: number;
  fireRate: number;
  range: number;
  magazineSize: number;
  initialReserveAmmo: number;
  maxReserveAmmo: number;
  reloadTime: number;
};

export const DEFAULT_WEAPON: WeaponConfig = {
  id: "defaultSmg",
  attackMode: "manual",
  damage: 18,
  fireRate: 5,
  range: 720,
  magazineSize: 20,
  initialReserveAmmo: 80,
  maxReserveAmmo: 120,
  reloadTime: 1.3,
};

export const BULLET_VISUAL = {
  speed: 1800,
  length: 36,
  radius: 4.5,
  maxActive: 24,
};

export const AMMO_CONFIG = {
  fixedAmount: 40,
  droppedAmount: 12,
  fixedRespawnTime: 20,
  droppedLifetime: 24,
  maxDroppedPacks: 20,
  dropChance: {
    bug: 0.12,
    changeRequest: 0.2,
    meeting: 0.25,
    boss: 0,
  } satisfies Record<EnemyKind, number>,
  fixedSpawns: [
    { id: "workstation", x: 450, z: 1000 },
    { id: "bossOffice", x: 950, z: 450 },
  ],
};

export const getSpawnStage = (elapsed: number) => {
  if (elapsed < 15) return { interval: 1.3, count: 1, weights: { bug: 100, changeRequest: 0, meeting: 0 } };
  if (elapsed < 40) return { interval: 1.15, count: 1, weights: { bug: 75, changeRequest: 25, meeting: 0 } };
  if (elapsed < 80) return { interval: 1.0, count: 1, weights: { bug: 55, changeRequest: 30, meeting: 15 } };
  if (elapsed < 90) return { interval: 0.9, count: 2, weights: { bug: 45, changeRequest: 35, meeting: 20 } };
  return { interval: 0.8, count: 2, weights: { bug: 40, changeRequest: 40, meeting: 20 } };
};
