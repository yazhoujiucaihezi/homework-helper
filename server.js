'use strict';

/**
 * 可选的本地服务：静态文件 + CORS 转发
 * 运行：node server.js
 * 默认 http://localhost:8787
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 8787;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-target-url',
  'Access-Control-Max-Age': '86400',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/install') rel = '/install.html';

  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // 用户脚本用 text/plain 返回，交给篡改猴拦截；避免浏览器当页面执行
  const isUserScript = /\.user\.js$/i.test(file);

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + rel);
      return;
    }
    const type = isUserScript
      ? 'text/plain; charset=utf-8'
      : MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}

function proxy(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const target = req.headers['x-target-url'];
  if (!target) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS));
    res.end('缺少 x-target-url 请求头');
    return;
  }

  let t;
  try {
    t = new URL(target);
  } catch (_) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS));
    res.end('x-target-url 不是合法地址');
    return;
  }

  const lib = t.protocol === 'https:' ? https : http;
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  delete headers['x-target-url'];
  headers.host = t.host;

  const up = lib.request(
    {
      protocol: t.protocol,
      hostname: t.hostname,
      port: t.port || (t.protocol === 'https:' ? 443 : 80),
      path: t.pathname + t.search,
      method: req.method,
      headers,
    },
    (upRes) => {
      const out = Object.assign({}, upRes.headers, CORS);
      delete out['content-encoding'];
      delete out['transfer-encoding'];
      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);
    }
  );

  up.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS));
      res.end('转发失败：' + err.message);
    } else {
      res.end();
    }
  });

  req.pipe(up);
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (u.pathname === '/proxy') {
      proxy(req, res);
      return;
    }
    serveStatic(req, res, u.pathname);
  })
  .listen(PORT, () => {
    console.log('速答已启动: http://localhost:' + PORT);
    console.log('代理地址（在页面「API 设置」里勾选使用）: http://localhost:' + PORT);
  });
