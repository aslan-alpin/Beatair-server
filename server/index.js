// ── Load .env early ────────────────────────────────────────────────────────────
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

/* Beatair server with OAuth (Spotify) */
const express = require('express');
const http = require('http');
const cors = require('cors');
const axios = require('axios');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const querystring = require('node:querystring');

const app = express();
// trust loca.lt / proxies for proper scheme/host
app.set('trust proxy', true);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  path: '/socket.io'
});

/* ==============================
   Settings / in-memory state
   ============================== */
let settings = {
  votePolicy: 'perTrack',       // 'perTrack' | 'perRound' | 'ttl'
  voteTtlSeconds: 900,
  minVotesToOverride: 1,
  maxDurationMs: 600_000,       // 10 min
  bannedArtists: [],
  bannedTracks: [],             // 'id:TRACKID' or substring match
  bannedUsers: [],              // 'username' or 'ip:1.2.3.4'
};

// votes: trackId -> { count, track }
const votes = new Map();

// round id for perRound policy
let currentRoundId = 1;

// spotify playback target
let deviceId = null;

function bumpRound(){ currentRoundId++; ipPerRound.clear(); }
function isTrackBanned(track){
  const name = String(track?.name || '').toLowerCase();
  const artists = String(track?.artists || '').toLowerCase();
  for (const t of (settings.bannedTracks || [])){
    const s = String(t||'').trim();
    if (!s) continue;
    if (s.startsWith('id:')) {
      if (track?.id === s.slice(3).trim()) return true;
    } else if (name.includes(s.toLowerCase())) {
      return true;
    }
  }
  for (const a of (settings.bannedArtists || [])){
    if (a && artists.includes(String(a).toLowerCase())) return true;
  }
  if (settings.maxDurationMs && track?.duration_ms && track.duration_ms > settings.maxDurationMs) return true;
  return false;
}

function serializeVotes(){
  return Array.from(votes.entries())
    .map(([trackId, v]) => ({ trackId, count: v.count, track: v.track }))
    .filter(x => (x.count||0) > 0)
    .sort((a,b) => (b.count||0) - (a.count||0));
}

function addVote(track){
  const ex = votes.get(track.id) || { count: 0, track };
  ex.track = track;
  ex.count = (ex.count || 0) + 1;
  votes.set(track.id, ex);
}
function resetVotesForTrack(trackId){
  if (votes.has(trackId)) votes.delete(trackId);
}
function getTopVotedTrack(){
  let best = null;
  for (const [,v] of votes){
    if (!best || (v.count||0) > (best.count||0)) best = v;
  }
  return best;
}

/* ==============================
   Users / pairing / bans
   ============================== */

// dashboard "users" list
// key = userId (we'll just use token for simplicity)
const users = new Map();

// token -> { username, avatar, ip, createdAt, lastSeen }
const clientTokens = new Map();

const normalize = (s) => String(s||'').trim().toLowerCase();

function getIp(req){
  return String(
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    req.ip ||
    ''
  ).split(',')[0].trim();
}

function isUserBannedByNameOrIp(username, ip){
  const name = normalize(username);
  for (const x of (settings.bannedUsers||[])){
    const s = String(x||'').trim();
    if (!s) continue;
    if (s.startsWith('ip:')) {
      const target = s.slice(3).trim();
      if (target && ip.includes(target)) return true;
    } else {
      if (name && name === normalize(s)) return true;
    }
  }
  return false;
}

// Legacy join route (kept for backwards compat / debugging)
app.post('/join', (req, res) => {
  const { username } = req.body || {};
  const u = String(username||'').trim();
  if (!u) return res.status(400).json({ error: 'username required' });

  const ip = getIp(req);
  if (isUserBannedByNameOrIp(u, ip)) {
    return res.status(403).json({ error: 'banned' });
  }

  const userId = crypto.randomUUID();
  users.set(userId, {
    userId,
    username: u,
    avatar: '🎧',
    ip,
    lastSeen: Date.now()
  });

  res.json({ ok:true, userId, username: u });
});

// Return connected users for dashboard (owner view)
app.get('/admin/users', (req, res) => {
  res.json({
    users: Array.from(users.values())
  });
});

/* ==============================
   Vote policy (per IP)
   ============================== */
