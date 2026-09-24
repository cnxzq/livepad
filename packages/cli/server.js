'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createConnection } = require('node:net');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3000;
const OWNER_FILENAME = '.livepad-owner';
const OWNER_CONTENT = 'livepad\n';
const TEXT_FILENAME = '.livepad-text.json';
const STAGED_FILE_PREFIX = '.livepad-upload-';
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_ATTEMPTS = 10;

const DEFAULT_LIMITS = Object.freeze({
  maxTextBytes: 1024 * 1024,
  maxUploadBodyBytes: 25 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxFilesPerUpload: 5,
  maxFilenameBytes: 255,
  maxStoredFiles: 100,
  maxStorageBytes: 100 * 1024 * 1024,
  maxSseClients: 32,
  maxSseBufferedBytes: 64 * 1024,
  maxConcurrentUploads: 4,
});

async function logStartupInfo(address, dataDir, accessPassword, logger = console) {
  const hosts = new Map();
  const wildcard = address.address === '0.0.0.0' || address.address === '::';
  if (wildcard) {
    hosts.set('127.0.0.1', 'Local');
    if (address.address === '::') hosts.set('::1', 'Local');
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (address.address === '0.0.0.0' && entry.family !== 'IPv4') continue;
        // Scoped IPv6 addresses cannot be used as ordinary browser URLs.
        if (entry.scopeid || entry.address.includes('%')) continue;
        hosts.set(entry.address, entry.internal ? 'Local' : 'Network');
      }
    }
  } else {
    const loopback = address.address === '::1' || address.address.startsWith('127.');
    if (!address.address.includes('%')) hosts.set(address.address, loopback ? 'Local' : 'Network');
  }
  // Probe only this server's port on local addresses. In particular, an IPv6
  // wildcard listener does not support IPv4 on every operating system.
  const endpoints = await Promise.all([...hosts].map(async ([host, label]) => {
    const reachable = await new Promise(resolve => {
      const socket = createConnection({ host, port: address.port });
      const finish = result => {
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => finish(false), 500);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
    if (!reachable) return null;
    const displayHost = host.includes(':') ? `[${host}]` : host;
    const query = accessPassword === '' ? '' : `?password=${encodeURIComponent(accessPassword)}`;
    return { label, url: `http://${displayHost}:${address.port}/${query}` };
  }));

  const listenHost = address.address.includes(':') ? `[${address.address}]` : address.address;
  logger.log(`livepad listening on ${listenHost}:${address.port}`);
  for (const label of ['Local', 'Network']) {
    for (const endpoint of endpoints) {
      if (endpoint?.label === label) logger.log(`  ${label}: ${endpoint.url}`);
    }
  }
  logger.log(accessPassword === '' ? 'Access password: disabled (--no-password)' : `Access password: ${accessPassword}`);
  logger.log(`Data: ${dataDir}  (text and files preserved; --clear to reset)`);
}

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function validateLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [name, value] of Object.entries(overrides)) {
    if (!(name in DEFAULT_LIMITS)) throw new TypeError(`Unknown limit: ${name}`);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer`);
    }
    limits[name] = value;
  }
  return Object.freeze(limits);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length > 128 || /\p{Cc}/u.test(password)) {
    throw new TypeError('Password must be a string of at most 128 characters without control characters');
  }
  return password;
}

function resolveDataPath(dataDir, name) {
  const targetPath = path.resolve(dataDir, name);
  if (path.dirname(targetPath) !== dataDir) {
    throw new HttpError(400, 'invalid_filename', 'Invalid file name');
  }
  return targetPath;
}

function containsEncodedPath(name) {
  let candidate = name;
  for (let depth = 0; depth < 3; depth += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return false;
    }
    if (decoded === candidate) return false;
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      path.posix.isAbsolute(decoded) ||
      path.win32.isAbsolute(decoded)
    ) {
      return true;
    }
    candidate = decoded;
  }
  return false;
}

function isOwnerFilename(name) {
  return name.toLowerCase() === OWNER_FILENAME;
}

function isStagedFilename(name) {
  return name.toLowerCase().startsWith(STAGED_FILE_PREFIX);
}

function isInternalFilename(name) {
  return isOwnerFilename(name) || isStagedFilename(name) || name.toLowerCase() === TEXT_FILENAME;
}

function sanitizeFilename(input, maxFilenameBytes = DEFAULT_LIMITS.maxFilenameBytes, { normalize = true } = {}) {
  if (typeof input !== 'string') {
    throw new HttpError(400, 'invalid_filename', 'File name must be a string');
  }
  const name = normalize ? input.normalize('NFC') : input;
  if (!name || name === '.' || name === '..') {
    throw new HttpError(400, 'invalid_filename', 'File name is empty or reserved');
  }
  if (Buffer.byteLength(name, 'utf8') > maxFilenameBytes) {
    throw new HttpError(400, 'filename_too_long', `File name exceeds ${maxFilenameBytes} bytes`);
  }
  if (/\p{Cc}/u.test(name) || /[<>:"/\\|?*]/u.test(name)) {
    throw new HttpError(400, 'invalid_filename', 'File name contains unsafe characters');
  }
  if (/[. ]$/u.test(name) || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) {
    throw new HttpError(400, 'invalid_filename', 'Absolute or ambiguous file names are not allowed');
  }
  if (path.posix.basename(name) !== name || path.win32.basename(name) !== name || containsEncodedPath(name)) {
    throw new HttpError(400, 'invalid_filename', 'Path components are not allowed in file names');
  }
  const windowsStem = name.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(windowsStem)) {
    throw new HttpError(400, 'invalid_filename', 'Reserved device names are not allowed');
  }
  if (isInternalFilename(name)) {
    throw new HttpError(400, 'invalid_filename', 'Reserved livepad file name');
  }
  return name;
}

function ensureDataDirectory(dataDir, keepFiles, logger) {
  let stat;
  try {
    stat = fs.lstatSync(dataDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(dataDir);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to use non-directory or symbolic-link data path: ${dataDir}`);
  }
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }

  const ownerPath = resolveDataPath(dataDir, OWNER_FILENAME);
  try {
    const ownerStat = fs.lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || fs.readFileSync(ownerPath, 'utf8') !== OWNER_CONTENT) {
      throw new Error(`Refusing to use data directory with an invalid ownership marker: ${dataDir}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.writeFileSync(ownerPath, OWNER_CONTENT, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }

  const removedStaged = removeRegularFiles(dataDir, isStagedFilename, logger);
  const removedStored = keepFiles
    ? 0
    : removeRegularFiles(dataDir, name => !isOwnerFilename(name) && !isStagedFilename(name), logger);
  return { removedStaged, removedStored };
}

function removeRegularFiles(dataDir, shouldRemove, logger) {
  let removed = 0;
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!shouldRemove(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      logger.warn(`Skipped non-regular entry in livepad data directory: ${entry.name}`);
      continue;
    }
    fs.unlinkSync(resolveDataPath(dataDir, entry.name));
    removed += 1;
  }
  return removed;
}

function readStoredText(dataDir, limits) {
  const textPath = resolveDataPath(dataDir, TEXT_FILENAME);
  let descriptor;
  try {
    const entry = fs.lstatSync(textPath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Stored text must be a regular file');
    descriptor = fs.openSync(textPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limits.maxTextBytes) throw new Error('Stored text exceeds the text limit or is not a regular file');
    const saved = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (!saved || typeof saved.content !== 'string') throw new Error('Stored text has an invalid format');
    return saved.content;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error(`Cannot load stored text: ${error.message}`, { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function persistText(dataDir, content) {
  const stagedPath = resolveDataPath(dataDir, `${STAGED_FILE_PREFIX}text-${randomUUID()}`);
  try {
    const handle = await fs.promises.open(stagedPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ content }), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(stagedPath, resolveDataPath(dataDir, TEXT_FILENAME));
  } finally {
    await fs.promises.unlink(stagedPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function getFiles(dataDir, limits) {
  const files = [];
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || isInternalFilename(entry.name)) continue;
    let name;
    try {
      // Legacy uploads can use a decomposed name distinct from its NFC spelling.
      name = sanitizeFilename(entry.name, limits.maxFilenameBytes, { normalize: false });
    } catch {
      continue;
    }
    const filePath = resolveDataPath(dataDir, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isFile() && !stat.isSymbolicLink()) files.push({ name, size: stat.size });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function splitHeaderParameters(value) {
  const parts = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (quoted && character === '\\') {
      current += character;
      escaped = true;
    } else if (character === '"') {
      current += character;
      quoted = !quoted;
    } else if (character === ';' && !quoted) {
      parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (quoted || escaped) throw new HttpError(400, 'invalid_multipart', 'Malformed quoted parameter');
  parts.push(current.trim());
  return parts;
}

function parseHeaderParameters(value) {
  const segments = splitHeaderParameters(value);
  const type = segments.shift().toLowerCase();
  const parameters = new Map();
  for (const segment of segments) {
    const separator = segment.indexOf('=');
    if (separator <= 0) throw new HttpError(400, 'invalid_multipart', 'Malformed header parameter');
    const name = segment.slice(0, separator).trim().toLowerCase();
    let parameterValue = segment.slice(separator + 1).trim();
    if (!name || parameters.has(name)) {
      throw new HttpError(400, 'invalid_multipart', 'Duplicate or empty header parameter');
    }
    if (parameterValue.startsWith('"')) {
      if (!parameterValue.endsWith('"') || parameterValue.length < 2) {
        throw new HttpError(400, 'invalid_multipart', 'Malformed quoted parameter');
      }
      parameterValue = parameterValue.slice(1, -1).replace(/\\(["\\])/gu, '$1');
    }
    parameters.set(name, parameterValue);
  }
  return { type, parameters };
}

function extractMultipartBoundary(contentType) {
  if (typeof contentType !== 'string' || !contentType) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be multipart/form-data');
  }
  const { type, parameters } = parseHeaderParameters(contentType);
  if (type !== 'multipart/form-data') {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be multipart/form-data');
  }
  const boundary = parameters.get('boundary');
  if (!boundary) throw new HttpError(400, 'missing_boundary', 'Missing multipart boundary');
  if (!/^[0-9A-Za-z'()+_,./:=?-]{1,70}$/u.test(boundary)) {
    throw new HttpError(400, 'invalid_boundary', 'Invalid multipart boundary');
  }
  return boundary;
}

function parsePartHeaders(buffer) {
  if (buffer.length > 8192) throw new HttpError(400, 'invalid_multipart', 'Multipart headers are too large');
  const text = buffer.toString('utf8');
  if (text.includes('\uFFFD')) throw new HttpError(400, 'invalid_multipart', 'Multipart headers are not valid UTF-8');
  const headers = new Map();
  for (const line of text.split('\r\n')) {
    if (!line || /^[ \t]/u.test(line)) throw new HttpError(400, 'invalid_multipart', 'Malformed multipart header');
    const separator = line.indexOf(':');
    if (separator <= 0) throw new HttpError(400, 'invalid_multipart', 'Malformed multipart header');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[a-z0-9-]+$/u.test(name) || !value || headers.has(name)) {
      throw new HttpError(400, 'invalid_multipart', 'Duplicate or invalid multipart header');
    }
    headers.set(name, value);
  }
  return headers;
}

function decodeMultipartFilename(parameters) {
  const encoded = parameters.get('filename*');
  if (encoded !== undefined) {
    const match = /^UTF-8''(.+)$/iu.exec(encoded);
    if (!match) throw new HttpError(400, 'invalid_filename', 'Only UTF-8 encoded file names are supported');
    try {
      return decodeURIComponent(match[1]);
    } catch {
      throw new HttpError(400, 'invalid_filename', 'Malformed encoded file name');
    }
  }
  return parameters.get('filename');
}

function findNextMultipartDelimiter(buffer, delimiter, start) {
  let position = buffer.indexOf(delimiter, start);
  while (position !== -1) {
    const suffix = position + delimiter.length;
    if ((buffer[suffix] === 13 && buffer[suffix + 1] === 10) || (buffer[suffix] === 45 && buffer[suffix + 1] === 45)) {
      return position;
    }
    position = buffer.indexOf(delimiter, position + 1);
  }
  return -1;
}

function parseMultipart(buffer, boundary, limits) {
  const openingDelimiter = Buffer.from(`--${boundary}`, 'ascii');
  const bodyDelimiter = Buffer.from(`\r\n--${boundary}`, 'ascii');
  const headerSeparator = Buffer.from('\r\n\r\n', 'ascii');
  const files = [];
  const fileNames = new Set();
  let cursor = 0;

  while (cursor < buffer.length) {
    if (!buffer.subarray(cursor, cursor + openingDelimiter.length).equals(openingDelimiter)) {
      throw new HttpError(400, 'invalid_multipart', 'Malformed multipart delimiter');
    }
    cursor += openingDelimiter.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) {
      cursor += 2;
      if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;
      if (cursor !== buffer.length) throw new HttpError(400, 'invalid_multipart', 'Unexpected multipart epilogue');
      if (files.length === 0) throw new HttpError(400, 'missing_file', 'No file was uploaded');
      return files;
    }
    if (buffer[cursor] !== 13 || buffer[cursor + 1] !== 10) {
      throw new HttpError(400, 'invalid_multipart', 'Malformed multipart delimiter ending');
    }
    cursor += 2;

    const headerEnd = buffer.indexOf(headerSeparator, cursor);
    if (headerEnd === -1) throw new HttpError(400, 'invalid_multipart', 'Incomplete multipart headers');
    const headers = parsePartHeaders(buffer.subarray(cursor, headerEnd));
    const bodyStart = headerEnd + headerSeparator.length;
    const nextDelimiter = findNextMultipartDelimiter(buffer, bodyDelimiter, bodyStart);
    if (nextDelimiter === -1) throw new HttpError(400, 'invalid_multipart', 'Missing closing multipart boundary');

    const disposition = headers.get('content-disposition');
    if (!disposition) throw new HttpError(400, 'invalid_multipart', 'Missing Content-Disposition header');
    if (headers.has('content-transfer-encoding')) {
      throw new HttpError(400, 'invalid_multipart', 'Content-Transfer-Encoding is not supported');
    }
    const { type, parameters } = parseHeaderParameters(disposition);
    if (type !== 'form-data') throw new HttpError(400, 'invalid_multipart', 'Invalid Content-Disposition');
    const fieldName = parameters.get('name');
    if (fieldName !== 'file' && fieldName !== 'files') {
      throw new HttpError(400, 'invalid_field', 'Only file and files multipart fields are accepted');
    }
    const rawFilename = decodeMultipartFilename(parameters);
    if (rawFilename === undefined || rawFilename === '') {
      throw new HttpError(400, 'invalid_filename', 'Multipart file name is missing');
    }
    const filename = sanitizeFilename(rawFilename, limits.maxFilenameBytes);
    if (fileNames.has(filename)) {
      throw new HttpError(400, 'duplicate_filename', 'Duplicate file names in one upload are not allowed');
    }
    const data = buffer.subarray(bodyStart, nextDelimiter);
    if (data.length > limits.maxFileBytes) {
      throw new HttpError(413, 'file_too_large', `A file exceeds the ${limits.maxFileBytes} byte limit`);
    }
    files.push({ filename, data });
    fileNames.add(filename);
    if (files.length > limits.maxFilesPerUpload) {
      throw new HttpError(413, 'too_many_files', `At most ${limits.maxFilesPerUpload} files may be uploaded at once`);
    }
    cursor = nextDelimiter + 2;
  }
  throw new HttpError(400, 'invalid_multipart', 'Missing closing multipart boundary');
}

function readRequestBody(req, maxBytes) {
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    if (!/^\d+$/u.test(contentLength)) throw new HttpError(400, 'invalid_content_length', 'Invalid Content-Length');
    if (Number(contentLength) > maxBytes) {
      req.resume();
      throw new HttpError(413, 'request_too_large', `Request body exceeds ${maxBytes} bytes`);
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new HttpError(413, 'request_too_large', `Request body exceeds ${maxBytes} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onAborted = () => fail(new HttpError(400, 'request_aborted', 'Request was interrupted'));
    const onError = error => fail(error);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onError);
  });
}

