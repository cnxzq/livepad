'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createLivepadServer, logStartupInfo } = require('../server');
const { parseArgs } = require('../cli');

const silentLogger = { log() {}, warn() {}, error() {} };

async function createTestApp(t, options = {}) {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livepad-test-'));
  const dataDir = path.join(testRoot, '.livepad');
  const { beforeStart, authenticate = true, ...serverOptions } = options;
  if (beforeStart) {
    fs.mkdirSync(dataDir);
    beforeStart(dataDir);
  }
  const app = createLivepadServer({ dataDir, logger: silentLogger, ...serverOptions });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await app.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });
  if (authenticate) {
    const response = await login(address, app.accessPassword);
    assert.equal(response.statusCode, 204);
    address.cookie = response.headers['set-cookie'][0].split(';')[0];
  }
  return { app, address, dataDir, testRoot };
}

function request(address, pathname, options = {}) {
  const body = options.body === undefined
    ? undefined
    : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
  const headers = {
    ...(options.authenticate !== false && address.cookie ? { Cookie: address.cookie } : {}),
    ...(options.headers || {}),
  };
  if (body !== undefined && headers['Content-Length'] === undefined) headers['Content-Length'] = body.length;

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      agent: false,
      path: pathname,
      method: options.method || 'GET',
      headers,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function login(address, password, headers = {}) {
  return request(address, '/auth/login', {
    method: 'POST', authenticate: false,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ password }),
  });
}

function multipart(files, boundary = 'livepad-test-boundary', options = {}) {
  const chunks = [];
  for (const [index, file] of files.entries()) {
    const field = file.field || 'file';
    const duplicate = options.duplicateNameParameter && index === 0 ? '; name="files"' : '';
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"${duplicate}; filename="${file.name}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    ));
    chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || ''));
    chunks.push(Buffer.from('\r\n', 'ascii'));
  }
  if (options.close !== false) chunks.push(Buffer.from(`--${boundary}--\r\n`, 'ascii'));
  return Buffer.concat(chunks);
}

function upload(address, files, options = {}) {
  const bodyBoundary = options.bodyBoundary || 'livepad-test-boundary';
  const headerBoundary = options.headerBoundary || bodyBoundary;
  const body = multipart(files, bodyBoundary, options);
  return request(address, '/upload', {
    method: 'POST',
    headers: { 'Content-Type': options.contentType || `multipart/form-data; boundary=${headerBoundary}` },
    body,
  });
}

function connectSse(address) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: address.port, path: '/events', headers: address.cookie ? { Cookie: address.cookie } : {} });
    req.on('error', reject);
    req.on('response', res => {
      res.setEncoding('utf8');
      let buffer = '';
      const events = [];
      const waiters = [];

      const dispatch = event => {
        const waiterIndex = waiters.findIndex(waiter => waiter.type === event.type);
        if (waiterIndex === -1) events.push(event);
        else {
          const [waiter] = waiters.splice(waiterIndex, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(event);
        }
      };
      res.on('data', chunk => {
        buffer += chunk;
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: (.+)$/mu.exec(frame)?.[1] || 'message';
          const data = /^data: (.*)$/mu.exec(frame)?.[1] || '';
          dispatch({ type, data });
          end = buffer.indexOf('\n\n');
        }
      });

      const waitFor = (type, timeout = 2000) => {
        const eventIndex = events.findIndex(event => event.type === type);
        if (eventIndex !== -1) return Promise.resolve(events.splice(eventIndex, 1)[0]);
        return new Promise((resolveEvent, rejectEvent) => {
          const waiter = { type, resolve: resolveEvent };
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            rejectEvent(new Error(`Timed out waiting for SSE event: ${type}`));
          }, timeout);
          waiters.push(waiter);
        });
      };
      resolve({ req, res, waitFor });
    });
  });
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

