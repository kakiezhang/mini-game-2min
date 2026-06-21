export const MAP = {
  width: 1080,
  depth: 1720,
};

export const GAME = {
  duration: 120,
  maxEnemies: 30,
  elevatorHoldTime: 2,
};

export const PLAYER_CONFIG = {
  maxHp: 100,
  initialHp: 100,
  baseSpeed: 220,
  radius: 20,
  initialLevel: 1,
  initialExp: 0,
  invincibleAfterHit: 0.35,
};

export const EXP_TO_NEXT_BY_LEVEL = [20, 45, 75, 110, 150, 195, 245, 300] as const;

export const getExpToNext = (level: number) => {
  const index = Math.max(0, Math.min(EXP_TO_NEXT_BY_LEVEL.length - 1, Math.floor(level) - 1));
  return EXP_TO_NEXT_BY_LEVEL[index];
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
  spreadDegrees: number;
  criticalChance: number;
  criticalMultiplier: number;
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
  spreadDegrees: 2,
  criticalChance: 0,
  criticalMultiplier: 1.8,
  magazineSize: 20,
  initialReserveAmmo: 80,
  maxReserveAmmo: 120,
  reloadTime: 1.3,
};

export type WeaponUpgradeId = "firepowerCalibration" | "magazineManagement";

export type WeaponUpgradeLevels = Record<WeaponUpgradeId, number>;

export type WeaponRuntimeStats = {
  damage: number;
  fireRate: number;
  spreadDegrees: number;
  criticalChance: number;
  criticalMultiplier: number;
  magazineSize: number;
  reloadTime: number;
  postReloadFireRateMultiplier: number;
  postReloadBoostDuration: number;
  emptyReloadTimeMultiplier: number;
};

export const WEAPON_UPGRADE_DEFINITIONS: Record<WeaponUpgradeId, {
  title: string;
  descriptions: readonly string[];
}> = {
  firepowerCalibration: {
    title: "火力校准",
    descriptions: [
      "单发伤害提升 15%",
      "射速提升 12%",
      "单发伤害累计提升至 30%",
      "连续射击散布降低 30%",
      "暴击概率提升至 12%",
    ],
  },
  magazineManagement: {
    title: "弹匣管理",
    descriptions: [
      "弹匣容量提升至 26 发",
      "换弹时间缩短至 1.05 秒",
      "弹匣容量提升至 32 发",
      "换弹后 1 秒内射速提升 20%",
      "空仓换弹时间额外缩短 25%",
    ],
  },
};

const FIREPOWER_LEVELS = [
  { damageMultiplier: 1, fireRateMultiplier: 1, spreadMultiplier: 1, criticalChance: 0 },
  { damageMultiplier: 1.15, fireRateMultiplier: 1, spreadMultiplier: 1, criticalChance: 0 },
  { damageMultiplier: 1.15, fireRateMultiplier: 1.12, spreadMultiplier: 1, criticalChance: 0 },
  { damageMultiplier: 1.3, fireRateMultiplier: 1.12, spreadMultiplier: 1, criticalChance: 0 },
  { damageMultiplier: 1.3, fireRateMultiplier: 1.12, spreadMultiplier: 0.7, criticalChance: 0 },
  { damageMultiplier: 1.3, fireRateMultiplier: 1.12, spreadMultiplier: 0.7, criticalChance: 0.12 },
] as const;

const MAGAZINE_LEVELS = [
  { magazineSize: 20, reloadTime: 1.3, postReloadFireRateMultiplier: 1, postReloadBoostDuration: 0, emptyReloadTimeMultiplier: 1 },
  { magazineSize: 26, reloadTime: 1.3, postReloadFireRateMultiplier: 1, postReloadBoostDuration: 0, emptyReloadTimeMultiplier: 1 },
  { magazineSize: 26, reloadTime: 1.05, postReloadFireRateMultiplier: 1, postReloadBoostDuration: 0, emptyReloadTimeMultiplier: 1 },
  { magazineSize: 32, reloadTime: 1.05, postReloadFireRateMultiplier: 1, postReloadBoostDuration: 0, emptyReloadTimeMultiplier: 1 },
  { magazineSize: 32, reloadTime: 1.05, postReloadFireRateMultiplier: 1.2, postReloadBoostDuration: 1, emptyReloadTimeMultiplier: 1 },
  { magazineSize: 32, reloadTime: 1.05, postReloadFireRateMultiplier: 1.2, postReloadBoostDuration: 1, emptyReloadTimeMultiplier: 0.75 },
] as const;

export const getWeaponRuntimeStats = (levels: WeaponUpgradeLevels): WeaponRuntimeStats => {
  const firepower = FIREPOWER_LEVELS[Math.max(0, Math.min(5, levels.firepowerCalibration))];
  const magazine = MAGAZINE_LEVELS[Math.max(0, Math.min(5, levels.magazineManagement))];
  return {
    damage: DEFAULT_WEAPON.damage * firepower.damageMultiplier,
    fireRate: DEFAULT_WEAPON.fireRate * firepower.fireRateMultiplier,
    spreadDegrees: DEFAULT_WEAPON.spreadDegrees * firepower.spreadMultiplier,
    criticalChance: firepower.criticalChance,
    criticalMultiplier: DEFAULT_WEAPON.criticalMultiplier,
    magazineSize: magazine.magazineSize,
    reloadTime: magazine.reloadTime,
    postReloadFireRateMultiplier: magazine.postReloadFireRateMultiplier,
    postReloadBoostDuration: magazine.postReloadBoostDuration,
    emptyReloadTimeMultiplier: magazine.emptyReloadTimeMultiplier,
  };
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