async function writeUploadedFiles(dataDir, files) {
  const staged = [];
  try {
    for (const file of files) {
      const stagedName = `${STAGED_FILE_PREFIX}${randomUUID()}`;
      const stagedPath = resolveDataPath(dataDir, stagedName);
      const stagedItem = { stagedPath, targetPath: resolveDataPath(dataDir, file.filename) };
      staged.push(stagedItem);
      const handle = await fs.promises.open(stagedPath, 'wx', 0o600);
      try {
        await handle.writeFile(file.data);
      } finally {
        await handle.close();
      }
    }
    for (const item of staged) await fs.promises.rename(item.stagedPath, item.targetPath);
  } catch (error) {
    await Promise.allSettled(staged.map(item => fs.promises.unlink(item.stagedPath)));
    throw error;
  }
}

function responseHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  };
}

function sendJson(res, statusCode, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, responseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  }));
  res.end(body);
}

function sendError(res, error) {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message = error instanceof HttpError ? error.message : 'Internal server error';
  const extraHeaders = statusCode === 503 ? { 'Retry-After': '3' }
    : statusCode === 429 ? { 'Retry-After': '60' } : {};
  sendJson(res, statusCode, { error: { code, message } }, extraHeaders);
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError(403, 'invalid_origin', 'Request origin is not allowed');
  }
  if (!req.headers.host || originUrl.host.toLowerCase() !== req.headers.host.toLowerCase()) {
    throw new HttpError(403, 'invalid_origin', 'Cross-origin state changes are not allowed');
  }
}