const ipPerTrack = new Map(); // ip -> Set(trackId)
const ipPerRound = new Map(); // ip -> roundId
const ipTtl = new Map();      // "ip:trackId" -> expiry timestamp

function ipCanVote(req, trackId){
  const ip = getIp(req);
  const pol = settings.votePolicy || 'perTrack';

  if (pol === 'perTrack'){
    const set = ipPerTrack.get(ip) || new Set();
    if (set.has(trackId)) return { ok:false, reason: 'already voted this track' };
    return { ok:true };
  }

  if (pol === 'perRound'){
    const round = ipPerRound.get(ip);
    if (round === currentRoundId) return { ok:false, reason:'already voted this round' };
    return { ok:true };
  }

  if (pol === 'ttl'){
    const key = `${ip}:${trackId}`;
    const exp = ipTtl.get(key) || 0;
    if (Date.now() < exp) return { ok:false, reason:'ttl not expired' };
    return { ok:true };
  }

  return { ok:true };
}

function ipRecordVote(req, trackId){
  const ip = getIp(req);
  const pol = settings.votePolicy || 'perTrack';

  if (pol === 'perTrack'){
    const set = ipPerTrack.get(ip) || new Set();
    set.add(trackId);
    ipPerTrack.set(ip, set);
  } else if (pol === 'perRound'){
    ipPerRound.set(ip, currentRoundId);
  } else if (pol === 'ttl'){
    const key = `${ip}:${trackId}`;
    const ttl = Math.max(1, Number(settings.voteTtlSeconds || 0)) * 1000;
    ipTtl.set(key, Date.now() + ttl);
  }
}

/* ==============================
   Spotify OAuth + helpers
   ============================== */
let accessToken = process.env.SPOTIFY_ACCESS_TOKEN || null;
let refreshToken = process.env.SPOTIFY_REFRESH_TOKEN || null;
// FIX 1: Track expiration to avoid blindly using dead tokens
let tokenExpiresAt = 0;

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:3001/auth/callback';

const OAUTH_SCOPE = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'streaming'
].join(' ');

app.get('/auth/login', (req, res) => {
  const params = querystring.stringify({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: OAUTH_SCOPE,
    redirect_uri: REDIRECT_URI,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    accessToken  = tokenRes.data.access_token;
    refreshToken = tokenRes.data.refresh_token || refreshToken;

    // FIX 2: Update expiration on login
    const expiresIn = tokenRes.data.expires_in || 3600;
    tokenExpiresAt = Date.now() + (expiresIn * 1000);

    res.send('<html><body style="font-family:system-ui">✅ Connected to Spotify. You can close this tab and return to the dashboard.</body></html>');
  } catch (e) {
    console.error('OAuth callback error:', e?.response?.data || e.message);
    res.status(500).send('OAuth failed. Check server logs & env vars.');
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ authorized: !!accessToken });
});

async function refreshAccessTokenIfNeeded(){
  if (!refreshToken) return false;
  try {
    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    accessToken = tokenRes.data.access_token || accessToken;
    
    // FIX 3: Update expiration on refresh
    const expiresIn = tokenRes.data.expires_in || 3600;
    tokenExpiresAt = Date.now() + (expiresIn * 1000);
    
    console.log('Spotify token refreshed automatically.');
    return true;
  } catch (e) {
    console.error('Refresh failed:', e?.response?.data || e.message);
    return false;
  }
}

async function ensureAccessToken(){
  // FIX 4: Check expiration (with 60s buffer) before returning existing token
  if (accessToken && Date.now() < tokenExpiresAt - 60000) {
    return accessToken;
  }
  
  const refreshed = await refreshAccessTokenIfNeeded();
  if (refreshed && accessToken) return accessToken;
  throw new Error('No Spotify access token. Visit /auth/login first.');
}
async function spotifyGet(url){
  await ensureAccessToken();
  return axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}
async function spotifyPut(url, body){
  await ensureAccessToken();
  return axios.put(url, body || {}, { headers: { Authorization: `Bearer ${accessToken}` } });
}
async function spotifyPost(url, body){
  await ensureAccessToken();
  return axios.post(url, body || {}, { headers: { Authorization: `Bearer ${accessToken}` } });
}

/* ==============================
   Playback & progress
   ============================== */
let playingTrack = null;
let playingEndTimer = null;
let progressBaseMs = 0;
let progressBaseAt = 0;
let isPlayingFlag = false;
let progressInterval = null;