test('CLI parses legacy and explicit options and rejects illegal arguments', () => {
  assert.deepEqual(parseArgs([], {}), {
    port: 3000,
    host: '0.0.0.0',
    keepFiles: true,
    password: undefined,
    help: false,
    showVersion: false,
  });
  assert.deepEqual(parseArgs(['8080', '--host', '127.0.0.1', '--keep'], {}), {
    port: 8080,
    host: '127.0.0.1',
    keepFiles: true,
    password: undefined,
    help: false,
    showVersion: false,
  });
  assert.throws(() => parseArgs(['--unknown'], {}), /Unknown argument/u);
  assert.throws(() => parseArgs(['--port', '70000'], {}), /1 to 65535/u);
  assert.throws(() => parseArgs(['3000', '3001'], {}), /only be specified once/u);
  assert.throws(() => parseArgs(['--host', '../unsafe'], {}), /Invalid host/u);
});

test('CLI supports fixed passwords, explicit empty passwords, and opt-in clearing', () => {
  assert.equal(parseArgs(['--password', '固定密码 & + #'], {}).password, '固定密码 & + #');
  assert.equal(parseArgs(['--password=-leading-dash'], {}).password, '-leading-dash');
  for (const args of [['--no-password'], ['--password='], ['--password', '']]) {
    assert.equal(parseArgs(args, {}).password, '');
  }
  assert.equal(parseArgs(['--clear'], {}).keepFiles, false);
  for (const args of [['--password'], ['--password', '--keep']]) {
    assert.throws(() => parseArgs(args, {}), /requires a value/u);
  }
  for (const args of [['--no-password', '--password=x'], ['--password=a', '--password=b'], ['--no-password', '--no-password']]) {
    assert.throws(() => parseArgs(args, {}), /only one/u);
  }
  for (const args of [['--keep', '--clear'], ['--clear', '--clear'], ['--keep', '--keep']]) {
    assert.throws(() => parseArgs(args, {}), /only one/u);
  }
  for (const password of ['x'.repeat(129), 'line\nbreak', 'tab\tpassword']) {
    assert.throws(() => parseArgs(['--password', password], {}), /Password must/u);
  }
});

test('starts on loopback, serves HTML, and stops cleanly', async t => {
  const { app, address } = await createTestApp(t);
  assert.equal(address.address, '127.0.0.1');
  const response = await request(address, '/');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^text\/html/u);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/u);
  await app.close();
  assert.equal(app.server.listening, false);
});

test('reports a port-in-use error without crashing', async t => {
  const first = await createTestApp(t);
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livepad-port-test-'));
  const second = createLivepadServer({ dataDir: path.join(secondRoot, '.livepad'), logger: silentLogger });
  t.after(async () => {
    await second.close();
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });
  await assert.rejects(
    second.listen({ host: '127.0.0.1', port: first.address.port }),
    error => error.code === 'EADDRINUSE',
  );
});

test('SSE sends init and text events and removes disconnected clients', async t => {
  const { app, address } = await createTestApp(t);
  const stream = await connectSse(address);
  const init = await stream.waitFor('init');
  assert.deepEqual(JSON.parse(init.data), { text: '', files: [] });
  assert.equal(app.stats().clients, 1);

  const update = await request(address, '/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello' }),
  });
  assert.equal(update.statusCode, 204);
  const textEvent = await stream.waitFor('text');
  assert.equal(JSON.parse(textEvent.data), 'hello');

  stream.res.destroy();
  stream.req.destroy();
  await waitFor(() => app.stats().clients === 0);
});

test('rejects SSE connections beyond the configured limit', async t => {
  const { address } = await createTestApp(t, { limits: { maxSseClients: 1 } });
  const stream = await connectSse(address);
  await stream.waitFor('init');
  const rejected = await request(address, '/events');
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.json().error.code, 'sse_limit_reached');
  stream.res.destroy();
  stream.req.destroy();
});

