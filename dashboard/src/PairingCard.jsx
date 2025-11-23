// src/PairingCard.jsx
import React, { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';
import { getPairingInfo } from './pairingApi';

export default function PairingCard() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    try {
      setLoading(true);
      setErr('');
      const data = await getPairingInfo();
      setInfo(data);
    } catch (e) {
      console.error('pair/info error', e);
      setErr(e.message || 'Failed to load pairing info');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (loading && !info) {
    return (
      <div className="card">
        <h3>Pairing</h3>
        <p>Loading…</p>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="card">
        <h3>Pairing</h3>
        <p className="text-red-400 text-sm mb-2">{err || 'No data'}</p>
        <button className="btn-secondary" onClick={handleRefresh}>
          Retry
        </button>
      </div>
    );
  }

  const { url, code, cafeName } = info;
  const payload = btoa(JSON.stringify({ url, code }));

  return (
    <div className="card">
      <div className="card-header flex justify-between items-center mb-3">
        <div>
          <h3 className="text-lg font-semibold">Mobile pairing</h3>
          <p className="text-xs text-slate-400">
            Scan this in the Beatair mobile app to connect to{' '}
            <span className="font-medium">{cafeName || 'your café'}</span>.
          </p>
        </div>
        <button
          className="btn-secondary text-xs"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="flex items-center gap-4">
        <div className="p-2 bg-white rounded-xl">
          {/* small but scannable QR */}
          <QRCode value={payload} size={120} />
        </div>
        <div className="text-xs space-y-2">
          <div>
            <div className="text-slate-400">Server URL</div>
            <div className="font-mono break-all text-[11px]">
              {url || '(no url)'}
            </div>
          </div>
          <div>
            <div className="text-slate-400">Pairing code</div>
            <div className="font-mono text-lg tracking-[0.25em]">
              {code || '------'}
            </div>
          </div>
        </div>
      </div>

      {err && (
        <p className="mt-2 text-[11px] text-red-400">
          {err}
        </p>
      )}
    </div>
  );
}