#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function copyFile(source, target) {
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const dist = path.join(root, 'dist');

  await copyFile(path.join(root, 'app.js'), path.join(dist, 'app.js'));
  await copyFile(path.join(root, 'lib', 'karaoke-settings.js'), path.join(dist, 'lib', 'karaoke-settings.js'));
  await copyFile(path.join(root, 'lib', 'karaoke-core.js'), path.join(dist, 'lib', 'karaoke-core.js'));
  await copyFile(
    path.join(root, 'public', 'vendor', 'angular.min.js'),
    path.join(dist, 'vendor', 'angular.min.js'),
  );
  await ensureDir(path.join(dist, 'repertory'));
  await fs.cp(path.join(root, 'public', 'repertory'), path.join(dist, 'repertory'), {
    recursive: true,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
