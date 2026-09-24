#!/usr/bin/env node
'use strict';

module.exports = require('@livepad/cli/cli');

if (require.main === module) module.exports.main();
