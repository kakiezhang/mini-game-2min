import * as THREE from "three";

export type DynamicPointLightCategory =
  | "ammo"
  | "boss"
  | "bullet"
  | "impact"
  | "muzzle"
  | "objective";

export type DynamicPointLightMode = "normal" | "disabled";
export type DynamicPointLightReason = "desktop-default" | "mobile-default" | "query-on" | "query-off";

const params = new URLSearchParams(window.location.search);
const requestedLightMode = params.get("perfLights");
const mobileLike = navigator.maxTouchPoints > 0 && window.matchMedia("(pointer: coarse)").matches;

const resolveDynamicPointLights = (): {
  mode: DynamicPointLightMode;
  reason: DynamicPointLightReason;
} => {
  if (requestedLightMode === "on") return { mode: "normal", reason: "query-on" };
  if (requestedLightMode === "off") return { mode: "disabled", reason: "query-off" };
  return mobileLike
    ? { mode: "disabled", reason: "mobile-default" }
    : { mode: "normal", reason: "desktop-default" };
};

const dynamicPointLightProfile = resolveDynamicPointLights();

export const renderPerformanceProfile = Object.freeze({
  dynamicPointLights: dynamicPointLightProfile.mode,
  dynamicPointLightsReason: dynamicPointLightProfile.reason,
  mobileLike,
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
