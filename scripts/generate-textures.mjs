import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = join(process.cwd(), "src/assets/textures");
const tmpDir = join(process.cwd(), ".texture-tmp");
mkdirSync(outDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

const rand = (seedText) => {
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("\"", "&quot;");

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${body}</svg>`;

const speckles = (rng, colors, count, alpha = 0.22) => {
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const size = 1 + Math.floor(rng() * 5);
    const color = colors[Math.floor(rng() * colors.length)];
    parts.push(`<rect x="${Math.floor(rng() * 512)}" y="${Math.floor(rng() * 512)}" width="${size}" height="${size}" fill="${color}" opacity="${(alpha * (0.35 + rng())).toFixed(3)}"/>`);
  }
  return parts.join("");
};

const textureSvg = {
  "floor-tile": () => {
    const rng = rand("floor-tile");
    let body = `<rect width="512" height="512" fill="#2b4248"/>`;
    body += speckles(rng, ["#17282c", "#5f7575", "#8ba2a1", "#22383d"], 1250, 0.2);
    for (let pos = 0; pos <= 512; pos += 96) {
      body += `<path d="M ${pos} 0 L ${pos} 512 M 0 ${pos} L 512 ${pos}" stroke="#101819" stroke-width="7" opacity="0.62"/>`;
      body += `<path d="M ${pos + 2} 0 L ${pos + 2} 512 M 0 ${pos + 2} L 512 ${pos + 2}" stroke="#708486" stroke-width="1.5" opacity="0.2"/>`;
    }
    for (let index = 0; index < 34; index += 1) {
      const x = Math.floor(rng() * 512);
      const y = Math.floor(rng() * 512);
      body += `<path d="M ${x} ${y} l ${Math.floor(rng() * 80 - 40)} ${Math.floor(rng() * 22 - 11)}" stroke="#b8c1b6" stroke-width="${(0.8 + rng() * 1.6).toFixed(2)}" opacity="0.17"/>`;
    }
    return svg(body);
  },
  wall: () => {
    const rng = rand("wall");
    let body = `<rect width="512" height="512" fill="#879186"/>`;
    body += speckles(rng, ["#59635a", "#b5baad", "#6e776d"], 850, 0.16);
    body += `<rect x="0" y="244" width="512" height="9" fill="#d6d0b8" opacity="0.34"/>`;
    body += `<rect x="0" y="253" width="512" height="4" fill="#39423b" opacity="0.22"/>`;
    for (let index = 0; index < 18; index += 1) {
      const x = Math.floor(rng() * 512);
      const y = Math.floor(rng() * 512);
      body += `<path d="M ${x} ${y} l ${Math.floor(rng() * 26 - 13)} ${Math.floor(24 + rng() * 52)} l ${Math.floor(rng() * 26 - 13)} ${Math.floor(14 + rng() * 36)}" stroke="#424b43" stroke-width="1.2" fill="none" opacity="0.18"/>`;
    }
    for (let index = 0; index < 16; index += 1) {
      body += `<ellipse cx="${Math.floor(rng() * 512)}" cy="${Math.floor(rng() * 512)}" rx="${Math.floor(9 + rng() * 38)}" ry="${Math.floor(5 + rng() * 24)}" fill="#4d574e" opacity="0.09"/>`;
    }
    return svg(body);
  },
  wood: () => {
    const rng = rand("wood");
    let body = `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#5b371c"/><stop offset="0.48" stop-color="#895f34"/><stop offset="1" stop-color="#b0824b"/></linearGradient></defs>`;
    body += `<rect width="512" height="512" fill="url(#g)"/>`;
    for (let y = 0; y < 512; y += 24) {
      let d = `M 0 ${y + Math.floor(rng() * 12)}`;
      for (let x = 40; x <= 512; x += 40) d += ` C ${x - 25} ${y + Math.floor(rng() * 26 - 13)}, ${x - 10} ${y + Math.floor(rng() * 28 - 14)}, ${x} ${y + Math.floor(rng() * 20 - 10)}`;
      body += `<path d="${escape(d)}" stroke="#2f1b0f" stroke-width="${(2 + rng() * 5).toFixed(2)}" fill="none" opacity="${(0.16 + rng() * 0.14).toFixed(3)}"/>`;
    }
    for (let index = 0; index < 12; index += 1) {
      body += `<ellipse cx="${Math.floor(rng() * 512)}" cy="${Math.floor(rng() * 512)}" rx="${Math.floor(14 + rng() * 36)}" ry="${Math.floor(5 + rng() * 13)}" fill="none" stroke="#321b0c" stroke-width="3" opacity="0.24"/>`;
    }
    return svg(body);
  },
  metal: () => {
    const rng = rand("metal");
    let body = `<defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6f7b82"/><stop offset="0.45" stop-color="#39454d"/><stop offset="1" stop-color="#1f292f"/></linearGradient></defs>`;
    body += `<rect width="512" height="512" fill="url(#m)"/>`;
    for (let y = 0; y < 512; y += 8) {
      body += `<path d="M 0 ${y + Math.floor(rng() * 2)} L 512 ${y + Math.floor(rng() * 2)}" stroke="#d7dee0" stroke-width="1" opacity="${(0.08 + rng() * 0.14).toFixed(3)}"/>`;
    }
    for (let index = 0; index < 24; index += 1) {
      body += `<circle cx="${32 + (index % 6) * 90}" cy="${42 + Math.floor(index / 6) * 135}" r="5" fill="#0d1214" opacity="0.34"/><circle cx="${30 + (index % 6) * 90}" cy="${40 + Math.floor(index / 6) * 135}" r="2" fill="#ccd3d6" opacity="0.18"/>`;
    }
    body += speckles(rng, ["#0f171a", "#a9b2b5", "#59646b"], 360, 0.12);
    return svg(body);
  },
  carpet: () => {
    const rng = rand("carpet");
    let body = `<rect width="512" height="512" fill="#33433b"/>`;
    body += speckles(rng, ["#17241f", "#51655a", "#728175", "#27352f"], 2100, 0.16);
    for (let y = 0; y < 512; y += 9) body += `<path d="M 0 ${y} L 512 ${y + Math.floor(rng() * 4 - 2)}" stroke="#7b887b" stroke-width="1" opacity="0.13"/>`;
    for (let x = 0; x < 512; x += 34) body += `<rect x="${x}" y="0" width="7" height="512" fill="#15211d" opacity="0.08"/>`;
    return svg(body);
  },
  concrete: () => {
    const rng = rand("concrete");
    let body = `<rect width="512" height="512" fill="#28312f"/>`;
    body += speckles(rng, ["#111816", "#49544f", "#6b7064", "#1e2825"], 1800, 0.18);
    for (let index = 0; index < 28; index += 1) {
      const x = Math.floor(rng() * 512);
      const y = Math.floor(rng() * 512);
      body += `<path d="M ${x} ${y} l ${Math.floor(rng() * 82 - 41)} ${Math.floor(rng() * 20 - 10)} l ${Math.floor(rng() * 48 - 24)} ${Math.floor(rng() * 48 - 24)}" stroke="#0d1210" stroke-width="${(0.8 + rng() * 1.8).toFixed(2)}" fill="none" opacity="0.22"/>`;
    }
    for (let index = 0; index < 12; index += 1) {
      body += `<ellipse cx="${Math.floor(rng() * 512)}" cy="${Math.floor(rng() * 512)}" rx="${Math.floor(16 + rng() * 44)}" ry="${Math.floor(8 + rng() * 28)}" fill="#080d0c" opacity="0.12"/>`;
    }
    return svg(body);
  },
  "monkey-fur": () => {
    const rng = rand("monkey-fur");
    let body = `<rect width="512" height="512" fill="#7a4b27"/>`;
    body += speckles(rng, ["#3a2112", "#a56d3b", "#c08a52", "#5a331a"], 1800, 0.2);
    for (let y = 0; y < 512; y += 18) {
      body += `<path d="M 0 ${y} C 90 ${y + Math.floor(rng() * 18 - 9)}, 170 ${y + Math.floor(rng() * 22 - 11)}, 256 ${y} S 430 ${y + Math.floor(rng() * 20 - 10)}, 512 ${y}" stroke="#2d170c" stroke-width="${(1.2 + rng() * 2.8).toFixed(2)}" fill="none" opacity="0.18"/>`;
    }
    body += `<ellipse cx="142" cy="148" rx="68" ry="46" fill="#c99666" opacity="0.45"/>`;
    body += `<ellipse cx="360" cy="346" rx="76" ry="52" fill="#c99666" opacity="0.35"/>`;
    return svg(body);
  },
  "monkey-hoodie": () => {
    const rng = rand("monkey-hoodie");
    let body = `<rect width="512" height="512" fill="#2c524a"/>`;
    body += speckles(rng, ["#17312d", "#3c766c", "#8bdff2", "#214941"], 900, 0.16);
    for (let y = 48; y < 512; y += 72) body += `<path d="M 28 ${y} L 484 ${y}" stroke="#8bdff2" stroke-width="4" opacity="0.2"/>`;
    for (let index = 0; index < 18; index += 1) {
      const x = Math.floor(rng() * 480 + 16);
      const y = Math.floor(rng() * 480 + 16);
      body += `<path d="M ${x} ${y} h ${Math.floor(18 + rng() * 40)} v ${Math.floor(rng() * 36 - 18)}" stroke="#a7f3d0" stroke-width="2" fill="none" opacity="0.22"/>`;
      body += `<circle cx="${x}" cy="${y}" r="3" fill="#a7f3d0" opacity="0.32"/>`;
    }
    body += `<rect x="0" y="230" width="512" height="28" fill="#d6a73a" opacity="0.65"/>`;
    return svg(body);
  },
  "ox-hide": () => {
    const rng = rand("ox-hide");
    let body = `<rect width="512" height="512" fill="#914136"/>`;
    body += speckles(rng, ["#481915", "#c46b56", "#ffb4a8", "#6e241e"], 1300, 0.18);
    for (let index = 0; index < 16; index += 1) {
      body += `<ellipse cx="${Math.floor(rng() * 512)}" cy="${Math.floor(rng() * 512)}" rx="${Math.floor(20 + rng() * 62)}" ry="${Math.floor(14 + rng() * 48)}" fill="#3c1310" opacity="${(0.22 + rng() * 0.18).toFixed(3)}"/>`;
    }
    for (let y = 64; y < 512; y += 86) body += `<path d="M 0 ${y} L 512 ${y + Math.floor(rng() * 12 - 6)}" stroke="#ffd0b8" stroke-width="3" opacity="0.12"/>`;
    return svg(body);
  },
  "horse-hide": () => {
    const rng = rand("horse-hide");
    let body = `<rect width="512" height="512" fill="#315b83"/>`;
    body += speckles(rng, ["#183553", "#60a5fa", "#9bc8ff", "#26486a"], 1300, 0.16);
    for (let x = 20; x < 512; x += 42) {
      body += `<path d="M ${x} 0 C ${x + Math.floor(rng() * 24 - 12)} 120, ${x + Math.floor(rng() * 32 - 16)} 260, ${x} 512" stroke="#10243a" stroke-width="${(4 + rng() * 5).toFixed(2)}" opacity="0.16" fill="none"/>`;
    }
    body += `<path d="M 0 120 C 130 86, 260 150, 512 96" stroke="#cde7ff" stroke-width="10" opacity="0.18" fill="none"/>`;
    return svg(body);
  },
  "meeting-hide": () => {
    const rng = rand("meeting-hide");
    let body = `<rect width="512" height="512" fill="#7650a8"/>`;
    body += speckles(rng, ["#3b225d", "#a78bfa", "#e9d5ff", "#5f3a88"], 1500, 0.16);
    for (let index = 0; index < 22; index += 1) {
      body += `<circle cx="${Math.floor(rng() * 512)}" cy="${Math.floor(rng() * 512)}" r="${Math.floor(8 + rng() * 30)}" fill="none" stroke="#e9d5ff" stroke-width="4" opacity="0.13"/>`;
    }
    return svg(body);
  },
  "boss-bull": () => {
    const rng = rand("boss-bull");
    let body = `<rect width="512" height="512" fill="#3b2014"/>`;
    body += speckles(rng, ["#160b07", "#7a3d20", "#d08a4c", "#2b140c"], 1100, 0.16);
    for (let x = 28; x < 512; x += 42) body += `<path d="M ${x} 0 L ${x + Math.floor(rng() * 8 - 4)} 512" stroke="#ffd166" stroke-width="2" opacity="0.16"/>`;
    body += `<rect x="220" y="0" width="72" height="512" fill="#7f1d1d" opacity="0.48"/>`;
    body += `<path d="M 0 256 L 512 256" stroke="#f2c9a8" stroke-width="18" opacity="0.16"/>`;
    return svg(body);
  },
};

for (const [name, buildSvg] of Object.entries(textureSvg)) {
  const svgPath = join(tmpDir, `${name}.svg`);
  const pngPath = join(outDir, `${name}.png`);
  writeFileSync(svgPath, buildSvg(), "utf8");
  execFileSync("magick", [svgPath, "-resize", "512x512!", pngPath], { stdio: "inherit" });
}

rmSync(tmpDir, { recursive: true, force: true });