function clearTrackEndTimer(){
  if (playingEndTimer) clearTimeout(playingEndTimer), playingEndTimer = null;
}
function stopProgressTicker(){
  if (progressInterval) clearInterval(progressInterval), progressInterval = null;
}
function getComputedProgressMs(){
  if (!playingTrack) return 0;
  const base = progressBaseMs || 0;
  if (isPlayingFlag) {
    return Math.min(
      base + (Date.now() - progressBaseAt),
      playingTrack.duration_ms || base
    );
  }
  return base;
}
function setProgressFromState(state){
  if (!state || !state.item) return;
  progressBaseMs = Number(state.progress_ms || 0);
  progressBaseAt = Date.now();
  isPlayingFlag  = !!state.is_playing;
}
function startProgressTicker(){
  stopProgressTicker();

  // emit once immediately
  setImmediate(() => io.emit('progress', {
    trackId: playingTrack?.id || null,
    progress_ms: getComputedProgressMs(),
    duration_ms: playingTrack?.duration_ms || 0,
    is_playing: isPlayingFlag
  }));

  // emit once per second
  progressInterval = setInterval(() => {
    if (!playingTrack) return;
    io.emit('progress', {
      trackId: playingTrack.id,
      progress_ms: getComputedProgressMs(),
      duration_ms: playingTrack.duration_ms || 0,
      is_playing: isPlayingFlag
    });
  }, 1000);
}

async function getPlaybackState(){
  try {
    const r = await spotifyGet('https://api.spotify.com/v1/me/player');
    return r.data;
  } catch (e) {
    return null;
  }
}
async function playTrackOnDevice(uri){
  const body = deviceId ? { uris:[uri], device_id: deviceId } : { uris:[uri] };
  await spotifyPut('https://api.spotify.com/v1/me/player/play', body);
}
async function startPlayingTrack(track){
  await playTrackOnDevice(track.uri);

  playingTrack = track;
  progressBaseMs = 0;
  progressBaseAt = Date.now();
  isPlayingFlag  = true;

  bumpRound();
  resetVotesForTrack(track.id);

  broadcastState();
  startProgressTicker();
  await scheduleTrackEndWatch();
}
async function scheduleTrackEndWatch(){
  clearTrackEndTimer();
  const state = await getPlaybackState();
  if (!state || !state.item) { stopProgressTicker(); return; }

  setProgressFromState(state);
  startProgressTicker();

  const remaining = Math.max(
    0,
    (state.item.duration_ms||0) - (state.progress_ms||0)
  );
  const waitMs = Math.max(1000, remaining + 1000);

  playingEndTimer = setTimeout(onCurrentTrackFinished, waitMs);
}

async function onCurrentTrackFinished(){
  // FIX 5: Catch errors here so we don't crash the process if Spotify is flaky
  try {
    playingTrack = null;

    const top = getTopVotedTrack();
    if (!top || (top.count||0) < (settings.minVotesToOverride||1)) {
      // nobody won -> push next on Spotify
      try {
        await spotifyPost('https://api.spotify.com/v1/me/player/next');
      } catch(e){
        console.error('Auto-next failed:', e.message);
      }
      broadcastState();
      try { await scheduleTrackEndWatch(); } catch {}
      return;
    }

    await startPlayingTrack(top.track);
  } catch (err) {
    console.error('CRITICAL: Error in onCurrentTrackFinished (Timer)', err.message);
    // stop ticker to be safe
    stopProgressTicker();
  }
}

async function playTopOrSpotifyNext(trigger = 'unknown') {
  const min = Number(settings.minVotesToOverride || 1);
  const top = getTopVotedTrack();

  if (top && (top.count || 0) >= min) {
    await startPlayingTrack(top.track);
    return { via: 'votes', trackId: top.track.id, trigger };
  }

  await spotifyPost('https://api.spotify.com/v1/me/player/next');

  const st = await getPlaybackState();
  if (st && !st.is_playing) {
    try { await spotifyPut('https://api.spotify.com/v1/me/player/play'); } catch {}
  }
  await scheduleTrackEndWatch();
  return { via: 'spotify', trigger };
}

/* ==============================
   Pairing helpers + endpoints
   ============================== */
function normalizeBase(u = ''){
  if (!u) return '';
  let url = String(u).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}
