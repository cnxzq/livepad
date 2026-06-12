const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

function start({ port = 3000, host = '0.0.0.0' } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  let sharedContent = '';

  // Serve the static HTML page
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.emit('init', sharedContent);

    socket.on('text-changed', (newContent) => {
      if (typeof newContent === 'string') {
        sharedContent = newContent;
        socket.broadcast.emit('text-update', newContent);
      }
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`livepad running at http://${host}:${port}`);
      resolve(server);
    });
  });
}

module.exports = { start };
