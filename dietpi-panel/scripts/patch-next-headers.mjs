import fs from 'node:fs';
import path from 'node:path';

const TARGETS = [
  path.join('node_modules', 'next', 'dist', 'server', 'api-utils', 'index.js'),
  path.join('node_modules', 'next', 'dist', 'esm', 'server', 'api-utils', 'index.js'),
];

let patchedCount = 0;

for (const relPath of TARGETS) {
  const fullPath = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) continue;

  const original = fs.readFileSync(fullPath, 'utf8');
  if (!original.includes('headers.hasOwnProperty(')) continue;

  // Next.js 16 calls headers.hasOwnProperty(...) directly, which throws on Node.js 27+ null-prototype headers
  const updated = original.replaceAll('headers.hasOwnProperty(', 'Object.hasOwn(headers, ');
  if (updated !== original) {
    fs.writeFileSync(fullPath, updated, 'utf8');
    patchedCount += 1;
  }
}

if (patchedCount > 0) {
  console.log(`Patched Next.js header checks for Node 27+ compatibility (${patchedCount} files).`);
}
