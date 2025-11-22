#!/usr/bin/env node
/* Simple smoke test for Beatair server */
const BASE = process.env.BASE || 'http://localhost:3001';
const TRACK_ID = process.env.TRACK_ID; // optional
const fetchFn = global.fetch || (await import('node-fetch')).default;

async function tryFetch(path, opts){ 
  const url = BASE + path; 
  const res = await fetchFn(url, { ...(opts||{}), headers: { 'Content-Type':'application/json', ...(opts?.headers||{}) } });
  let body; const ct = res.headers.get('content-type') || '';
  const isJson = ct.includes('application/json');
  body = isJson ? await res.json().catch(()=>null) : await res.text().catch(()=>null);
  return { ok: res.ok, status: res.status, body };
}

function log(title, obj){ console.log(`\\n=== ${title} ===`); console.log(obj); }

(async()=>{
  console.log('Testing BASE =', BASE);

  // Health
  log('GET /health', await tryFetch('/health'));

  // State
  const st = await tryFetch('/state');
  log('GET /state', st);

  // Settings GET
  const g = await tryFetch('/admin/settings');
  log('GET /admin/settings', g);

  // Settings POST (no destructive change; toggle votePolicy or noop)
  if (g.ok && g.body){
    const prev = g.body.votePolicy || 'perTrack';
    const next = prev === 'perTrack' ? 'perRound' : 'perTrack';
    const p = await tryFetch('/admin/settings', { method:'POST', body: JSON.stringify({ votePolicy: next }) });
    log('POST /admin/settings (change votePolicy)', p);
    // revert
    if (p.ok) {
      const r = await tryFetch('/admin/settings', { method:'POST', body: JSON.stringify({ votePolicy: prev }) });
      log('POST /admin/settings (revert votePolicy)', r);
    }
  }

  // Search (may require Spotify auth; tolerate 401)
  const s = await tryFetch('/search?q=blinding%20lights');
  log('GET /search', s.ok ? {ok:true, count: s.body?.items?.length||0} : {ok:false, status:s.status});

  // Optional: vote
  if (TRACK_ID){
    const v = await tryFetch('/vote', { method:'POST', body: JSON.stringify({ trackId: TRACK_ID }) });
    log('POST /vote', v);
  }

  console.log('\\nDone.');
})().catch(e=>{ console.error(e); process.exit(1); });
