const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_KEY || '';

const htmlPath = path.join(__dirname, 'rosinante_spa.html');

http.createServer((req, res) => {
  if (req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let html;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (e) {
    res.writeHead(500);
    res.end('Could not read app file');
    return;
  }

  const inject = `<script>window._SB_URL="${SB_URL}";window._SB_KEY="${SB_KEY}";</script>`;
  html = html.replace('<head>', '<head>' + inject);

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(PORT, () => {
  console.log(`OPTCG app running on port ${PORT}`);
});