test('uploads, lists, downloads, and deletes a normal file', async t => {
  const { address } = await createTestApp(t);
  const uploaded = await upload(address, [{ name: 'hello.txt', data: 'hello' }]);
  assert.equal(uploaded.statusCode, 201);
  assert.deepEqual(uploaded.json().uploaded, ['hello.txt']);

  const listed = await request(address, '/files');
  assert.deepEqual(listed.json(), [{ name: 'hello.txt', size: 5 }]);
  const downloaded = await request(address, '/file/hello.txt');
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.body.toString(), 'hello');
  assert.match(downloaded.headers['content-disposition'], /filename\*=UTF-8''hello.txt/u);

  const replaced = await upload(address, [{ name: 'hello.txt', data: 'updated' }]);
  assert.equal(replaced.statusCode, 201);
  assert.equal((await request(address, '/file/hello.txt')).body.toString(), 'updated');

  const deleted = await request(address, '/file/hello.txt', { method: 'DELETE' });
  assert.equal(deleted.statusCode, 204);
  assert.deepEqual((await request(address, '/files')).json(), []);
});

test('accepts an empty file', async t => {
  const { address } = await createTestApp(t);
  const response = await upload(address, [{ name: 'empty.txt', data: Buffer.alloc(0) }]);
  assert.equal(response.statusCode, 201);
  assert.deepEqual((await request(address, '/files')).json(), [{ name: 'empty.txt', size: 0 }]);
});

test('accepts multiple files in one upload', async t => {
  const { address } = await createTestApp(t);
  const response = await upload(address, [
    { name: 'a.txt', data: 'a', field: 'files' },
    { name: 'b.txt', data: 'bb', field: 'files' },
  ]);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().uploaded, ['a.txt', 'b.txt']);
  assert.deepEqual((await request(address, '/files')).json(), [
    { name: 'a.txt', size: 1 },
    { name: 'b.txt', size: 2 },
  ]);
});

test('rejects an oversized file before writing it', async t => {
  const { address } = await createTestApp(t, {
    limits: { maxFileBytes: 8, maxUploadBodyBytes: 1024 },
  });
  const response = await upload(address, [{ name: 'large.bin', data: Buffer.alloc(9) }]);
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, 'file_too_large');
  assert.deepEqual((await request(address, '/files')).json(), []);
});

test('enforces file-count, file-name, and storage quotas', async t => {
  const countApp = await createTestApp(t, { limits: { maxFilesPerUpload: 2 } });
  const tooMany = await upload(countApp.address, [
    { name: 'a.txt', data: 'a' },
    { name: 'b.txt', data: 'b' },
    { name: 'c.txt', data: 'c' },
  ]);
  assert.equal(tooMany.statusCode, 413);
  assert.equal(tooMany.json().error.code, 'too_many_files');

  const nameApp = await createTestApp(t, { limits: { maxFilenameBytes: 8 } });
  const longName = await upload(nameApp.address, [{ name: '123456789', data: 'a' }]);
  assert.equal(longName.statusCode, 400);
  assert.equal(longName.json().error.code, 'filename_too_long');

  const storageApp = await createTestApp(t, { limits: { maxStorageBytes: 5 } });
  const full = await upload(storageApp.address, [{ name: 'six.bin', data: '123456' }]);
  assert.equal(full.statusCode, 507);
  assert.equal(full.json().error.code, 'storage_size_limit');
  assert.deepEqual(storageApp.app.stats().files, []);
});

test('rejects unsafe upload file names and path traversal forms', async t => {
  const { address, testRoot } = await createTestApp(t);
  const invalidNames = [
    '../escape.txt',
    '/tmp/absolute.txt',
    'C:\\temp\\absolute.txt',
    '%2e%2e%2fencoded.txt',
    '<script>.txt',
  ];
  for (const name of invalidNames) {
    const response = await upload(address, [{ name, data: 'bad' }]);
    assert.equal(response.statusCode, 400, name);
    assert.equal(response.json().error.code, 'invalid_filename', name);
  }
  assert.equal(fs.existsSync(path.join(testRoot, 'escape.txt')), false);
});

