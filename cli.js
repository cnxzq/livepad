#!/usr/bin/env node
'use strict';

const { createLivepadServer, logStartupInfo, validatePassword, DEFAULT_HOST, DEFAULT_PORT } = require('./server');
const { version } = require('./package.json');

const HELP = `livepad ${version}

Usage:
  livepad [port] [options]

Options:
  -p, --port <port>        Listening port (default: ${DEFAULT_PORT})
  -H, --host <host>        Listening host (default: ${DEFAULT_HOST})
      --password <value>   Use a fixed password (default: random per startup)
      --no-password        Allow access without a password
      --clear              Clear stored text and files on startup
      --keep               Preserve text and files (default; compatibility option)
  -h, --help               Show this help
  -v, --version            Show the version

Environment:
  PORT               Fallback port when --port or [port] is absent
  HOST               Fallback host when --host is absent
`;

function validatePort(value) {
  if (!/^\d+$/u.test(String(value))) throw new Error(`Invalid port: ${value}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Port must be an integer from 1 to 65535: ${value}`);
  }
  return port;
}

function validateHost(value) {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\u0000-\u0020/\\]/u.test(value)) {
    throw new Error(`Invalid host: ${value || '(empty)'}`);
  }
  return value;
}

function parseArgs(args, env = process.env) {
  let portValue;
  let hostValue;
  let keepFiles;
  let password;
  let help = false;
  let showVersion = false;

  const takeValue = (name, index) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`);
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--keep' || argument === '--clear') {
      if (keepFiles !== undefined) throw new Error('Specify only one of --keep or --clear, once');
      keepFiles = argument === '--keep';
    } else if (argument === '--password' || argument.startsWith('--password=') || argument === '--no-password') {
      if (password !== undefined) throw new Error('Specify only one of --password or --no-password, once');
      if (argument === '--no-password') password = '';
      else if (argument.startsWith('--password=')) password = argument.slice('--password='.length);
      else { password = takeValue(argument, index); index += 1; }
      validatePassword(password);
    } else if (argument === '-h' || argument === '--help') {
      help = true;
    } else if (argument === '-v' || argument === '--version') {
      showVersion = true;
    } else if (argument === '-p' || argument === '--port') {
      if (portValue !== undefined) throw new Error('Port may only be specified once');
      portValue = takeValue(argument, index);
      index += 1;
    } else if (argument.startsWith('--port=')) {
      if (portValue !== undefined) throw new Error('Port may only be specified once');
      portValue = argument.slice('--port='.length);
    } else if (argument === '-H' || argument === '--host') {
      if (hostValue !== undefined) throw new Error('Host may only be specified once');
      hostValue = takeValue(argument, index);
      index += 1;
    } else if (argument.startsWith('--host=')) {
      if (hostValue !== undefined) throw new Error('Host may only be specified once');
      hostValue = argument.slice('--host='.length);
    } else if (/^\d+$/u.test(argument)) {
      if (portValue !== undefined) throw new Error('Port may only be specified once');
      portValue = argument;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return {
    port: validatePort(portValue ?? env.PORT ?? DEFAULT_PORT),
    host: validateHost(hostValue ?? env.HOST ?? DEFAULT_HOST),
    keepFiles: keepFiles ?? true,
    password,
    help,
    showVersion,
  };
}

async function main(args = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(args, env);
  } catch (error) {
    console.error(`livepad: ${error.message}`);
    console.error('Run "livepad --help" for usage.');
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.showVersion) {
    console.log(version);
    return;
  }

  let app;
  try {
    app = createLivepadServer({ keepFiles: options.keepFiles, password: options.password });
    const address = await app.listen({ port: options.port, host: options.host });
    await logStartupInfo(address, app.dataDir, app.accessPassword);
  } catch (error) {
    console.error(`livepad failed to start: ${error.code ? `${error.code}: ` : ''}${error.message}`);
    if (app) await app.close().catch(closeError => console.error(`livepad failed to close: ${closeError.message}`));
    process.exitCode = 1;
    return;
  }

  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    console.log(`Stopping livepad (${signal})`);
    try {
      await app.close();
    } catch (error) {
      console.error(`livepad failed to close: ${error.message}`);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { HELP, main, parseArgs, validateHost, validatePort };

if (require.main === module) main();
