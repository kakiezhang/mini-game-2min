import * as THREE from "three";

export type DynamicPointLightCategory =
  | "ammo"
  | "boss"
  | "bullet"
  | "impact"
  | "muzzle"
  | "objective";

export type DynamicPointLightMode = "normal" | "disabled";

const params = new URLSearchParams(window.location.search);

export const renderPerformanceProfile = Object.freeze({
  dynamicPointLights: (params.get("perfLights") === "off" ? "disabled" : "normal") as DynamicPointLightMode,
});

export const createDynamicPointLight = (
  category: DynamicPointLightCategory,
  color: THREE.ColorRepresentation,
  intensity: number,
  distance: number,
  decay: number,
) => {
  const light = new THREE.PointLight(color, intensity, distance, decay);
  light.userData.performanceDynamicPointLight = category;
  if (renderPerformanceProfile.dynamicPointLights === "disabled") light.visible = false;
  return light;
};