test('protects internal file names regardless of case on every file route', async t => {
  const { app, address, dataDir } = await createTestApp(t);
  const names = ['.LIVEPAD-OWNER', '.LivePad-Owner', '.LIVEPAD-UPLOAD-probe', '.livepad-text.json', '.LIVEPAD-TEXT.JSON'];
  for (const name of names) {
    const uploaded = await upload(address, [{ name, data: 'must not overwrite internal files' }]);
    assert.equal(uploaded.statusCode, 400, name);
    assert.equal(uploaded.json().error.code, 'invalid_filename');
    for (const method of ['GET', 'DELETE']) {
      const response = await request(address, '/file/' + encodeURIComponent(name), { method });
      assert.equal(response.statusCode, 400, `${method} ${name}`);
    }
  }
  assert.equal(fs.readFileSync(path.join(dataDir, '.livepad-owner'), 'utf8'), 'livepad\n');
  await app.close();
  const restarted = createLivepadServer({ dataDir, keepFiles: true, logger: silentLogger });
  await restarted.close();
});

test('rejects encoded traversal and absolute paths on file routes', async t => {
  const { address } = await createTestApp(t);
  for (const pathname of [
    '/file/%2e%2e%2fsecret.txt',
    '/file/%252e%252e%252fsecret.txt',
    '/file/C%3A%5Ctemp%5Csecret.txt',
  ]) {
    const response = await request(address, pathname);
    assert.equal(response.statusCode, 400, pathname);
  }
});

test('rejects malformed boundaries, duplicate parameters, and illegal media types', async t => {
  const { address } = await createTestApp(t);
  const wrongBoundary = await upload(address, [{ name: 'a.txt', data: 'a' }], { headerBoundary: 'wrong' });
  assert.equal(wrongBoundary.statusCode, 400);
  assert.equal(wrongBoundary.json().error.code, 'invalid_multipart');

  const duplicate = await upload(address, [{ name: 'a.txt', data: 'a' }], { duplicateNameParameter: true });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.json().error.code, 'invalid_multipart');

  const mediaType = await upload(address, [{ name: 'a.txt', data: 'a' }], { contentType: 'application/octet-stream' });
  assert.equal(mediaType.statusCode, 415);
  assert.deepEqual((await request(address, '/files')).json(), []);
});

test('rejects cross-origin state changes when Origin is present', async t => {
  const { address } = await createTestApp(t);
  const response = await request(address, '/update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://attacker.example',
    },
    body: JSON.stringify({ content: 'cross-origin' }),
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'invalid_origin');
});

test('enforces the HTTP request-body limit', async t => {
  const { address } = await createTestApp(t, { limits: { maxTextBytes: 32 } });
  const response = await request(address, '/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'x'.repeat(40) }),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, 'request_too_large');
});

test('cleans up an interrupted upload without leaving partial files', async t => {
  const { app, address, dataDir } = await createTestApp(t, {
    limits: { maxUploadBodyBytes: 1024 },
  });
  const boundary = 'interrupted-boundary';
  const body = multipart([{ name: 'partial.txt', data: 'partial data' }], boundary);
  const req = http.request({
    host: '127.0.0.1',
    port: address.port,
    path: '/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length + 100,
      Cookie: address.cookie,
    },
  });
  req.on('error', () => {});
  req.write(body.subarray(0, Math.floor(body.length / 2)));
  await waitFor(() => app.stats().activeUploads === 1);
  req.destroy();
  await waitFor(() => app.stats().activeUploads === 0);
  assert.deepEqual(app.stats().files, []);
  assert.equal(fs.readdirSync(dataDir).some(name => name.startsWith('.livepad-upload-')), false);
});

