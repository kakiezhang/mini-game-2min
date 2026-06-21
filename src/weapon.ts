import type { WeaponConfig, WeaponRuntimeStats } from "./config";

export type WeaponUpdate = {
  fired: boolean;
  dryFire: boolean;
  reloadStarted: boolean;
  reloadCompleted: boolean;
};

export type WeaponSnapshot = {
  magazineAmmo: number;
  magazineSize: number;
  reserveAmmo: number;
  reserveAmmoMax: number;
  isReloading: boolean;
  reloadProgress: number;
};

export class WeaponSystem {
  private magazineAmmo: number;
  private reserveAmmo: number;
  private nextShotAt = 0;
  private reloadStartedAt = 0;
  private reloadEndsAt = 0;
  private isReloading = false;
  private nextDryFireAt = 0;
  private postReloadBoostUntil = 0;
  private stats: WeaponRuntimeStats;

  constructor(readonly config: WeaponConfig) {
    this.magazineAmmo = config.magazineSize;
    this.reserveAmmo = config.initialReserveAmmo;
    this.stats = {
      damage: config.damage,
      fireRate: config.fireRate,
      spreadDegrees: config.spreadDegrees,
      criticalChance: config.criticalChance,
      criticalMultiplier: config.criticalMultiplier,
      magazineSize: config.magazineSize,
      reloadTime: config.reloadTime,
      postReloadFireRateMultiplier: 1,
      postReloadBoostDuration: 0,
      emptyReloadTimeMultiplier: 1,
    };
  }

  update(elapsed: number, fireHeld: boolean, reloadPressed: boolean): WeaponUpdate {
    const result = { fired: false, dryFire: false, reloadStarted: false, reloadCompleted: false };

    if (this.isReloading && elapsed >= this.reloadEndsAt) {
      this.finishReload(elapsed);
      result.reloadCompleted = true;
    }

    if (reloadPressed && this.startReload(elapsed)) result.reloadStarted = true;
    if (!fireHeld || this.isReloading || elapsed < this.nextShotAt) return result;

    if (this.magazineAmmo <= 0) {
      if (this.reserveAmmo > 0) result.reloadStarted = this.startReload(elapsed);
      else if (elapsed >= this.nextDryFireAt) {
        this.nextDryFireAt = elapsed + 0.45;
        result.dryFire = true;
      }
      return result;
    }

    this.magazineAmmo -= 1;
    const fireRateMultiplier = elapsed < this.postReloadBoostUntil ? this.stats.postReloadFireRateMultiplier : 1;
    this.nextShotAt = elapsed + 1 / (this.stats.fireRate * fireRateMultiplier);
    result.fired = true;
    return result;
  }

  getSnapshot(elapsed: number): WeaponSnapshot {
    const reloadDuration = Math.max(0.001, this.reloadEndsAt - this.reloadStartedAt);
    const reloadProgress = this.isReloading ? Math.min(1, (elapsed - this.reloadStartedAt) / reloadDuration) : 0;
    return {
      magazineAmmo: this.magazineAmmo,
      magazineSize: this.stats.magazineSize,
      reserveAmmo: this.reserveAmmo,
      reserveAmmoMax: this.config.maxReserveAmmo,
      isReloading: this.isReloading,
      reloadProgress,
    };
  }

  addReserveAmmo(amount: number) {
    const previousAmmo = this.reserveAmmo;
    this.reserveAmmo = Math.min(this.config.maxReserveAmmo, this.reserveAmmo + Math.max(0, amount));
    return this.reserveAmmo - previousAmmo;
  }

  applyStats(stats: WeaponRuntimeStats) {
    this.stats = stats;
    this.magazineAmmo = Math.min(this.magazineAmmo, stats.magazineSize);
  }

  getAttackStats() {
    return {
      damage: this.stats.damage,
      spreadDegrees: this.stats.spreadDegrees,
      criticalChance: this.stats.criticalChance,
      criticalMultiplier: this.stats.criticalMultiplier,
    };
  }

  private startReload(elapsed: number) {
    if (this.isReloading || this.magazineAmmo >= this.stats.magazineSize || this.reserveAmmo <= 0) return false;
    this.isReloading = true;
    this.reloadStartedAt = elapsed;
    const emptyReloadMultiplier = this.magazineAmmo === 0 ? this.stats.emptyReloadTimeMultiplier : 1;
    this.reloadEndsAt = elapsed + this.stats.reloadTime * emptyReloadMultiplier;
    return true;
  }

  private finishReload(elapsed: number) {
    const missingAmmo = this.stats.magazineSize - this.magazineAmmo;
    const loadedAmmo = Math.min(missingAmmo, this.reserveAmmo);
    this.magazineAmmo += loadedAmmo;
    this.reserveAmmo -= loadedAmmo;
    this.isReloading = false;
    this.postReloadBoostUntil = elapsed + this.stats.postReloadBoostDuration;
  }
}
