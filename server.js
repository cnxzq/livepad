const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Temp file storage ---
const DATA_DIR = path.join(os.tmpdir(), '.livepad');
const KEEP_FILES = process.argv.includes('--keep');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} else if (!KEEP_FILES) {
  // Clear existing files on startup (privacy)
  const existing = fs.readdirSync(DATA_DIR);
  if (existing.length > 0) {
    for (const f of existing) {
      fs.rmSync(path.join(DATA_DIR, f), { force: true });
    }
    console.log(`Cleared ${existing.length} file(s) from previous session`);
  }
}

// --- Shared state ---
let sharedText = '';

function getFiles() {
  return fs.readdirSync(DATA_DIR).map(name => {
    const stat = fs.statSync(path.join(DATA_DIR, name));
    return { name, size: stat.size };
  });
}

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.values()) {
    res.write(payload);
  }
}

const clients = new Map(); // id → response

// --- Multipart parser (Buffer-based, handles UTF-8 filenames) ---
function parseMultipart(buf, boundary) {
  const result = {};
  const bBoundary = Buffer.from('--' + boundary);
  const bEnd = Buffer.from('--' + boundary + '--');
  const bCRLFCRLF = Buffer.from('\r\n\r\n');
  const bCRLF = Buffer.from('\r\n');

  let pos = buf.indexOf(bBoundary);
  while (pos !== -1) {
    pos += bBoundary.length;
    // Skip CRLF after boundary
    if (buf[pos] === 13 && buf[pos + 1] === 10) pos += 2;

    const headerEnd = buf.indexOf(bCRLFCRLF, pos);
    if (headerEnd === -1) break;

    // Parse headers as UTF-8
    const headerSection = buf.slice(pos, headerEnd).toString('utf-8');

    // Find next boundary (or end boundary)
    const nextBoundary = buf.indexOf(bBoundary, headerEnd + 4);
    let bodyEnd = nextBoundary;
    if (bodyEnd === -1) bodyEnd = buf.indexOf(bEnd, headerEnd + 4);
    if (bodyEnd === -1) break;

    // Body data (trim trailing CRLF before boundary)
    let bodyData = buf.slice(headerEnd + 4, bodyEnd);
    if (bodyData.length >= 2 && bodyData[bodyData.length - 2] === 13) {
      bodyData = bodyData.slice(0, bodyData.length - 2);
    }

    // Parse Content-Disposition
    const cdMatch = headerSection.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/);
    if (!cdMatch) { pos = buf.indexOf(bBoundary, pos); continue; }

    const fieldName = cdMatch[1];
    const filename = cdMatch[2];

    if (filename) {
      // Decode filename: try RFC 5987 first, then raw
      let decodedName = filename;
      const fstar = headerSection.match(/filename\*=UTF-8''([^;\r\n]+)/);
      if (fstar) decodedName = decodeURIComponent(fstar[1]);
      result[fieldName] = { filename: path.basename(decodedName), data: bodyData };
    } else {
      result[fieldName] = bodyData.toString('utf-8');
    }

    pos = buf.indexOf(bBoundary, bodyEnd);
  }
  return result;
}

// --- Read static HTML ---
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');

// --- HTTP server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET / — serve HTML
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // GET /events — SSE stream
  if (req.method === 'GET' && url.pathname === '/events') {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`event: init\ndata: ${JSON.stringify({ text: sharedText, files: getFiles() })}\n\n`);
    clients.set(id, res);
    req.on('close', () => clients.delete(id));
    return;
  }

  // GET /files — list files (for download URLs, etc.)
  if (req.method === 'GET' && url.pathname === '/files') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getFiles()));
    return;
  }

  // GET /file/:name — download a file
  if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
    const fname = decodeURIComponent(path.basename(url.pathname.slice(6)));
    const fpath = path.join(DATA_DIR, fname);
    if (!fs.existsSync(fpath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = fs.statSync(fpath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fname)}"`,
      'Content-Length': stat.size,
    });
    fs.createReadStream(fpath).pipe(res);
    return;
  }

  // POST /update — text change
  if (req.method === 'POST' && url.pathname === '/update') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { content } = JSON.parse(body);
        if (typeof content === 'string') {
          sharedText = content;
          broadcast('text', content);
        }
      } catch {}
      res.writeHead(200);
      res.end();
    });
    return;
  }

  // POST /upload — upload file
  if (req.method === 'POST' && url.pathname === '/upload') {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400);
      res.end('Missing boundary');
      return;
    }
    const boundary = boundaryMatch[1];
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const parsed = parseMultipart(buf, boundary);
      const fileField = parsed.file || parsed.files;
      if (fileField && fileField.filename) {
        const safeName = path.basename(fileField.filename);
        fs.writeFileSync(path.join(DATA_DIR, safeName), fileField.data);
        broadcast('files', getFiles());
      }
      res.writeHead(200);
      res.end();
    });
    return;
  }

  // DELETE /file/:name — delete one file
  if (req.method === 'DELETE' && url.pathname.startsWith('/file/')) {
    const fname = decodeURIComponent(path.basename(url.pathname.slice(6)));
    const fpath = path.join(DATA_DIR, fname);
    if (fs.existsSync(fpath)) {
      fs.rmSync(fpath);
      broadcast('files', getFiles());
    }
    res.writeHead(200);
    res.end();
    return;
  }

  // DELETE /files — clear all files
  if (req.method === 'DELETE' && url.pathname === '/files') {
    for (const f of fs.readdirSync(DATA_DIR)) {
      fs.rmSync(path.join(DATA_DIR, f), { force: true });
    }
    broadcast('files', getFiles());
    res.writeHead(200);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

const HOST = '0.0.0.0';
const PORT = process.env.PORT || 3000;
server.listen(PORT, HOST, () => {
  console.log(`livepad running at http://${HOST}:${PORT}`);
  console.log(`Files: ${DATA_DIR}  (--keep to preserve)`);
});