test('--clear clears stored text and files without recursively deleting nested entries', async t => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livepad-clean-test-'));
  const dataDir = path.join(testRoot, '.livepad');
  fs.mkdirSync(path.join(dataDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'old.txt'), 'old');
  fs.writeFileSync(path.join(dataDir, '.livepad-text.json'), JSON.stringify({ content: 'old text' }));
  fs.writeFileSync(path.join(dataDir, 'nested', 'keep.txt'), 'keep');
  const app = createLivepadServer({ dataDir, keepFiles: false, logger: silentLogger });
  t.after(async () => {
    await app.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });
  assert.equal(fs.existsSync(path.join(dataDir, 'old.txt')), false);
  assert.equal(fs.existsSync(path.join(dataDir, '.livepad-text.json')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'nested', 'keep.txt')), true);
});

function updateText(address, content) {
  return request(address, '/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
  });
}

test('default restart restores text and files and discards only incomplete staging files', async t => {
  const { app, address, dataDir } = await createTestApp(t, { password: 'fixed password' });
  const content = '持久化文本\nwith emoji 📝 and a lone surrogate \ud800';
  assert.equal((await updateText(address, content)).statusCode, 204);
  assert.equal((await upload(address, [{ name: 'retained.txt', data: 'keep me' }])).statusCode, 201);
  assert.deepEqual((await request(address, '/files')).json(), [{ name: 'retained.txt', size: 7 }]);
  await app.close();
  fs.writeFileSync(path.join(dataDir, '.livepad-upload-text-interrupted'), 'partial');
  const restarted = createLivepadServer({ dataDir, password: 'fixed password', logger: silentLogger });
  try {
    const nextAddress = await restarted.listen({ host: '127.0.0.1', port: address.port });
    assert.equal(restarted.accessPassword, 'fixed password');
    assert.equal((await request(address, '/auth/session')).statusCode, 401);
    const signedIn = await login(nextAddress, 'fixed password');
    nextAddress.cookie = signedIn.headers['set-cookie'][0].split(';')[0];
    assert.equal(fs.existsSync(path.join(dataDir, '.livepad-upload-text-interrupted')), false);
    const stream = await connectSse(nextAddress);
    const init = JSON.parse((await stream.waitFor('init')).data);
    assert.equal(init.text, content);
    assert.deepEqual(init.files, [{ name: 'retained.txt', size: 7 }]);
    stream.res.destroy(); stream.req.destroy();
    assert.equal((await request(nextAddress, '/file/retained.txt')).body.toString(), 'keep me');
    assert.equal((await request(nextAddress, '/files', { method: 'DELETE' })).statusCode, 204);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, '.livepad-text.json'), 'utf8')).content, content);
    assert.equal((await updateText(nextAddress, '')).statusCode, 204);
  } finally { await restarted.close(); }
  const emptyRestart = createLivepadServer({ dataDir, password: '', logger: silentLogger });
  try {
    const emptyAddress = await emptyRestart.listen({ host: '127.0.0.1', port: 0 });
    const stream = await connectSse(emptyAddress);
    assert.deepEqual(JSON.parse((await stream.waitFor('init')).data), { text: '', files: [] });
    stream.res.destroy(); stream.req.destroy();
  } finally { await emptyRestart.close(); }
});

test('concurrent text updates leave persisted text consistent with the last broadcast', async t => {
  const { address, dataDir } = await createTestApp(t);
  const stream = await connectSse(address);
  await stream.waitFor('init');
  const contents = ['first', 'second', 'third', 'fourth'];
  const responses = await Promise.all(contents.map(content => updateText(address, content)));
  assert.ok(responses.every(response => response.statusCode === 204));
  const events = [];
  for (let index = 0; index < contents.length; index += 1) events.push(JSON.parse((await stream.waitFor('text')).data));
  assert.deepEqual([...events].sort(), [...contents].sort());
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, '.livepad-text.json'), 'utf8')).content, events.at(-1));
  assert.equal(fs.readdirSync(dataDir).some(name => name.startsWith('.livepad-upload-')), false);
  stream.res.destroy(); stream.req.destroy();
});

