'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/u.exec(html)[1];
const flush = () => new Promise(resolve => setImmediate(resolve));

// Run the shipped UI script with controlled HTTP responses and SSE events.
async function createPage(fetchImpl, { sessionStatus = 204, href = 'http://localhost/' } = {}) {
  const elements = new Map();
  const streams = [];
  const timers = new Map();
  const location = { href };
  let nextTimer = 0;
  let now = 1000;
  const element = () => ({
    value: '', textContent: '', style: {}, events: {},
    classList: { toggle() {} },
    addEventListener(type, listener) { this.events[type] = listener; },
    replaceChildren() {}, append() {},
  });
  const context = vm.createContext({
    URL,
    location,
    history: {
      state: null,
      replaceState(state, title, url) { this.state = state; location.href = new URL(url, location.href).href; },
    },
    navigator: { language: 'en' },
    Date: { now: () => now },
    document: {
      documentElement: {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      querySelectorAll() { return []; },
      createElement: element,
      addEventListener() {},
    },
    EventSource: class {
      constructor() { this.events = {}; streams.push(this); }
      addEventListener(type, listener) { this.events[type] = listener; }
      close() {}
    },
    fetch(url, options) {
      if (url === '/auth/session') return Promise.resolve({ ok: sessionStatus === 204, status: sessionStatus });
      return fetchImpl(url, options);
    },
    console: { error() {} },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(script, context, { filename: 'index.html' });
  await flush();
  return {
    location,
    editor: elements.get('editor'),
    status: elements.get('status'),
    workspace: elements.get('workspace'),
    loginView: elements.get('loginView'),
    loginError: elements.get('loginError'),
    passwordInput: elements.get('passwordInput'),
    streams,
    setSessionStatus(value) { sessionStatus = value; },
    async login(password) {
      this.passwordInput.value = password;
      await elements.get('loginForm').events.submit({ preventDefault() {} });
      await flush();
    },
    init(text) { streams.at(-1).events.init({ data: JSON.stringify({ text, files: [] }) }); },
    text(content) { streams.at(-1).events.text({ data: JSON.stringify(content) }); },
    input(content) { this.editor.value = content; this.editor.events.input(); },
    disconnect() { return streams.at(-1).onerror(); },
    advanceTime(milliseconds) { now += milliseconds; },
    runTimers() {
      for (const [id, callback] of [...timers]) {
        if (timers.delete(id)) callback();
      }
    },
  };
}

test('UI reports rejected updates and preserves the local draft across SSE updates and reconnects', async () => {
  const page = await createPage(async () => ({
    ok: false, status: 413,
    async json() { return { error: { message: 'Request body exceeds 1048576 bytes' } }; },
  }));
  page.init('saved');
  const draft = 'x'.repeat(1024 * 1024);
  page.input(draft);
  await flush();
  assert.match(page.status.textContent, /not synced/iu);
  assert.match(page.status.textContent, /1048576/u);
  page.runTimers();
  assert.equal(page.status.style.opacity, '1', 'unsynced warning must remain visible');
  page.text('another client');
  page.runTimers();
  assert.equal(page.editor.value, draft);
  await page.disconnect();
  page.runTimers();
  page.init('saved');
  assert.equal(page.editor.value, draft);
  assert.match(page.status.textContent, /not synced/iu);
});

test('UI preserves a draft when the update request fails at the network layer', async () => {
  const page = await createPage(async () => { throw new Error('Network unavailable'); });
  page.init('saved');
  page.input('unsent draft');
  await flush();
  assert.match(page.status.textContent, /Network unavailable/u);
  page.init('saved');
  page.text('remote');
  assert.equal(page.editor.value, 'unsent draft');
});

test('UI serializes edits and only acknowledges the latest draft', async () => {
  const calls = [];
  const page = await createPage((url, options) => new Promise(resolve => {
    calls.push({ url, content: JSON.parse(options.body).content, resolve });
  }));
  page.init('saved');
  page.input('first');
  page.input('second');
  page.input('latest');
  assert.equal(calls.length, 1);
  calls[0].resolve({ ok: true, status: 204 });
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].content, 'latest');
  page.text('first');
  page.init('first');
  assert.equal(page.editor.value, 'latest');
  calls[1].resolve({ ok: true, status: 204 });
  await flush();
  assert.doesNotMatch(page.status.textContent, /not synced/iu);
  page.init('another client after success');
  assert.equal(page.editor.value, 'another client after success');
});

test('UI keeps offline edits even when an earlier request later succeeds, then accepts a retry', async () => {
  const calls = [];
  const page = await createPage((url, options) => new Promise(resolve => {
    calls.push({ content: JSON.parse(options.body).content, resolve });
  }));
  page.init('saved');
  page.input('in flight');
  await page.disconnect();
  page.input('offline draft');
  assert.equal(calls.length, 1);
  calls[0].resolve({ ok: true, status: 204 });
  await flush();
  page.runTimers();
  page.init('in flight');
  assert.equal(page.editor.value, 'offline draft');
  assert.match(page.status.textContent, /not synced/iu);
  page.input('retry draft');
  assert.equal(calls.length, 2);
  calls[1].resolve({ ok: true, status: 204 });
  await flush();
  assert.doesNotMatch(page.status.textContent, /not synced/iu);
  page.init('retry draft');
  assert.equal(page.editor.value, 'retry draft');
});

test('UI applies a remote update received while a successful local request is in flight', async () => {
  let acknowledge;
  const page = await createPage(() => new Promise(resolve => { acknowledge = resolve; }));
  page.init('saved');
  page.input('local');
  page.text('local');
  page.text('newer edit from another client');
  assert.equal(page.editor.value, 'local');
  acknowledge({ ok: true, status: 204 });
  await flush();
  page.advanceTime(500);
  page.runTimers();
  assert.equal(page.editor.value, 'newer edit from another client');
});

test('UI shows login first, reports wrong passwords, and connects only after successful login', async () => {
  const page = await createPage(async (url, options) => {
    assert.equal(url, '/auth/login');
    const password = JSON.parse(options.body).password;
    return { ok: password === 'correct', status: password === 'correct' ? 204 : 401 };
  }, { sessionStatus: 401 });
  assert.equal(page.workspace.hidden, true);
  assert.equal(page.loginView.hidden, false);
  assert.equal(page.streams.length, 0);
  await page.login('wrong');
  assert.match(page.loginError.textContent, /incorrect password/iu);
  assert.equal(page.streams.length, 0);
  await page.login('correct');
  assert.equal(page.workspace.hidden, false);
  assert.equal(page.loginView.hidden, true);
  assert.equal(page.passwordInput.value, '');
  assert.equal(page.streams.length, 1);
});

test('UI reports login throttling', async () => {
  const page = await createPage(async () => ({ ok: false, status: 429 }), { sessionStatus: 401 });
  await page.login('wrong');
  assert.match(page.loginError.textContent, /one minute/iu);
  assert.equal(page.workspace.hidden, true);
});

test('UI signs in with the decoded password query and removes only that parameter', async () => {
  const calls = [];
  let completeLogin;
  const page = await createPage((url, options) => {
    calls.push({ url, options });
    return new Promise(resolve => { completeLogin = resolve; });
  }, { sessionStatus: 401, href: 'http://localhost/?view=pad&password=a%2Bb%26c%3Dd%23e#notes' });
  assert.equal(page.location.href, 'http://localhost/?view=pad#notes');
  assert.equal(page.workspace.hidden, true);
  assert.equal(page.streams.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/auth/login');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(JSON.parse(calls[0].options.body).password, 'a+b&c=d#e');
  completeLogin({ ok: true, status: 204 });
  await flush();
  assert.equal(page.workspace.hidden, false);
  assert.equal(page.loginView.hidden, true);
  assert.equal(page.streams.length, 1);
});

for (const [status, message] of [[401, /incorrect password/iu], [429, /one minute/iu]]) {
  test(`UI keeps the login form usable after a password-link response of ${status}`, async () => {
    let responseStatus = status;
    const page = await createPage(async () => ({ ok: responseStatus === 204, status: responseStatus }), {
      sessionStatus: 401, href: 'http://localhost/?password=invalid',
    });
    assert.equal(page.location.href, 'http://localhost/');
    assert.equal(page.workspace.hidden, true);
    assert.equal(page.loginView.hidden, false);
    assert.equal(page.streams.length, 0);
    assert.match(page.loginError.textContent, message);
    responseStatus = 204;
    await page.login('correct');
    assert.equal(page.workspace.hidden, false);
    assert.equal(page.streams.length, 1);
  });
}

test('UI preserves an unsynced draft when an update requires reauthentication', async () => {
  let rejectUpdate = true;
  const page = await createPage(async url => {
    if (url === '/auth/login') return { ok: true, status: 204 };
    return { ok: !rejectUpdate, status: rejectUpdate ? 401 : 204 };
  });
  page.init('saved');
  page.input('local draft');
  await flush();
  assert.equal(page.workspace.hidden, true);
  assert.equal(page.editor.value, 'local draft');
  assert.match(page.loginError.textContent, /sign in again/iu);
  await page.login('new password');
  page.init('server after restart');
  assert.equal(page.editor.value, 'local draft');
  rejectUpdate = false;
  page.input('local draft retried');
  await flush();
  assert.match(page.status.textContent, /Text synced/u);
});

test('UI requires login after an expired SSE session and retains offline edits', async () => {
  const page = await createPage(async () => ({ ok: true, status: 204 }));
  page.init('saved');
  page.setSessionStatus(401);
  await page.disconnect();
  page.input('offline draft');
  assert.equal(page.workspace.hidden, true);
  assert.match(page.loginError.textContent, /sign in again/iu);
  await page.login('new password');
  page.init('saved');
  assert.equal(page.editor.value, 'offline draft');
});
