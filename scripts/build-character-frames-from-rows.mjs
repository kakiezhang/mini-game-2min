#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const usage = `
Usage:
  node scripts/build-character-frames-from-rows.mjs --input-dir <row-dir> --output-dir <frame-dir>
  node scripts/build-character-frames-from-rows.mjs --input-dir <row-dir> --output-dir <frame-dir> --scale-mode normalize-height

Expected row files:
  row0_down.png
  row1_down_right.png
  ...
  row7_down_left.png
`.trim();

const args = parseArgs(process.argv.slice(2));
if (args.help || !args["input-dir"] || !args["output-dir"]) {
  console.log(usage);
  process.exit(args.help ? 0 : 1);
}

const inputDir = path.resolve(args["input-dir"]);
const outputDir = path.resolve(args["output-dir"]);
const columns = readInteger(args.cols ?? "5", "cols");
const rows = readInteger(args.rows ?? "8", "rows");
const outputWidth = readInteger(args.width ?? "512", "width");
const outputHeight = readInteger(args.height ?? "320", "height");
const padding = readInteger(args.padding ?? "16", "padding");
const scaleMode = readScaleMode(args["scale-mode"] ?? "uniform");
const normalizeHeight = readInteger(args["normalize-height"] ?? String(outputHeight - padding * 2), "normalize-height");

const rowFiles = [
  "row0_down.png",
  "row1_down_right.png",
  "row2_right.png",
  "row3_up_right.png",
  "row4_up.png",
  "row5_up_left.png",
  "row6_left.png",
  "row7_down_left.png",
];

const sourceFrames = [];

for (let row = 0; row < rows; row += 1) {
  const file = path.join(inputDir, rowFiles[row]);
  if (!fs.existsSync(file)) throw new Error(`Missing row image: ${file}`);
  const image = PNG.sync.read(fs.readFileSync(file));
  const backgroundColors = detectBackgroundColors(image);
  const backgroundMask = buildBackgroundMask(image, backgroundColors);
  const mask = buildForegroundMask(backgroundMask);
  const components = findComponents(mask, image.width, image.height)
    .filter((component) => component.area > 1200)
    .sort((first, second) => second.area - first.area)
    .slice(0, columns)
    .sort((first, second) => first.centerX - second.centerX);

  if (components.length !== columns) {
    throw new Error(`Expected ${columns} characters in ${file}, found ${components.length}`);
  }

  for (let column = 0; column < columns; column += 1) {
    sourceFrames.push({
      row,
      column,
      image,
      bounds: expandBounds(components[column], image.width, image.height, 10),
      backgroundColors,
      backgroundMask,
    });
  }
}

const maxWidth = Math.max(...sourceFrames.map((frame) => frame.bounds.width));
const maxHeight = Math.max(...sourceFrames.map((frame) => frame.bounds.height));
const scale = Math.min((outputWidth - padding * 2) / maxWidth, (outputHeight - padding * 2) / maxHeight);
const rowScales = buildRowScales(sourceFrames, rows, scaleMode, scale, normalizeHeight, outputWidth, outputHeight, padding);

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const sourceFrame of sourceFrames) {
  const output = renderFrame(sourceFrame, outputWidth, outputHeight, padding, rowScales.get(sourceFrame.row) ?? scale);
  fs.writeFileSync(path.join(outputDir, `r${sourceFrame.row}-c${sourceFrame.column}.png`), PNG.sync.write(output));
}

console.log(`Wrote ${sourceFrames.length} frames to ${outputDir}`);
console.log(`Scale mode: ${scaleMode}`);
console.log(`Scale: ${scale.toFixed(4)}`);
if (scaleMode === "normalize-height") {
  console.log(`Normalize height: ${normalizeHeight}px`);
  console.log(`Row scales: ${[...rowScales.entries()].map(([row, rowScale]) => `r${row}=${rowScale.toFixed(4)}`).join(", ")}`);
}

function buildRowScales(sourceFrames, rows, scaleMode, uniformScale, normalizeHeight, outputWidth, outputHeight, padding) {
  const rowScales = new Map();
  if (scaleMode === "uniform") {
    for (let row = 0; row < rows; row += 1) rowScales.set(row, uniformScale);
    return rowScales;
  }

  const maxOutputWidth = outputWidth - padding * 2;
  const maxOutputHeight = outputHeight - padding * 2;
  for (let row = 0; row < rows; row += 1) {
    const rowFrames = sourceFrames.filter((frame) => frame.row === row);
    const rowHeight = median(rowFrames.map((frame) => frame.bounds.height));
    const rowMaxWidth = Math.max(...rowFrames.map((frame) => frame.bounds.width));
    const rowMaxHeight = Math.max(...rowFrames.map((frame) => frame.bounds.height));
    const targetScale = normalizeHeight / rowHeight;
    const fitScale = Math.min(maxOutputWidth / rowMaxWidth, maxOutputHeight / rowMaxHeight);
    rowScales.set(row, Math.min(targetScale, fitScale));
  }
  return rowScales;
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint];
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function detectBackgroundColors(image) {
  const counts = new Map();
  const add = (red, green, blue) => {
    const key = `${Math.round(red / 4) * 4},${Math.round(green / 4) * 4},${Math.round(blue / 4) * 4}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  const sampleBand = Math.max(8, Math.floor(Math.min(image.width, image.height) * 0.04));
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (x > sampleBand && x < image.width - sampleBand && y > sampleBand && y < image.height - sampleBand) continue;
      const index = (y * image.width + x) << 2;
      add(image.data[index], image.data[index + 1], image.data[index + 2]);
    }
  }

  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 4)
    .map(([key]) => {
      const [red, green, blue] = key.split(",").map(Number);
      return { red, green, blue };
    });
}