test('a failed text save returns an error and preserves the previous text on disk and in memory', async t => {
  const { address, dataDir } = await createTestApp(t);
  assert.equal((await updateText(address, 'saved')).statusCode, 204);
  const rename = t.mock.method(fs.promises, 'rename', async () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); });
  assert.equal((await updateText(address, 'not saved')).statusCode, 500);
  rename.mock.restore();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, '.livepad-text.json'), 'utf8')).content, 'saved');
  assert.equal(fs.readdirSync(dataDir).some(name => name.startsWith('.livepad-upload-')), false);
  const stream = await connectSse(address);
  assert.equal(JSON.parse((await stream.waitFor('init')).data).text, 'saved');
  stream.res.destroy(); stream.req.destroy();
  assert.equal((await updateText(address, 'retried')).statusCode, 204);
});

test('startup rejects corrupt, oversized, or non-file text storage without replacing it', async t => {
  const { app, dataDir } = await createTestApp(t);
  await app.close();
  const textPath = path.join(dataDir, '.livepad-text.json');
  for (const saved of ['invalid JSON', JSON.stringify({ content: 123 }), ' '.repeat(1025)]) {
    fs.writeFileSync(textPath, saved);
    assert.throws(() => createLivepadServer({ dataDir, limits: { maxTextBytes: 1024 }, logger: silentLogger }), /Cannot load stored text/u);
    assert.equal(fs.readFileSync(textPath, 'utf8'), saved);
  }
  fs.unlinkSync(textPath);
  fs.mkdirSync(textPath);
  assert.throws(() => createLivepadServer({ dataDir, logger: silentLogger }), /regular file/u);
});

test('an explicit empty password allows all data routes without login but retains origin checks', async t => {
  const { app, address, dataDir } = await createTestApp(t, { password: '', authenticate: false });
  assert.equal(app.accessPassword, '');
  assert.equal((await login(address, 'password-from-an-old-link')).statusCode, 204);
  assert.equal((await request(address, '/auth/session')).statusCode, 204);
  assert.equal((await request(address, '/files')).statusCode, 200);
  assert.equal((await updateText(address, 'open note')).statusCode, 204);
  assert.equal((await upload(address, [{ name: 'open.txt', data: 'open file' }])).statusCode, 201);
  assert.equal((await request(address, '/file/open.txt')).body.toString(), 'open file');
  const stream = await connectSse(address);
  assert.equal(JSON.parse((await stream.waitFor('init')).data).text, 'open note');
  stream.res.destroy(); stream.req.destroy();
  assert.equal((await request(address, '/files', { method: 'DELETE', headers: { Origin: 'https://other.example' } })).statusCode, 403);
  assert.equal((await request(address, '/file/open.txt', { method: 'DELETE' })).statusCode, 204);
  assert.equal((await request(address, '/files', { method: 'DELETE' })).statusCode, 204);
  const output = [];
  await logStartupInfo(address, dataDir, app.accessPassword, { log(line) { output.push(line); } });
  assert.ok(output.some(line => line.includes('disabled (--no-password)')));
  assert.ok(output.some(line => line.includes(`http://127.0.0.1:${address.port}/`)));
  assert.ok(output.every(line => !line.includes('?password=')));
});

test('--keep behavior preserves files from the previous session', async t => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livepad-keep-test-'));
  const dataDir = path.join(testRoot, '.livepad');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'kept.txt'), 'kept');
  const app = createLivepadServer({ dataDir, keepFiles: true, logger: silentLogger });
  t.after(async () => {
    await app.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });
  assert.deepEqual(app.stats().files, [{ name: 'kept.txt', size: 4 }]);
});

