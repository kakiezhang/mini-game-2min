import {
  ELEVATOR_FRAME_LAYOUT,
  type ElevatorBoxLayout,
} from "../src/elevator-layout.js";

const entries = Object.entries(ELEVATOR_FRAME_LAYOUT);

const overlapsWithVolume = (a: ElevatorBoxLayout, b: ElevatorBoxLayout) => (
  Math.abs(a.x - b.x) < (a.width + b.width) / 2
  && Math.abs(a.y - b.y) < (a.height + b.height) / 2
  && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2
);

for (let firstIndex = 0; firstIndex < entries.length; firstIndex += 1) {
  for (let secondIndex = firstIndex + 1; secondIndex < entries.length; secondIndex += 1) {
    const [firstName, first] = entries[firstIndex];
    const [secondName, second] = entries[secondIndex];
    if (overlapsWithVolume(first, second)) {
      throw new Error(`elevator frame pieces must not overlap: ${firstName} and ${secondName}`);
    }
  }
}

console.info("elevator layout tests passed");
