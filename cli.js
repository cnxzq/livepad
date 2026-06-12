#!/usr/bin/env node
const { start } = require('./server');

const port = parseInt(process.env.PORT || process.argv[2] || 3000, 10);

start({ port }).catch((err) => {
  console.error('Failed to start livepad:', err.message);
  process.exit(1);
});
