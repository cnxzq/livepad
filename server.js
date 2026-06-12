const http = require('http');
const fs = require('fs');
const path = require('path');

let sharedContent = '';
const clients = new Map(); // id → response

function broadcast(content, excludeId) {
  for (const [id, res] of clients) {
    if (id !== excludeId) {
      res.write(`data: ${JSON.stringify(content)}\n\n`);
    }
  }
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && req.url === '/events') {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    // Send initial content
    res.write(`event: init\ndata: ${JSON.stringify(sharedContent)}\n\n`);
    clients.set(id, res);

    req.on('close', () => {
      clients.delete(id);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/update') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { content, id } = JSON.parse(body);
        if (typeof content === 'string') {
          sharedContent = content;
          broadcast(content, id);
        }
      } catch {}
      res.writeHead(200);
      res.end();
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

const HOST = '0.0.0.0';
const PORT = process.env.PORT || 3000;
server.listen(PORT, HOST, () => {
  console.log(`livepad running at http://${HOST}:${PORT}`);
});
