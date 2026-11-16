#!/usr/bin/env node
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  process.stderr.write(`pulse-runner needs Node.js 20 or newer (found ${process.version}).\n`);
  process.exit(1);
}

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2));
