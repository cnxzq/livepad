'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { version } = require('../packages/cli/package.json');

const [action, ...options] = process.argv.slice(2);
if (!['build', 'push', 'publish'].includes(action)
    || options.some(option => option !== '--dry-run')) {
  console.error('Usage: node scripts/docker.js <build|push|publish> [--dry-run]');
  process.exit(1);
}

const image = 'zqzyz/livepad';
const tags = [`${image}:v${version}`, `${image}:latest`];
const cwd = path.resolve(__dirname, '..');
const dryRun = options.includes('--dry-run');

function docker(args) {
  console.log(`> docker ${args.join(' ')}`);
  if (dryRun) return;

  const result = spawnSync('docker', args, { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(`Unable to run Docker: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (action === 'build' || action === 'publish') {
  docker(['build', '-t', tags[0], '-t', tags[1], '.']);
}
if (action === 'push' || action === 'publish') {
  for (const tag of tags) docker(['push', tag]);
}
