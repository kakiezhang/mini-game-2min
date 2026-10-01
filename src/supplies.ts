export type SupplyKind = "smg" | "ammo" | "medkit";
export type SupplyPosition = { x: number; z: number };

export function pickSupplyPosition(
  origin: SupplyPosition,
  minDistance: number,
  maxDistance: number,
  isValid: (position: SupplyPosition) => boolean,
  random: () => number = Math.random,
  attempts = 80,
): SupplyPosition | undefined {
  for (let index = 0; index < attempts; index += 1) {
    const angle = random() * Math.PI * 2;
    const distance = minDistance + random() * (maxDistance - minDistance);
    const position = {
      x: origin.x + Math.cos(angle) * distance,
      z: origin.z + Math.sin(angle) * distance,
    };
    if (isValid(position)) return position;
  }
  return undefined;
}

export function chooseSupplyKind(hasSmg: boolean, needsHealth: boolean, random: () => number = Math.random): SupplyKind {
  if (!hasSmg) return "smg";
  if (!needsHealth) return "ammo";
  return random() < 0.5 ? "medkit" : "ammo";
}