function pairCode(url) {
  const h = crypto.createHash('sha256').update(String(url)).digest('hex');
  const n = parseInt(h.slice(0, 8), 16) % 1_000_000;
  return String(n).padStart(6, '0');
}
function readLastTunnelUrl() {
  try {
    // Prefer server/remote/last-url.json; fallback to ./last-url.json
    const p1 = path.resolve(__dirname, 'remote', 'last-url.json');
    const p2 = path.resolve(__dirname, 'last-url.json');
    const p = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : null);
    if (p) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j?.url) return String(j.url);
    }
  } catch {}
  return null;
}
function inferPublicUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return normalizeBase(process.env.PUBLIC_BASE_URL);
  }
  const xfProto = req.get('x-forwarded-proto');
  const xfHost  = req.get('x-forwarded-host');
  const host    = req.get('host');

  if (xfHost) {
    return normalizeBase(`${(xfProto || 'https').toLowerCase()}://${xfHost}`);
  }
  if (host) {
    return normalizeBase(`${(req.protocol || 'https').toLowerCase()}://${host}`);
  }

  const last = readLastTunnelUrl();
  if (last)  return normalizeBase(last);

  return '';
}
function issueToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// 1. client sends code (and maybe url). We verify the code matches our URL.
//    We mint a token and remember this device.
app.post(['/pair/verify', '/api/pair/verify'], (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ ok:false, error:'bad_code' });
    }

    // build candidate base URLs
    const candidates = [];
    if (req.body?.url) candidates.push(normalizeBase(req.body.url));

    const inferred = inferPublicUrl(req);
    if (inferred) candidates.push(inferred);

    const fromFile = readLastTunnelUrl();
    if (fromFile) candidates.push(normalizeBase(fromFile));

    // dedupe and test
    const uniq = [...new Set(candidates.filter(Boolean))];

    let matchedUrl = '';
    for (const base of uniq) {
      if (pairCode(base) === code) {
        matchedUrl = base;
        break;
      }
    }

    if (!matchedUrl) {
      return res.status(401).json({ ok:false, error:'code_mismatch' });
    }

    // okay, legit
    const token = issueToken();
    const ip = getIp(req);
    const cafeName = process.env.CAFE_NAME || 'Beatair Café';

    clientTokens.set(token, {
      username: null,
      avatar:   null,
      ip,
      createdAt: Date.now(),
      lastSeen:  Date.now()
    });

    return res.json({
      ok: true,
      token,
      url: matchedUrl,
      cafeName,
      expiresInSec: 86400
    });
  } catch (e) {
    console.error('pair/verify error:', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// 2. client sends username/avatar with that token to "lock in" identity.
//    We store them in both clientTokens and dashboard-visible `users`.
app.post('/identify', (req, res) => {
  const { token, username, avatar } = req.body || {};

  if (!token || !clientTokens.has(token)) {
    return res.status(404).json({ ok:false, error:'invalid_token' });
  }

  const ip = getIp(req);
  const uname = String(username || '').trim() || 'Guest';
  const av    = String(avatar   || '').trim() || '🎧';

  // ban check
  if (isUserBannedByNameOrIp(uname, ip)) {
    return res.status(403).json({ ok:false, error: 'banned' });
  }

  // update token record
  const rec = clientTokens.get(token);
  rec.username = uname;
  rec.avatar   = av;
  rec.ip       = ip;
  rec.lastSeen = Date.now();
  clientTokens.set(token, rec);

  // also surface in dashboard users list
  users.set(token, {
    userId: token,
    username: uname,
    avatar: av,
    ip,
    lastSeen: Date.now()
  });

  return res.json({
    ok: true,
    username: uname,
    avatar: av
  });
});

// tiny debug for frontend / QR overlay
app.get('/pair/info', (req, res) => {
  const url = inferPublicUrl(req) || readLastTunnelUrl() || '';
  const code = url ? pairCode(url) : null;
  res.json({
    url,
    code,
    cafeName: process.env.CAFE_NAME || 'Beatair Café'
  });
});

// serve the QR png (tunnel script writes remote/qr.png)
app.get('/qr.png', (req, res) => {
  const p1 = path.resolve(__dirname, 'remote', 'qr.png');
  const p2 = path.resolve(__dirname, 'qr.png');
  const p = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : null);
  if (!p) return res.status(404).send('no qr');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(p);
});

/* ==============================
   API
   ============================== */

app.get('/health', (req, res) => {
  res.json({ ok:true });
});

function broadcastState(){
  io.emit('state', {
    votes: serializeVotes(),
    playingTrack,
    deviceId,
    initialRoundEndsAt: null, // legacy field dashboard might still read
    progress: {
      trackId: playingTrack?.id || null,
      progress_ms: getComputedProgressMs(),
      duration_ms: playingTrack?.duration_ms || 0,
      is_playing: isPlayingFlag
    }
  });
}

app.get('/state', (req, res) => {
  res.json({
    votes: serializeVotes(),
    playingTrack,
    deviceId,
    progress: {
      trackId: playingTrack?.id || null,
      progress_ms: getComputedProgressMs(),
      duration_ms: playingTrack?.duration_ms || 0,
      is_playing: isPlayingFlag
    }
  });
});

app.get('/devices', async (req, res) => {
  try {
    await ensureAccessToken();
    const r = await spotifyGet('https://api.spotify.com/v1/me/player/devices');
    res.json((r.data && r.data.devices) || []);
  } catch(e) {
    res.status(401).json({ error: 'Spotify not authorized' });
  }
});

app.post('/device', async (req, res) => {
  deviceId = (req.body && req.body.deviceId) || null;
  res.json({ ok:true, deviceId });
});

app.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  try {
    await ensureAccessToken();
    const r = await spotifyGet(
      'https://api.spotify.com/v1/search?type=track&q=' +
      encodeURIComponent(q)
    );
    const items = (r.data?.tracks?.items || []).map(t => ({
      id: t.id,
      uri: t.uri,
      name: t.name,
      artists: t.artists.map(a=>a.name).join(', '),
      album: t.album?.name,
      image: (
        t.album?.images?.[2]?.url ||
        t.album?.images?.[1]?.url ||
        t.album?.images?.[0]?.url ||
        null
      ),
      duration_ms: t.duration_ms
    })).filter(t => !isTrackBanned(t));

    res.json({ items });
  } catch(e) {
    res.status(401).json({ error: 'Spotify not authorized' });
  }
});