test('--keep lists, downloads, accounts for, and deletes legacy decomposed file names', async t => {
  const name = 'cafe\u0301.txt';
  const { address, dataDir } = await createTestApp(t, {
    keepFiles: true,
    limits: { maxStorageBytes: 4 },
    beforeStart(dir) { fs.writeFileSync(path.join(dir, name), 'kept'); },
  });
  assert.deepEqual((await request(address, '/files')).json(), [{ name, size: 4 }]);
  const downloaded = await request(address, '/file/' + encodeURIComponent(name));
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.body.toString(), 'kept');
  const overQuota = await upload(address, [{ name: 'extra.txt', data: 'x' }]);
  assert.equal(overQuota.statusCode, 507);
  assert.equal(overQuota.json().error.code, 'storage_size_limit');
  assert.equal(fs.readFileSync(path.join(dataDir, name), 'utf8'), 'kept');
  const deleted = await request(address, '/file/' + encodeURIComponent(name), { method: 'DELETE' });
  assert.equal(deleted.statusCode, 204);
  assert.deepEqual((await request(address, '/files')).json(), []);
});

test('--keep preserves distinct files whose names normalize to the same NFC name', async t => {
  const decomposed = 'cafe\u0301.txt';
  const composed = decomposed.normalize('NFC');
  const { address, dataDir } = await createTestApp(t, {
    keepFiles: true,
    beforeStart(dir) {
      fs.writeFileSync(path.join(dir, decomposed), 'legacy');
      fs.writeFileSync(path.join(dir, composed), 'newer');
    },
  });
  if (fs.readdirSync(dataDir).filter(name => name.normalize('NFC') === composed).length !== 2) {
    t.skip('The filesystem treats canonically equivalent names as the same file');
    return;
  }
  const files = (await request(address, '/files')).json();
  assert.equal(files.length, 2);
  assert.ok(files.some(file => file.name === decomposed && file.size === 6));
  assert.ok(files.some(file => file.name === composed && file.size === 5));
  assert.equal((await request(address, '/file/' + encodeURIComponent(decomposed))).body.toString(), 'legacy');
  assert.equal((await request(address, '/file/' + encodeURIComponent(composed))).body.toString(), 'newer');
  const uploaded = await upload(address, [{ name: decomposed, data: 'replacement' }]);
  assert.equal(uploaded.statusCode, 201);
  assert.deepEqual(uploaded.json().uploaded, [composed]);
  assert.equal(fs.readFileSync(path.join(dataDir, decomposed), 'utf8'), 'legacy');
  assert.equal(fs.readFileSync(path.join(dataDir, composed), 'utf8'), 'replacement');
  assert.equal((await request(address, '/file/' + encodeURIComponent(decomposed), { method: 'DELETE' })).statusCode, 204);
  assert.deepEqual((await request(address, '/files')).json(), [{ name: composed, size: 11 }]);
});

test('requires login on every data route without leaking or changing shared state', async t => {
  const { app, address } = await createTestApp(t);
  await upload(address, [{ name: 'private.txt', data: 'private file contents' }]);
  await request(address, '/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'private note contents' }),
  });
  const routes = [
    ['GET', '/auth/session'], ['GET', '/events'], ['GET', '/files'],
    ['GET', '/file/private.txt'], ['POST', '/update'], ['POST', '/upload'],
    ['DELETE', '/file/private.txt'], ['DELETE', '/files'],
  ];
  for (const [method, route] of routes) {
    const response = await request(address, route, { method, authenticate: false });
    assert.equal(response.statusCode, 401, `${method} ${route}`);
    assert.equal(response.json().error.code, 'authentication_required');
    assert.doesNotMatch(response.body.toString(), /private (?:file|note) contents/u);
  }
  assert.equal(app.stats().clients, 0);
  assert.equal((await request(address, '/file/private.txt')).body.toString(), 'private file contents');
  const stream = await connectSse(address);
  assert.equal(JSON.parse((await stream.waitFor('init')).data).text, 'private note contents');
  stream.res.destroy(); stream.req.destroy();
  const shell = await request(address, '/', { authenticate: false });
  assert.equal(shell.statusCode, 200);
  assert.match(shell.body.toString(), /id="loginForm"/u);
  assert.match(shell.body.toString(), /id="workspace" hidden/u);
  assert.equal(shell.body.includes(app.accessPassword), false);
  assert.doesNotMatch(shell.body.toString(), /private (?:file|note) contents/u);
});

