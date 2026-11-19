// No-login sticky-note board. Zero dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || 'changeme';
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const MAX_TEXT = 280, MAX_NAME = 30, MAX_POSTS_PER_BOARD = 2000;
const COLORS = ['yellow', 'pink', 'green', 'blue', 'orange', 'purple'];

let state = {
  seq: 1,
  active: 'q1',
  boards: [
    { id: 'q1', question: 'Which request on your desk this week needs no AI at all?', locked: false, seq: 1, posts: [], deleted: [] },
    { id: 'q2', question: 'What in your work would you build, not automate? Why?', locked: false, seq: 1, posts: [], deleted: [] },
    { id: 'q3', question: "What would go on your 'out for now' list?", locked: false, seq: 1, posts: [], deleted: [] },
    { id: 'q4', question: 'Who in your company signs off before a tool touches real data?', locked: false, seq: 1, posts: [], deleted: [] },
  ],
};
// Optional: seed questions from env, e.g. BOARD_QUESTIONS='["Q1","Q2"]'
try {
  const qs = JSON.parse(process.env.BOARD_QUESTIONS || 'null');
  if (Array.isArray(qs) && qs.length) state.boards = qs.map((q, i) => ({ id: 'q' + (i + 1), question: String(q), locked: false, seq: 1, posts: [], deleted: [] }));
} catch (e) { console.log('BOARD_QUESTIONS is not valid JSON'); }
try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); console.log('Loaded', DATA_FILE); } catch (e) {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(state), (err) => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  }, 500);
}
const bump = (b) => { state.seq += 1; if (b) b.seq = state.seq; return state.seq; };
const board = (id) => state.boards.find((b) => b.id === id);
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n);

// simple rate limit: per token and per IP
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 120000)) hits.delete(k); }, 60000);

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}
const publicPost = (p) => ({ id: p.id, name: p.name, color: p.color, text: p.text, ts: p.ts, owner: p.owner });
const isHost = (body, url) => (body && body.hostKey === HOST_KEY) || (url && url.searchParams.get('host') === HOST_KEY);

const BOARD_TITLE = process.env.BOARD_TITLE || 'SheCanAI';
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').split('SheCanAI · Response board').join(BOARD_TITLE.replace(/[<>&"]/g, '') + ' · Response board');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(INDEX);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'ok');

    // Sync: returns only what changed since `since` for the requested board (default: active)
    if (req.method === 'GET' && url.pathname === '/api/sync') {
      const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      const host = isHost(null, url);
      const reqBoard = url.searchParams.get('board');
      const b = (host && reqBoard && board(reqBoard)) || board(state.active) || state.boards[0];
      const boardsMeta = state.boards.map((x) => ({ id: x.id, question: x.question, count: x.posts.length, locked: x.locked }));
      const full = since === 0 || url.searchParams.get('bid') !== b.id;
      if (!full && b.seq <= since && state.seq <= since) return send(res, 200, { seq: state.seq, same: true });
      return send(res, 200, {
        seq: state.seq,
        full,
        active: state.active,
        boards: host ? boardsMeta : undefined,
        board: { id: b.id, question: b.question, locked: b.locked, count: b.posts.length },
        posts: (full ? b.posts : b.posts.filter((p) => p.seq > since)).map(publicPost),
        deleted: full ? [] : b.deleted.filter((d) => d.seq > since).map((d) => d.id),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/post') {
      const body = await readBody(req);
      const token = clean(body.token, 64);
      if (!token) return send(res, 400, { error: 'Missing token' });
      if (limited('t:' + token, 1, 3000)) return send(res, 429, { error: 'Slow down a little, try again in a few seconds.' });
      if (limited('ip:' + ip, 120, 60000)) return send(res, 429, { error: 'Too many posts from this network, wait a moment.' });
      const b = board(state.active);
      if (!b) return send(res, 404, { error: 'No board' });
      if (b.locked) return send(res, 403, { error: 'Posting is closed for this question.' });
      if (b.posts.length >= MAX_POSTS_PER_BOARD) return send(res, 403, { error: 'This board is full.' });
      const text = clean(body.text, MAX_TEXT);
      const name = clean(body.name, MAX_NAME) || 'Anonymous';
      const color = COLORS.includes(body.color) ? body.color : 'yellow';
      if (!text) return send(res, 400, { error: 'Write something first.' });
      const seq = bump(b);
      const p = { id: crypto.randomUUID().slice(0, 12), name, color, text, ts: Date.now(), owner: hash(token), seq };
      b.posts.push(p);
      save();
      return send(res, 200, { ok: true, post: publicPost(p), seq });
    }

    if (req.method === 'POST' && url.pathname === '/api/delete') {
      const body = await readBody(req);
      const host = isHost(body);
      for (const b of state.boards) {
        const i = b.posts.findIndex((p) => p.id === body.id);
        if (i === -1) continue;
        if (!host && b.posts[i].owner !== hash(clean(body.token, 64))) return send(res, 403, { error: 'You can only delete your own notes.' });
        b.posts.splice(i, 1);
        b.deleted.push({ id: body.id, seq: bump(b) });
        save();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // Host actions
    if (req.method === 'POST' && url.pathname === '/api/host') {
      const body = await readBody(req);
      if (!isHost(body)) return send(res, 403, { error: 'Wrong host key' });
      const b = board(body.board) || board(state.active);
      switch (body.action) {
        case 'check': return send(res, 200, { ok: true });
        case 'question': b.question = clean(body.question, 300) || b.question; bump(b); break;
        case 'add': {
          const id = 'q' + (Date.now().toString(36));
          state.boards.push({ id, question: clean(body.question, 300) || 'New question', locked: false, seq: 0, posts: [], deleted: [] });
          state.active = id; bump(board(id)); break;
        }
        case 'activate': if (board(body.board)) { state.active = body.board; bump(board(body.board)); } break;
        case 'lock': b.locked = !!body.locked; bump(b); break;
        case 'clear': for (const p of b.posts) b.deleted.push({ id: p.id, seq: 0 }); b.posts = []; b.deleted = b.deleted.map((d) => ({ ...d, seq: state.seq + 1 })); bump(b); break;
        case 'remove': if (state.boards.length > 1) { state.boards = state.boards.filter((x) => x.id !== b.id); if (state.active === b.id) state.active = state.boards[0].id; bump(board(state.active)); } break;
        default: return send(res, 400, { error: 'Unknown action' });
      }
      save();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/export.csv') {
      if (!isHost(null, url)) return send(res, 403, 'Wrong host key');
      const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
      const rows = [['Question', 'Name', 'Colour', 'Response', 'Time (UTC)'].map(esc).join(',')];
      for (const b of state.boards) for (const p of b.posts) rows.push([b.question, p.name, p.color, p.text, new Date(p.ts).toISOString()].map(esc).join(','));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="board-responses.csv"' });
      return res.end('﻿' + rows.join('\r\n'));
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 400, { error: 'Bad request' });
  }
});
server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log('Board on port ' + PORT));