/**
 * Helper to resolve the "real" user identity for this request.
 * We prefer token, but we fallback to explicit username for backward compat.
 */
function resolveRequestUser(reqBody, req){
  const token = reqBody.token;
  const explicitName = String(reqBody.username || '').trim();

  if (token && clientTokens.has(token)) {
    const rec = clientTokens.get(token);
    const uname = rec.username || explicitName || 'Guest';
    const av    = rec.avatar   || '🎧';

    // keep lastSeen fresh
    rec.lastSeen = Date.now();
    clientTokens.set(token, rec);

    // mirror into dashboard users map
    users.set(token, {
      userId: token,
      username: uname,
      avatar: av,
      ip: rec.ip || getIp(req),
      lastSeen: Date.now()
    });

    return { username: uname };
  }

  // fallback old flow
  if (explicitName) {
    const ip = getIp(req);

    // upsert anonymous user w/ ip
    let foundKey = null;
    for (const [uid, u] of users){
      if (normalize(u.username) === normalize(explicitName) &&
          u.ip === ip) {
        foundKey = uid;
        break;
      }
    }
    if (!foundKey){
      const uid = crypto.randomUUID();
      users.set(uid, {
        userId: uid,
        username: explicitName,
        avatar: '🎧',
        ip,
        lastSeen: Date.now()
      });
    } else {
      const u = users.get(foundKey);
      u.lastSeen = Date.now();
      users.set(foundKey, u);
    }

    return { username: explicitName };
  }

  return { username: 'Guest' };
}

