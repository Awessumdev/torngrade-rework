import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.argv.includes('--lint') ? 'lint' : 'typecheck';
const roots = ['src', 'tests', 'public', 'app'];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = roots.flatMap(walk).filter((file) => /\.(mjs|js)$/.test(file));

if (mode === 'typecheck') {
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file.replaceAll('\\', '/')], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      process.stderr.write(String(result.error?.message || result.stderr || result.stdout || `Syntax check failed for ${file}`));
      process.exit(result.status ?? 1);
    }
  }
  console.log(`ok - syntax checked ${files.length} JavaScript files`);
} else {
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split(/\n/).map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
    lines.forEach((line, index) => {
      if (/\s+$/.test(line)) {
        throw new Error(`${file}:${index + 1} has trailing whitespace`);
      }
    });
    if (!content.endsWith('\n')) {
      throw new Error(`${file} must end with a newline`);
    }
  }
  console.log(`ok - lint checked ${files.length} JavaScript files`);
}
