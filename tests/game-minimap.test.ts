import {
  createMinimapViewport,
  projectMinimapPoint,
} from "../src/ui/game-minimap.js";
import { MAP } from "../src/config.js";

const assertNear = (actual: number, expected: number, message: string) => {
  if (Math.abs(actual - expected) > 0.001) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
};

const map = MAP;
const viewport = createMinimapViewport(map, 240, 240, 10);
const topLeft = projectMinimapPoint({ x: 0, z: 0 }, viewport);
const bottomRight = projectMinimapPoint({ x: map.width, z: map.depth }, viewport);
const center = projectMinimapPoint({ x: map.width / 2, z: map.depth / 2 }, viewport);

assertNear(topLeft.y, 10, "the map should preserve the requested vertical padding");
assertNear(topLeft.x, 10, "the map should preserve the requested horizontal padding");
assertNear(bottomRight.x, 230, "the full map width should fit inside the canvas");
assertNear(bottomRight.y, 230, "the full map depth should fit inside the canvas");
assertNear(center.x, 120, "the map center should align with the canvas center");
assertNear(center.y, 120, "the map center should align with the canvas center");
assertNear(topLeft.x + bottomRight.x, 240, "horizontal letterboxing should remain symmetric");

console.info("game minimap tests passed");