function buildBackgroundMask(image, backgroundColors) {
  const background = new Uint8Array(image.width * image.height);
  const queueX = new Int32Array(image.width * image.height);
  const queueY = new Int32Array(image.width * image.height);
  let head = 0;
  let tail = 0;

  const enqueue = (x, y) => {
    const index = y * image.width + x;
    if (background[index]) return;
    const pixelIndex = index << 2;
    if (!isBackground(image.data[pixelIndex], image.data[pixelIndex + 1], image.data[pixelIndex + 2], backgroundColors)) return;
    background[index] = 1;
    queueX[tail] = x;
    queueY[tail] = y;
    tail += 1;
  };

  for (let x = 0; x < image.width; x += 1) {
    enqueue(x, 0);
    enqueue(x, image.height - 1);
  }
  for (let y = 0; y < image.height; y += 1) {
    enqueue(0, y);
    enqueue(image.width - 1, y);
  }

  while (head < tail) {
    const x = queueX[head];
    const y = queueY[head];
    head += 1;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || nx >= image.width || ny < 0 || ny >= image.height) continue;
      enqueue(nx, ny);
    }
  }

  return background;
}

function buildForegroundMask(backgroundMask) {
  const mask = new Uint8Array(backgroundMask.length);
  for (let index = 0; index < backgroundMask.length; index += 1) {
    mask[index] = backgroundMask[index] ? 0 : 1;
  }
  return mask;
}

function isBackground(red, green, blue, backgroundColors) {
  for (const color of backgroundColors) {
    if (colorDistance(red, green, blue, color.red, color.green, color.blue) <= 72) return true;
  }
  if (green > 165 && green - red > 60 && green - blue > 45) return true;
  if (Math.abs(red - green) < 8 && Math.abs(red - blue) < 8 && red >= 80 && red <= 180) return true;
  return false;
}

function erodeTinyNoise(mask, width, height) {
  const copy = mask.slice();
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!copy[index]) continue;
      let neighbors = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          neighbors += copy[(y + oy) * width + x + ox];
        }
      }
      if (neighbors <= 2) mask[index] = 0;
    }
  }
}

function findComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  const queueX = new Int32Array(mask.length);
  const queueY = new Int32Array(mask.length);

  for (let startY = 0; startY < height; startY += 1) {
    for (let startX = 0; startX < width; startX += 1) {
      const startIndex = startY * width + startX;
      if (!mask[startIndex] || visited[startIndex]) continue;

      let head = 0;
      let tail = 0;
      queueX[tail] = startX;
      queueY[tail] = startY;
      tail += 1;
      visited[startIndex] = 1;
      let minX = startX;
      let maxX = startX;
      let minY = startY;
      let maxY = startY;
      let area = 0;

      while (head < tail) {
        const x = queueX[head];
        const y = queueY[head];
        head += 1;
        area += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);

        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nextIndex = ny * width + nx;
          if (!mask[nextIndex] || visited[nextIndex]) continue;
          visited[nextIndex] = 1;
          queueX[tail] = nx;
          queueY[tail] = ny;
          tail += 1;
        }
      }

      components.push({
        minX,
        maxX,
        minY,
        maxY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        centerX: (minX + maxX) / 2,
        area,
      });
    }
  }
  return components;
}

function expandBounds(bounds, imageWidth, imageHeight, amount) {
  const minX = Math.max(0, bounds.minX - amount);
  const minY = Math.max(0, bounds.minY - amount);
  const maxX = Math.min(imageWidth - 1, bounds.maxX + amount);
  const maxY = Math.min(imageHeight - 1, bounds.maxY + amount);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function renderFrame(sourceFrame, outputWidth, outputHeight, padding, scale) {
  const output = new PNG({ width: outputWidth, height: outputHeight, colorType: 6 });
  output.data.fill(0);
  const drawnWidth = Math.round(sourceFrame.bounds.width * scale);
  const drawnHeight = Math.round(sourceFrame.bounds.height * scale);
  const offsetX = Math.floor(outputWidth / 2 - drawnWidth / 2);
  const offsetY = outputHeight - padding - drawnHeight;

  for (let y = 0; y < drawnHeight; y += 1) {
    for (let x = 0; x < drawnWidth; x += 1) {
      const sourceX = sourceFrame.bounds.minX + (x + 0.5) / scale - 0.5;
      const sourceY = sourceFrame.bounds.minY + (y + 0.5) / scale - 0.5;
      const sample = sampleBilinear(sourceFrame.image, sourceX, sourceY);
      const nearestX = Math.max(0, Math.min(sourceFrame.image.width - 1, Math.round(sourceX)));
      const nearestY = Math.max(0, Math.min(sourceFrame.image.height - 1, Math.round(sourceY)));
      const alpha = sourceFrame.backgroundMask[nearestY * sourceFrame.image.width + nearestX] ? 0 : sample.alpha;
      const outputIndex = ((offsetY + y) * output.width + offsetX + x) << 2;
      output.data[outputIndex] = alpha > 0 ? sample.red : 0;
      output.data[outputIndex + 1] = alpha > 0 ? sample.green : 0;
      output.data[outputIndex + 2] = alpha > 0 ? sample.blue : 0;
      output.data[outputIndex + 3] = alpha;
    }
  }
  return output;
}

function sampleBilinear(image, x, y) {
  const minX = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const minY = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const maxX = Math.max(0, Math.min(image.width - 1, minX + 1));
  const maxY = Math.max(0, Math.min(image.height - 1, minY + 1));
  const tx = x - Math.floor(x);
  const ty = y - Math.floor(y);
  const top = mixPixel(readPixel(image, minX, minY), readPixel(image, maxX, minY), tx);
  const bottom = mixPixel(readPixel(image, minX, maxY), readPixel(image, maxX, maxY), tx);
  return mixPixel(top, bottom, ty);
}

function readPixel(image, x, y) {
  const index = (y * image.width + x) << 2;
  return {
    red: image.data[index],
    green: image.data[index + 1],
    blue: image.data[index + 2],
    alpha: image.data[index + 3],
  };
}

function mixPixel(first, second, amount) {
  const inverse = 1 - amount;
  return {
    red: Math.round(first.red * inverse + second.red * amount),
    green: Math.round(first.green * inverse + second.green * amount),
    blue: Math.round(first.blue * inverse + second.blue * amount),
    alpha: Math.round(first.alpha * inverse + second.alpha * amount),
  };
}

function colorDistance(redA, greenA, blueA, redB, greenB, blueB) {
  return Math.hypot(redA - redB, greenA - greenB, blueA - blueB);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function readInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected --${label} to be a positive integer, got: ${value}`);
  return parsed;
}

function readScaleMode(value) {
  if (value === "uniform" || value === "normalize-height") return value;
  throw new Error(`Expected --scale-mode to be "uniform" or "normalize-height", got: ${value}`);
}
