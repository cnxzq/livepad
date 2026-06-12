#!/usr/bin/env node
process.env.PORT = process.env.PORT || process.argv.find(a => /^\d+$/.test(a)) || '3000';
require('./server');
