// Reproducible production distribution builder for GymLog V2.
// Copies only verified runtime assets into dist/, computes a deterministic 16-hex SHA-256 version
// from the runtime files, writes precache.json, and packages dist/ into gymlog-dist-<version>.zip
// (excluding all personal data, CSVs, backups, tests, and dev scripts).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const FORBIDDEN_PATTERNS = [
  /^Garmin_Data/i,
  /^gymlog-personal/i,
  /\.csv$/i,
  /\.fit$/i,
  /\.tcx$/i,
  /\.gpx$/i,
  /\.kmz$/i,
  /\.bak$/i,
  /^gymlog-backup-/i,
  /^gymlog-import-/i,
  /^gymlog-v2-raw-/i,
  /^gymlog-v2-state-/i,
  /^gymlog-source-/i,
  /^gymlog-previous-copy-/i,
  /\.zip$/i,
  /^test\//i,
  /^scripts\//i,
  /^package(-lock)?\.json$/i,
  /^\.git/i,
  /^README\.md$/i,
];

function walkRel(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replaceAll('\\', '/');
    if (entry.isDirectory()) out.push(...walkRel(full, base));
    else out.push(rel);
  }
  return out.sort();
}

export function buildDist({ rootDir = ROOT, outDir = DIST, createZip = true } = {}) {
  const iconFiles = walkRel(path.join(rootDir, 'icons'), rootDir);
  // Exclude Node-only archive helper (src/import/garmin-archive.js) from browser precache/dist
  const srcFiles = walkRel(path.join(rootDir, 'src'), rootDir).filter((f) => f !== 'src/import/garmin-archive.js');

  // Ordered precache file list matching the established precache.json format
  const precacheFiles = [
    ...iconFiles,
    './',
    'manifest.webmanifest',
    'seed-defaults.json',
    ...srcFiles,
  ];

  // Runtime files to copy into dist/ (excluding precache.json which is generated)
  const runtimeFiles = [
    '_headers',
    'index.html',
    'manifest.webmanifest',
    'seed-defaults.json',
    'sw.js',
    ...iconFiles,
    ...srcFiles,
  ];

  for (const rel of runtimeFiles) {
    if (FORBIDDEN_PATTERNS.some((rx) => rx.test(rel))) {
      throw new Error(`Refusing to include forbidden file in build: ${rel}`);
    }
    const full = path.join(rootDir, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing required runtime file: ${rel}`);
    }
  }

  // Compute deterministic 16-hex SHA-256 across all precached files + sw.js + _headers
  const hash = createHash('sha256');
  for (const rel of [...precacheFiles, 'sw.js', '_headers']) {
    const diskRel = rel === './' ? 'index.html' : rel;
    const bytes = fs.readFileSync(path.join(rootDir, diskRel));
    hash.update(`${rel}\0`);
    hash.update(bytes);
    hash.update('\0');
  }
  const version = hash.digest('hex').slice(0, 16);

  const precacheDoc = {
    version,
    files: precacheFiles,
  };
  const precacheJson = `${JSON.stringify(precacheDoc, null, 1)}\n`;

  // Clean and populate dist/
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const rel of runtimeFiles) {
    const srcPath = path.join(rootDir, rel);
    const dstPath = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcPath, dstPath);
  }

  fs.writeFileSync(path.join(outDir, 'precache.json'), precacheJson, 'utf8');
  // Keep root precache.json synchronized for local dev server inspection
  fs.writeFileSync(path.join(rootDir, 'precache.json'), precacheJson, 'utf8');

  // Verify dist/ contains no forbidden files
  const builtFiles = walkRel(outDir, outDir);
  for (const rel of builtFiles) {
    if (FORBIDDEN_PATTERNS.some((rx) => rx.test(rel))) {
      throw new Error(`Forbidden file detected in dist/: ${rel}`);
    }
  }

  let zipPath = null;
  if (createZip) {
    zipPath = path.join(outDir, `gymlog-dist-${version}.zip`);
    writeZipArchive(outDir, builtFiles, zipPath);
  }

  return { version, fileCount: builtFiles.length, precacheCount: precacheFiles.length, outDir, zipPath };
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeZipArchive(baseDir, relFiles, outZipPath) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const rel of relFiles) {
    const posixName = Buffer.from(rel.replaceAll('\\', '/'), 'utf8');
    const raw = fs.readFileSync(path.join(baseDir, rel));
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30 + posixName.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(posixName.length, 26);
    lh.writeUInt16LE(0, 28);
    posixName.copy(lh, 30);

    const cd = Buffer.alloc(46 + posixName.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(posixName.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    posixName.copy(cd, 46);

    localParts.push(lh, data);
    cdParts.push(cd);
    offset += lh.length + data.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(relFiles.length, 8);
  eocd.writeUInt16LE(relFiles.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outZipPath, Buffer.concat([...localParts, cdBuf, eocd]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = buildDist();
  console.log(`Built GymLog V2 dist (version: ${res.version}, files: ${res.fileCount}, precache: ${res.precacheCount})`);
  if (res.zipPath) console.log(`Archive: ${res.zipPath}`);
}
