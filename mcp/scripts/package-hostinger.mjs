// Build the upload package for Hostinger's "upload a .zip" path:
//   release/prayer-tower-mcp-hostinger.zip
//     package.json            (no dependencies, no build step)
//     server.js               (entry file)
//     dist/http.bundle.mjs    (the whole server, dependencies included)
//
//   npm run package:hostinger
//
// The zip writer below is a tiny dependency-free implementation (deflate via node:zlib), so entry
// names always use forward slashes (Windows' Compress-Archive in PowerShell 5.1 can write backslashes).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(root, "scripts", "bundle.mjs")], { stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const minimalPkg = {
  name: pkg.name,
  version: pkg.version,
  description: "Prayer Tower MCP server, prebuilt for hosting (no install or build needed). Entry file: server.js",
  type: "module",
  private: true,
  main: "server.js",
  engines: pkg.engines,
  scripts: { start: "node server.js" },
};

const files = [
  ["package.json", Buffer.from(JSON.stringify(minimalPkg, null, 2) + "\n")],
  ["server.js", readFileSync(join(root, "server.js"))],
  ["dist/http.bundle.mjs", readFileSync(join(root, "dist", "http.bundle.mjs"))],
];

// ---- minimal zip (PKZIP 2.0, deflate) ----
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const d = new Date();
const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

const locals = [];
const centrals = [];
let offset = 0;
for (const [name, data] of files) {
  const nameBuf = Buffer.from(name, "utf8");
  const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, nameBuf, comp);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, v2.0 (so the mode bits below apply)
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);
  offset += 30 + nameBuf.length + comp.length;
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const out = join(root, "release", "prayer-tower-mcp-hostinger.zip");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`packaged -> ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
for (const [name, data] of files) console.log(`  ${name}  ${(data.length / 1024).toFixed(0)} KB`);