function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7E]/gu, '_').replace(/["\\]/gu, '_');
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function createLivepadServer(options = {}) {
  const logger = options.logger || console;
  const limits = validateLimits(options.limits);
  const dataDir = path.resolve(options.dataDir || path.join(os.tmpdir(), '.livepad'));
  const keepFiles = options.keepFiles !== false;
  const accessPassword = options.password === undefined ? randomBytes(12).toString('base64url') : validatePassword(options.password);
  const htmlPath = options.htmlPath || path.join(__dirname, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const cleanup = ensureDataDirectory(dataDir, keepFiles, logger);
  if (cleanup.removedStored > 0) logger.log(`Cleared ${cleanup.removedStored} file(s) from the previous session`);
  if (cleanup.removedStaged > 0) logger.log(`Cleared ${cleanup.removedStaged} incomplete upload(s)`);

  let sharedText = readStoredText(dataDir, limits);
  let activeUploads = 0;
  let storageTail = Promise.resolve();
  const clients = new Map();
  const sockets = new Set();
  const passwordHash = createHash('sha256').update(accessPassword).digest();
  const sessionToken = randomBytes(32).toString('base64url');
  const loginAttempts = new Map();

  // Cookie names include the listening port so instances on the same host do
  // not overwrite each other's login. Sessions always rotate with this instance.
  function sessionCookieName() {
    return `livepad_session_${server.address().port}`;
  }

  function isAuthenticated(req) {
    if (accessPassword === '') return true;
    const prefix = `${sessionCookieName()}=`;
    const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
    if (!cookie) return false;
    const token = Buffer.from(cookie.slice(prefix.length), 'utf8');
    const expected = Buffer.from(sessionToken, 'utf8');
    return token.length === expected.length && timingSafeEqual(token, expected);
  }

  async function handleLogin(req, res) {
    assertSameOrigin(req);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] || '')) {
      throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    }
    const now = Date.now();
    const source = req.socket.remoteAddress;
    for (const [ip, attempt] of loginAttempts) {
      if (attempt.expiresAt <= now) loginAttempts.delete(ip);
    }
    let attempt = loginAttempts.get(source);
    if (!attempt) {
      // Keep unauthenticated bookkeeping bounded, even with many source IPs.
      if (loginAttempts.size >= 512) loginAttempts.delete(loginAttempts.keys().next().value);
      attempt = { count: 0, expiresAt: now + LOGIN_WINDOW_MS };
      loginAttempts.set(source, attempt);
    }
    if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
      req.resume();
      throw new HttpError(429, 'login_rate_limited', 'Too many login attempts. Try again in one minute');
    }
    attempt.count += 1;
    const body = await readRequestBody(req, 4096);
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
    }
    if (!parsed || typeof parsed.password !== 'string') {
      throw new HttpError(400, 'invalid_password', 'password must be a string');
    }
    const suppliedHash = createHash('sha256').update(parsed.password).digest();
    if (accessPassword !== '' && !timingSafeEqual(suppliedHash, passwordHash)) {
      throw new HttpError(401, 'invalid_password', 'Incorrect access password');
    }
    loginAttempts.delete(source);
    res.writeHead(204, responseHeaders({
      'Cache-Control': 'no-store',
      'Set-Cookie': `${sessionCookieName()}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict${req.socket.encrypted ? '; Secure' : ''}`,
    }));
    res.end();
  }

  function broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [id, res] of clients) {
      if (res.destroyed || res.writableEnded || res.writableLength > limits.maxSseBufferedBytes) {
        clients.delete(id);
        res.destroy();
        continue;
      }
      try {
        res.write(payload);
      } catch (error) {
        logger.warn(`Closing failed SSE client: ${error.message}`);
        clients.delete(id);
        res.destroy();
      }
    }
  }

  function mutateStorage(operation) {
    const result = storageTail.then(operation, operation);
    storageTail = result.catch(() => {});
    return result;
  }

  async function handleDownload(res, filename) {
    const filePath = resolveDataPath(dataDir, filename);
    let descriptor;
    try {
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) throw new HttpError(404, 'file_not_found', 'File not found');
      res.writeHead(200, responseHeaders({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(filename),
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      }));
      const stream = fs.createReadStream(filePath, { fd: descriptor, autoClose: true });
      descriptor = undefined;
      stream.on('error', error => {
        logger.error(`File download failed: ${error.message}`);
        res.destroy(error);
      });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error.code === 'ENOENT' || error.code === 'ELOOP') {
        throw new HttpError(404, 'file_not_found', 'File not found');
      }
      throw error;
    }
  }

  async function handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      throw new HttpError(400, 'invalid_url', 'Invalid request URL');
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, responseHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'X-Frame-Options': 'DENY',
      }));
      res.end(html);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/auth/login') {
      await handleLogin(req, res);
      return;
    }

    // The HTML contains only the login/app shell. Every data route, including
    // SSE and direct downloads, must pass this gate before parsing its input.
    if (!isAuthenticated(req)) {
      req.resume();
      throw new HttpError(401, 'authentication_required', 'Sign in with the access password from the startup log');
    }

    if (req.method === 'GET' && url.pathname === '/auth/session') {
      res.writeHead(204, responseHeaders({ 'Cache-Control': 'no-store' }));
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      if (clients.size >= limits.maxSseClients) {
        throw new HttpError(503, 'sse_limit_reached', `At most ${limits.maxSseClients} SSE clients may connect`);
      }
      const id = randomUUID();
      res.writeHead(200, responseHeaders({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      }));
      res.write(`event: init\ndata: ${JSON.stringify({ text: sharedText, files: getFiles(dataDir, limits) })}\n\n`);
      clients.set(id, res);
      const removeClient = () => clients.delete(id);
      req.once('close', removeClient);
      res.once('close', removeClient);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/files') {
      sendJson(res, 200, getFiles(dataDir, limits));
      return;
    }

    if (url.pathname.startsWith('/file/')) {
      const encodedName = url.pathname.slice('/file/'.length);
      if (!encodedName || encodedName.includes('/') || /%(?:2f|5c)/iu.test(encodedName)) {
        throw new HttpError(400, 'invalid_filename', 'Path components are not allowed in file names');
      }
      let decodedName;
      try {
        decodedName = decodeURIComponent(encodedName);
      } catch {
        throw new HttpError(400, 'invalid_filename', 'Malformed encoded file name');
      }
      // File-list URLs address the exact stored name, including legacy spelling.
      const filename = sanitizeFilename(decodedName, limits.maxFilenameBytes, { normalize: false });
      if (req.method === 'GET') {
        await handleDownload(res, filename);
        return;
      }
      if (req.method === 'DELETE') {
        assertSameOrigin(req);
        const filePath = resolveDataPath(dataDir, filename);
        await mutateStorage(async () => {
          try {
            const stat = fs.lstatSync(filePath);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new HttpError(404, 'file_not_found', 'File not found');
            fs.unlinkSync(filePath);
          } catch (error) {
            if (error.code === 'ENOENT') throw new HttpError(404, 'file_not_found', 'File not found');
            throw error;
          }
        });
        broadcast('files', getFiles(dataDir, limits));
        res.writeHead(204, responseHeaders({ 'Cache-Control': 'no-store' }));
        res.end();
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/update') {
      assertSameOrigin(req);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] || '')) {
        throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
      }
      const body = await readRequestBody(req, limits.maxTextBytes);
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.content !== 'string') {
        throw new HttpError(400, 'invalid_content', 'content must be a string');
      }
      await mutateStorage(async () => {
        await persistText(dataDir, parsed.content);
        sharedText = parsed.content;
        broadcast('text', sharedText);
      });
      res.writeHead(204, responseHeaders({ 'Cache-Control': 'no-store' }));
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/upload') {
      assertSameOrigin(req);
      if (activeUploads >= limits.maxConcurrentUploads) {
        req.resume();
        throw new HttpError(503, 'upload_limit_reached', 'Too many uploads are in progress');
      }
      const boundary = extractMultipartBoundary(req.headers['content-type']);
      activeUploads += 1;
      try {
        const body = await readRequestBody(req, limits.maxUploadBodyBytes);
        const uploadedFiles = parseMultipart(body, boundary, limits);
        const files = await mutateStorage(async () => {
          const existingFiles = getFiles(dataDir, limits);
          const existingByName = new Map(existingFiles.map(file => [file.name, file.size]));
          const newNames = uploadedFiles.filter(file => !existingByName.has(file.filename));
          const totalFiles = existingFiles.length + newNames.length;
          const replacedBytes = uploadedFiles.reduce((sum, file) => sum + (existingByName.get(file.filename) || 0), 0);
          const uploadedBytes = uploadedFiles.reduce((sum, file) => sum + file.data.length, 0);
          const totalBytes = existingFiles.reduce((sum, file) => sum + file.size, 0) - replacedBytes + uploadedBytes;
          if (totalFiles > limits.maxStoredFiles) {
            throw new HttpError(507, 'storage_file_limit', `Storage is limited to ${limits.maxStoredFiles} files`);
          }
          if (totalBytes > limits.maxStorageBytes) {
            throw new HttpError(507, 'storage_size_limit', `Storage is limited to ${limits.maxStorageBytes} bytes`);
          }
          await writeUploadedFiles(dataDir, uploadedFiles);
          return getFiles(dataDir, limits);
        });
        broadcast('files', files);
        sendJson(res, 201, { uploaded: uploadedFiles.map(file => file.filename), files });
      } finally {
        activeUploads -= 1;
      }
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/files') {
      assertSameOrigin(req);
      await mutateStorage(async () => removeRegularFiles(
        dataDir,
        name => !isInternalFilename(name),
        logger,
      ));
      broadcast('files', getFiles(dataDir, limits));
      res.writeHead(204, responseHeaders({ 'Cache-Control': 'no-store' }));
      res.end();
      return;
    }

    throw new HttpError(404, 'not_found', 'Route not found');
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      if (error.code !== 'request_aborted' && !(error instanceof HttpError)) logger.error(error);
      if (!res.headersSent && !res.destroyed) sendError(res, error);
      else if (!res.writableEnded) res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = Math.max(64, limits.maxSseClients + limits.maxConcurrentUploads + 16);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const heartbeat = setInterval(() => broadcast('heartbeat', Date.now()), 15_000);
  heartbeat.unref();

  function listen({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
    return new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  async function close() {
    clearInterval(heartbeat);
    for (const res of clients.values()) res.end();
    clients.clear();
    if (!server.listening) {
      for (const socket of sockets) socket.destroy();
      await storageTail;
      return;
    }
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    });
    await storageTail;
  }

  return {
    server,
    dataDir,
    limits,
    accessPassword,
    listen,
    close,
    stats: () => ({ clients: clients.size, activeUploads, files: getFiles(dataDir, limits) }),
  };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_LIMITS,
  HttpError,
  createLivepadServer,
  logStartupInfo,
  sanitizeFilename,
  validatePassword,
};

if (require.main === module) {
  require('./cli').main();
}
