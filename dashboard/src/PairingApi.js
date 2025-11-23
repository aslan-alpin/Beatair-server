// src/pairingApi.js

const BASE_URL =
  import.meta.env.VITE_BEATAIR_API_BASE ||
  window.location.origin.replace(/\/+$/, '');

async function handleJSON(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getPairingInfo() {
  const res = await fetch(`${BASE_URL}/pair/info`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  return handleJSON(res);
}