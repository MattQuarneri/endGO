import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(exampleDir, '../..');
const workDir = await mkdtemp(join(tmpdir(), 'endgo-consumer-'));
const env = { ...process.env, npm_config_cache: join(workDir, 'npm-cache') };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

try {
  run('npm', ['run', 'build'], rootDir);
  const packed = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', workDir], rootDir)
  )[0];
  const paths = new Set(packed.files.map((file) => file.path));
  for (const required of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/adapters/node.js',
    'dist/adapters/node.d.ts',
    'dist/routers/index.js',
    'dist/routers/index.d.ts',
  ]) {
    assert.ok(paths.has(required), `Package is missing ${required}`);
  }
  assert.ok([...paths].every((path) =>
    path.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(path)
  ));

  await writeFile(join(workDir, 'package.json'), '{"private":true,"type":"module"}\n');
  await copyFile(join(exampleDir, 'app.mjs'), join(workDir, 'app.mjs'));
  run('npm', [
    'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    join(workDir, packed.filename),
  ], workDir);
  const output = run('node', ['app.mjs'], workDir);
  process.stdout.write(output);
  console.log(`Package contents passed: ${packed.files.length} files, ${packed.size} bytes compressed`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
