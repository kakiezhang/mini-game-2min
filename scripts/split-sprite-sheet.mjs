#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const usage = `
Usage:
  node scripts/split-sprite-sheet.mjs --input <sheet.png> --output-dir <dir> --cols <n> --rows <n>

Example:
  node scripts/split-sprite-sheet.mjs --input src/assets/characters/player-monkey-sheet.png --output-dir src/assets/characters/player-monkey-frames --cols 5 --rows 8
`.trim();

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.input || !args["output-dir"] || !args.cols || !args.rows) {
  console.log(usage);
  process.exit(args.help ? 0 : 1);
}

const inputPath = path.resolve(args.input);
const outputDir = path.resolve(args["output-dir"]);
const columns = readInteger(args.cols, "cols");
const rows = readInteger(args.rows, "rows");
const source = PNG.sync.read(fs.readFileSync(inputPath));
const cellWidth = source.width / columns;
const cellHeight = source.height / rows;

if (!Number.isInteger(cellWidth) || !Number.isInteger(cellHeight)) {
  throw new Error(`Sheet size ${source.width}x${source.height} is not divisible by ${columns}x${rows}`);
}

fs.mkdirSync(outputDir, { recursive: true });

for (let row = 0; row < rows; row += 1) {
  for (let column = 0; column < columns; column += 1) {
    const frame = new PNG({ width: cellWidth, height: cellHeight, colorType: 6 });
    frame.data.fill(0);
    for (let y = 0; y < cellHeight; y += 1) {
      for (let x = 0; x < cellWidth; x += 1) {
        const sourceIndex = (((row * cellHeight + y) * source.width) + column * cellWidth + x) << 2;
        const outputIndex = (y * cellWidth + x) << 2;
        const alpha = source.data[sourceIndex + 3];
        frame.data[outputIndex] = alpha > 0 ? source.data[sourceIndex] : 0;
        frame.data[outputIndex + 1] = alpha > 0 ? source.data[sourceIndex + 1] : 0;
        frame.data[outputIndex + 2] = alpha > 0 ? source.data[sourceIndex + 2] : 0;
        frame.data[outputIndex + 3] = alpha;
      }
    }
    fs.writeFileSync(path.join(outputDir, `r${row}-c${column}.png`), PNG.sync.write(frame));
  }
}

console.log(`Wrote ${rows * columns} frames to ${outputDir}`);

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