app.post('/vote', async (req, res) => {
  try {
    const { trackId } = req.body || {};
    if (!trackId) return res.status(400).json({ error: 'trackId required' });

    // figure out who is voting
    const resolvedUser = resolveRequestUser(req.body, req);
    const voterName = resolvedUser.username || 'Guest';

    // ban check for user
    if (isUserBannedByNameOrIp(voterName, getIp(req))) {
      return res.status(403).send('User banned');
    }

    // vote policy check
    const can = ipCanVote(req, trackId);
    if (!can.ok) {
      return res.status(429).send(can.reason || 'vote policy');
    }

    await ensureAccessToken();

    // fetch full track info from Spotify
    const r = await spotifyGet(
      'https://api.spotify.com/v1/tracks/' +
      encodeURIComponent(trackId)
    );
    const t = r.data;
    const trackMeta = {
      id: t.id,
      uri: t.uri,
      name: t.name,
      artists: t.artists.map(a=>a.name).join(', '),
      album: t.album?.name,
      image: (
        t.album?.images?.[2]?.url ||
        t.album?.images?.[1]?.url ||
        t.album?.images?.[0]?.url ||
        null
      ),
      duration_ms: t.duration_ms
    };

    if (isTrackBanned(trackMeta)) {
      return res.status(403).send('Track banned');
    }

    addVote(trackMeta);
    ipRecordVote(req, trackId);

    res.json({
      ok:true,
      votes: serializeVotes()
    });

    broadcastState();
  } catch(e) {
    res.status(500).json({ error: e.message || 'vote failed' });
  }
});

app.post('/skip', async (req, res) => {
  try {
    const result = await playTopOrSpotifyNext('manual-skip');
    const payload = {
      ok: true,
      ...result,
      votes: serializeVotes()
    };
    res.json(payload);
    broadcastState();
  } catch (e) {
    res.status(500).json({ error: e.message || 'skip failed' });
  }
});

app.post('/pause', async (req, res) => {
  try {
    await spotifyPut('https://api.spotify.com/v1/me/player/pause');
    const st = await getPlaybackState();
    if (st) setProgressFromState(st);
    isPlayingFlag=false;
    res.json({ ok:true });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.post('/resume', async (req, res) => {
  try {
    await spotifyPut('https://api.spotify.com/v1/me/player/play');
    const st = await getPlaybackState();
    if (st) setProgressFromState(st);
    isPlayingFlag=true;
    startProgressTicker();
    res.json({ ok:true });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

/* ==============================
   Settings API
   ============================== */
function toArray(input){
  if (Array.isArray(input)) {
    return input.map(String).map(s=>s.trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input
      .split(/\r?\n|,|;/)
      .map(s=>s.trim())
      .filter(Boolean);
  }
  return [];
}

app.get('/admin/settings', (req, res) => {
  res.json(settings);
});

app.post('/admin/settings', (req, res) => {
  const {
    votePolicy,
    voteTtlSeconds,
    minVotesToOverride,
    maxDurationMs,
    bannedArtists,
    bannedTracks,
    bannedUsers,
  } = req.body || {};

  const validPolicies = new Set(['perTrack','perRound','ttl']);
  if (votePolicy && validPolicies.has(votePolicy)) {
    const prev = settings.votePolicy;
    settings.votePolicy = votePolicy;
    if (votePolicy === 'perRound' && prev !== 'perRound') {
      bumpRound();
    }
  }

  if (Number.isFinite(Number(voteTtlSeconds))) {
    settings.voteTtlSeconds = Math.max(1, Number(voteTtlSeconds));
  }
  if (Number.isFinite(Number(minVotesToOverride))) {
    settings.minVotesToOverride = Math.max(1, Number(minVotesToOverride));
  }
  if (Number.isFinite(Number(maxDurationMs))) {
    settings.maxDurationMs = Math.max(60_000, Number(maxDurationMs));
  }

  if (bannedArtists !== undefined) {
    settings.bannedArtists = toArray(bannedArtists);
  }
  if (bannedTracks  !== undefined) {
    settings.bannedTracks  = toArray(bannedTracks);
  }
  if (bannedUsers   !== undefined) {
    settings.bannedUsers   = toArray(bannedUsers);
  }

  // purge any votes for banned tracks
  for (const [trackId, v] of votes) {
    if (isTrackBanned(v.track)) votes.delete(trackId);
  }

  broadcastState();
  res.json(settings);
});

/* ==============================
   Startup w/ port auto-retry
   ============================== */
const START_PORT = Number(process.env.PORT || 3001);
let port = START_PORT;
let tries = 0;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && tries < 8) {
    console.warn(`Port ${port} busy — retrying on ${port + 1}…`);
    tries += 1;
    port += 1;
    setTimeout(() => server.listen(port, '0.0.0.0'), 250);
  } else {
    console.error(err);
    process.exit(1);
  }
});
server.on('listening', () => {
  const addr = server.address();
  console.log(`Beatair server running on http://${addr.address}:${addr.port}`);
});
server.listen(port, '0.0.0.0');