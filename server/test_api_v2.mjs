#!/usr/bin/env node
// Smoke test v2 for Beatair server
const BASE = process.env.BASE || 'http://localhost:3001';
const fetchFn = global.fetch || (await import('node-fetch')).default;

async function tryFetch(path, opts){ 
  const url = BASE + path; 
  const res = await fetchFn(url, { ...(opts||{}), headers: { 'Content-Type':'application/json', ...(opts?.headers||{}) } });
  let body; const ct = res.headers.get('content-type') || '';
  const isJson = ct.includes('application/json');
  body = isJson ? await res.json().catch(()=>null) : await res.text().catch(()=>null);
  return { ok: res.ok, status: res.status, body };
}
function log(title, obj){ console.log(`\n=== ${title} ===`); console.log(obj); }

(async()=>{
  console.log('Testing BASE =', BASE);

  log('GET /health', await tryFetch('/health'));
  log('GET /state', await tryFetch('/state'));

  // Settings
  const g = await tryFetch('/admin/settings');
  log('GET /admin/settings', g);
  if (g.ok) {
    const p = await tryFetch('/admin/settings', { method:'POST', body: JSON.stringify({ bannedUsers: ['ip:127.0.0.1','demo'] }) });
    log('POST /admin/settings (bannedUsers set)', p);
    await tryFetch('/admin/settings', { method:'POST', body: JSON.stringify({ bannedUsers: [] }) });
  }

  // Users
  const join = await tryFetch('/join', { method:'POST', body: JSON.stringify({ username: 'demo' }) });
  log('POST /join', join);
  log('GET /admin/users', await tryFetch('/admin/users'));

  // Vote with username
  const vote = await tryFetch('/vote', { method:'POST', body: JSON.stringify({ trackId: '3n3Ppam7vgaVa1iaRUc9Lp', username: 'demo' }) });
  log('POST /vote (with username)', vote.ok ? {ok:true} : {ok:false, status: vote.status, body: vote.body});

  console.log('\nDone.');
})().catch(e=>{ console.error(e); process.exit(1); });
