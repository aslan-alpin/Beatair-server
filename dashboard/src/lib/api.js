
const ABS = (import.meta.env.VITE_SERVER_URL || '').replace(/\/$/, '');
const FALLBACK = `${window.location.protocol}//${window.location.hostname}:3001`;
const DEV = !!import.meta.env.DEV;
const CANDIDATES = DEV ? ['', ABS, FALLBACK] : [ABS || FALLBACK, FALLBACK];
export const SOCKET_BASE = (DEV && !ABS) ? '' : (ABS || FALLBACK);
export const DEBUG_BASES = CANDIDATES;

async function tryFetch(base, path, { method='GET', json, headers }={}){
  const url = `${base}${path}`;
  const res = await fetch(url, {
    method, mode: 'cors',
    headers: { 'Content-Type': 'application/json', ...(headers||{}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const isJson = ct.includes('application/json');
  const body = isJson ? await res.json().catch(()=>null) : await res.text().catch(()=>null);
  if (!res.ok) {
    const msg = (body && (body.error||body.message)) || `${res.status} ${res.statusText}`;
    const e = new Error(msg); e.status = res.status; e.base = base || '(relative)'; e.url = url;
    throw e;
  }
  return body;
}
export async function api(path, opts){
  let lastErr = null;
  for (const base of CANDIDATES){
    try { return await tryFetch(base, path, opts||{}); }
    catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('No base URL worked');
}

export const endpoints = {
  state:       () => api('/state'),
  search:      (q) => api('/search?q=' + encodeURIComponent(q)),
  devices:     () => api('/devices'),
  setDevice:   (deviceId) => api('/device', { method: 'POST', json: { deviceId } }),
  vote:        (trackId)  => api('/vote', { method: 'POST', json: { trackId } }),
  skip:        () => api('/skip',   { method: 'POST' }),
  pause:       () => api('/pause',  { method: 'POST' }),
  resume:      () => api('/resume', { method: 'POST' }),
  settingsGet: () => api('/admin/settings'),
  settingsSet: (settings) => api('/admin/settings', { method: 'POST', json: settings }),
  users:       () => api('/admin/users'),
  login:       () => {
    const base = (import.meta.env.VITE_SERVER_URL || '').replace(/\/$/, '') || '';
    const target = base ? `${base}/auth/login` : '/auth/login';
    window.open(target, '_blank', 'noopener');
  },
};
