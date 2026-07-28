/**
 * Split a large dictionary.json into Firefox-safe chunks (<3MB each).
 * Usage: node scripts/split-dictionary.js [path/to/dictionary.json]
 */
const fs = require("fs");
const path = require("path");

const src = path.resolve(process.argv[2] || "dictionary.json");
const outDir = path.resolve("dict");
const MAX = 3 * 1024 * 1024;

if (!fs.existsSync(src)) {
  console.error("Source not found:", src);
  process.exit(1);
}

console.log("Reading", src, "...");
const data = JSON.parse(fs.readFileSync(src, "utf8"));
fs.mkdirSync(outDir, { recursive: true });

for (const f of fs.readdirSync(outDir)) {
  fs.unlinkSync(path.join(outDir, f));
}

let part = 0;
let buf = "";
let linesInPart = 0;

function flush() {
  if (!buf) return;
  const name = "part-" + String(part).padStart(2, "0") + ".txt";
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(name, (buf.length / 1024 / 1024).toFixed(2) + "MB", linesInPart + " entries");
  part++;
  buf = "";
  linesInPart = 0;
}

const entries = Object.entries(data);
for (const [word, def] of entries) {
  const line = JSON.stringify([String(word).toLowerCase(), def]) + "\n";
  if (buf.length + line.length > MAX && buf.length > 0) flush();
  buf += line;
  linesInPart++;
}
flush();

fs.writeFileSync(
  path.join(outDir, "index.json"),
  JSON.stringify({ parts: part, entries: entries.length, format: "jsonl-array" }, null, 2)
);
console.log("Wrote", part, "parts,", entries.length, "entries ->", outDir);
