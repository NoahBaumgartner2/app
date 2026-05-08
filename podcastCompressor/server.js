const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.wasm': 'application/wasm',
  '.mp4':  'video/mp4',
};

http.createServer((req, res) => {
  // Required headers for SharedArrayBuffer (FFmpeg WASM)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');

  let filePath = '.' + req.url.split('?')[0];
  if (filePath === './') filePath = './index.html';

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
  console.log('SharedArrayBuffer aktiviert (COOP/COEP Header gesetzt)');
});