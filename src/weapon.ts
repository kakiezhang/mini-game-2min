import type { WeaponConfig } from "./config";

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

  constructor(readonly config: WeaponConfig) {
    this.magazineAmmo = config.magazineSize;
    this.reserveAmmo = config.initialReserveAmmo;
  }

  update(elapsed: number, fireHeld: boolean, reloadPressed: boolean): WeaponUpdate {
    const result = { fired: false, dryFire: false, reloadStarted: false, reloadCompleted: false };

    if (this.isReloading && elapsed >= this.reloadEndsAt) {
      this.finishReload();
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
    this.nextShotAt = elapsed + 1 / this.config.fireRate;
    result.fired = true;
    return result;
  }

  getSnapshot(elapsed: number): WeaponSnapshot {
    const reloadDuration = Math.max(0.001, this.reloadEndsAt - this.reloadStartedAt);
    const reloadProgress = this.isReloading ? Math.min(1, (elapsed - this.reloadStartedAt) / reloadDuration) : 0;
    return {
      magazineAmmo: this.magazineAmmo,
      magazineSize: this.config.magazineSize,
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

  private startReload(elapsed: number) {
    if (this.isReloading || this.magazineAmmo >= this.config.magazineSize || this.reserveAmmo <= 0) return false;
    this.isReloading = true;
    this.reloadStartedAt = elapsed;
    this.reloadEndsAt = elapsed + this.config.reloadTime;
    return true;
  }

  private finishReload() {
    const missingAmmo = this.config.magazineSize - this.magazineAmmo;
    const loadedAmmo = Math.min(missingAmmo, this.reserveAmmo);
    this.magazineAmmo += loadedAmmo;
    this.reserveAmmo -= loadedAmmo;
    this.isReloading = false;
  }
}
