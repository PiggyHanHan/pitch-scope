#!/usr/bin/env node
/*!
 * devserver.js — 本地开发用静态服务器（仅用于离线验证）
 *
 * 默认只服务仓库根目录，额外提供一个 POST /__save?path=... 用于把浏览器里
 * 解码出来的 PCM 落盘（浏览器无法直接写文件）。只在开发机本地运行。
 *
 * 用法：node tools/dev/devserver.js [port]
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const ROOT = path.resolve(__dirname, "..", "..");
const PORT = Number(process.argv[2] || 8199);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8"
};

function safeJoin(rel) {
  const abs = path.resolve(ROOT, "." + path.posix.normalize("/" + rel));
  return abs.startsWith(ROOT) ? abs : null;
}

const server = http.createServer(function (req, res) {
  const parsed = url.parse(req.url, true);

  if (req.method === "POST" && parsed.pathname === "/__save") {
    const target = safeJoin(String(parsed.query.path || ""));
    if (!target) {
      res.writeHead(400).end("bad path");
      return;
    }
    const chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () {
      const buf = Buffer.concat(chunks);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      console.log("saved", target, buf.length, "bytes");
      res.writeHead(200, { "content-type": "text/plain" }).end("ok " + buf.length);
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  const file = safeJoin(String(parsed.pathname || "/"));
  if (!file) {
    res.writeHead(400).end("bad path");
    return;
  }

  fs.stat(file, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": stat.size
    });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, "127.0.0.1", function () {
  console.log("devserver on http://127.0.0.1:" + PORT + "/ (root " + ROOT + ")");
});