test('correct password grants an HttpOnly session; wrong, forged, and query credentials fail', async t => {
  const { app, address } = await createTestApp(t, { authenticate: false });
  const wrong = await login(address, 'incorrect');
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  const response = await login(address, app.accessPassword);
  assert.equal(response.statusCode, 204);
  const cookie = response.headers['set-cookie'][0];
  assert.match(cookie, /; HttpOnly(?:;|$)/u);
  assert.match(cookie, /; SameSite=Strict(?:;|$)/u);
  assert.match(cookie, /; Path=\//u);
  assert.equal(cookie.includes(app.accessPassword), false);
  address.cookie = cookie.split(';')[0];
  assert.equal((await request(address, '/auth/session')).statusCode, 204);
  assert.equal((await request(address, '/files')).statusCode, 200);
  const forged = address.cookie.replace(/=.+$/u, '=' + 'x'.repeat(43));
  assert.equal((await request(address, '/files', { headers: { Cookie: forged } })).statusCode, 401);
  assert.equal((await request(address, '/files?password=' + app.accessPassword, { authenticate: false })).statusCode, 401);
});

test('login enforces same origin, JSON, and a bounded body', async t => {
  const { app, address } = await createTestApp(t, { authenticate: false });
  const foreign = await login(address, app.accessPassword, { Origin: 'https://other.example' });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.headers['set-cookie'], undefined);
  const form = await request(address, '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=' + app.accessPassword,
  });
  assert.equal(form.statusCode, 415);
  assert.equal((await login(address, 'x'.repeat(4096))).statusCode, 413);
  const malformed = await request(address, '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal((await login(address, 123)).statusCode, 400);
  assert.equal((await login(address, app.accessPassword, { Origin: `http://127.0.0.1:${address.port}` })).statusCode, 204);
});

test('login throttles repeated failed attempts without blocking existing sessions', async t => {
  const { app, address } = await createTestApp(t);
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await login(address, 'incorrect')).statusCode, 401);
  }
  const response = await login(address, app.accessPassword);
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error.code, 'login_rate_limited');
  assert.equal(response.headers['retry-after'], '60');
  assert.equal((await request(address, '/files')).statusCode, 200);
});

test('restarting rotates both the password and session, even with --keep on the same port', async t => {
  const { app, address, dataDir } = await createTestApp(t);
  await upload(address, [{ name: 'kept.txt', data: 'retained' }]);
  const previousPassword = app.accessPassword;
  await app.close();
  const restarted = createLivepadServer({ dataDir, keepFiles: true, logger: silentLogger });
  try {
    await restarted.listen({ host: '127.0.0.1', port: address.port });
    assert.notEqual(restarted.accessPassword, previousPassword);
    assert.match(restarted.accessPassword, /^[\w-]{16}$/u);
    assert.equal((await request(address, '/files')).statusCode, 401);
    assert.equal((await login(address, previousPassword)).statusCode, 401);
    const response = await login(address, restarted.accessPassword);
    assert.equal(response.statusCode, 204);
    address.cookie = response.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(address, '/file/kept.txt')).body.toString(), 'retained');
  } finally { await restarted.close(); }
});

test('startup output includes password query parameters in access URLs', async t => {
  const { app, address, dataDir } = await createTestApp(t, { password: '指定密码 +&#?= example' });
  const output = [];
  await logStartupInfo(address, dataDir, app.accessPassword, { log(line) { output.push(line); } });
  assert.equal(output.filter(line => line === `Access password: ${app.accessPassword}`).length, 1);
  assert.ok(output.some(line => line.includes(`http://127.0.0.1:${address.port}`)));
  for (const line of output.filter(line => line.includes('http://'))) {
    const url = new URL(line.trim().split(' ')[1]);
    assert.equal(url.pathname, '/');
    assert.equal(url.searchParams.get('password'), app.accessPassword);
  }
});
