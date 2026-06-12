#!/usr/bin/env node
process.env.PORT = process.env.PORT || process.argv[2] || '3000';
require('./server');
