
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { endpoints, SOCKET_BASE, DEBUG_BASES } from './lib/api'
import { io } from 'socket.io-client'
import './styles.css'

function Section({ title, right, children }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-extrabold">{title}</h2>
        <div>{right}</div>
      </div>
      {children}
    </div>
  )
}

function ProgressBar({ progress, duration }) {
  const pct = duration > 0 ? Math.min(100, Math.max(0, Math.round((progress / duration) * 100))) : 0
  return (
    <div className="progress-outer mt-3">
      <div className="progress-inner" style={{ width: pct + '%' }} />
    </div>
  )
}

function NowPlaying({ track, progress }) {
  return (
    <div>
      <div className="flex items-center gap-4">
        <img alt="" src={track?.image || ''} className="w-16 h-16 rounded-2xl object-cover bg-[#111827]" />
        <div className="min-w-0">
          <div className="font-black truncate">{track?.name || '—'}</div>
          <div className="text-sm text-slate-400 truncate">{track?.artists || ''}</div>
        </div>
        {track?.duration_ms ? (
          <span className="badge ml-auto">{Math.round(track.duration_ms/60000)}m</span>
        ) : null}
      </div>
      <ProgressBar progress={progress?.progress_ms||0} duration={progress?.duration_ms||0} />
    </div>
  )
}

function DevicePicker({ devices, currentId, onPick }) {
  return (
    <div className="grid sm:grid-cols-2 gap-2">
      {(devices||[]).map(d => (
        <button key={d.id} onClick={()=>onPick(d.id)} className={'btn ' + (d.id===currentId ? 'ring-2 ring-blue-500' : '')}>
          {d.name} <span className="opacity-60 text-xs ml-2">({d.type})</span>
        </button>
      ))}
    </div>
  )
}

function SearchRow({ item, onVote, onBan }) {
  return (
    <div className="flex items-center gap-3">
      <img alt="" src={item.image||''} className="w-12 h-12 rounded-xl object-cover bg-[#111827]" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold truncate">{item.name}</div>
        <div className="text-sm text-slate-400 truncate">{item.artists}</div>
      </div>
      <button className="btn btn-primary" onClick={()=>onVote(item.id)}>Oy (+1)</button>
      <button className="btn" onClick={()=>onBan(item)}>Ban</button>
    </div>
  )
}

function VoteRow({ v, total, onPlus, onBan }) {
  const t = v.track
  const count = v.count || 0
  if (count <= 0) return null
  const share = total > 0 ? count/total : 0
  return (
    <div className="flex items-center gap-3">
      <img alt="" src={t.image||''} className="w-12 h-12 rounded-xl object-cover bg-[#111827]" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold truncate">{t.name}</div>
        <div className="text-sm text-slate-400 truncate">{t.artists}</div>
        <div className="progress-outer mt-2">
          <div className="progress-inner" style={{ width: `${Math.round(share*100)}%` }} />
        </div>
      </div>
      <button className="btn" onClick={()=>onBan(t)}>Ban</button>
      <span className="badge">{count}</span>
      <button className="btn btn-primary" onClick={()=>onPlus(t.id)}>+</button>
    </div>
  )
}

function UsersPanel({ users, onBanUsername, onBanIp }){
  return (
    <div className="space-y-2">
      {(users||[]).length === 0 && <div className="text-slate-400">No users yet</div>}
      {(users||[]).map(u => (
        <div key={u.userId} className="flex items-center gap-3">
          <div className="font-semibold">{u.username}</div>
          <div className="text-xs text-slate-400">{u.ip}</div>
          <div className="text-xs text-slate-500">· {new Date(u.lastSeen).toLocaleTimeString()}</div>
          <div className="ml-auto flex gap-2">
            <button className="btn" onClick={()=>onBanUsername(u.username)}>Ban name</button>
            <button className="btn" onClick={()=>onBanIp(u.ip)}>Ban IP</button>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const [state, setState] = useState(null)
  const [devices, setDevices] = useState([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [settings, setSettings] = useState({ loading: true, data: null, error: null })
  const [users, setUsers] = useState([])
  const [progress, setProgress] = useState({ progress_ms: 0, duration_ms: 0, is_playing: false })
  const [netError, setNetError] = useState(null)

  const totalVotes = useMemo(()=> (state?.votes||[]).reduce((a,b)=>a+(b.count||0),0), [state])

  async function loadSettings(){
    setSettings(s=>({ ...s, loading: true, error: null }))
    try{
      const s = await endpoints.settingsGet()
      setSettings({ loading: false, data: s, error: null })
    }catch(e){
      setSettings({ loading: false, data: null, error: e.message || 'Failed to load settings' })
    }
  }
  async function loadUsers(){
    try{ const u = await endpoints.users(); setUsers(u.users||[]) } catch(e){ /* ignore */ }
  }

  useEffect(() => {
    const s = io(SOCKET_BASE || undefined, { transports: ['websocket'], path: '/socket.io' })
    s.on('state', st => { setState(st); if (st?.progress) setProgress(st.progress) })
    s.on('progress', setProgress)
    endpoints.state().then(st => { setState(st); if (st?.progress) setProgress(st.progress) }).catch(setNetError)
    endpoints.devices().then(setDevices).catch(setNetError)
    loadSettings()
    loadUsers()
    const id = setInterval(loadUsers, 15000)
    return () => { s.disconnect(); clearInterval(id) }
  }, [])

  const doSearch = async () => {
    if (!query.trim()) return setResults([])
    const r = await endpoints.search(query.trim())
    setResults(r.items || [])
  }

  const doVote = async (trackId) => {
    try {
      const r = await endpoints.vote(trackId)
      setState(s => ({ ...(s||{}), votes: r.votes }))
    } catch (e) { alert(e.message) }
  }

  const pickDevice = async (deviceId) => {
    await endpoints.setDevice(deviceId)
    const st = await endpoints.state()
    setState(st)
  }

  const saveSettings = async (partial) => {
    const next = { ...(settings.data||{}), ...(partial||{}) }
    await endpoints.settingsSet(next)
    await loadSettings()
  }
  const addBanByUsername = (name) => saveSettings({ bannedUsers: [ ...((settings.data?.bannedUsers)||[]), String(name||'').trim() ].filter(Boolean) })
  const addBanByIp = (ip) => saveSettings({ bannedUsers: [ ...((settings.data?.bannedUsers)||[]), `ip:${ip}` ].filter(Boolean) })

  return (
    <div className="min-h-screen grid lg:grid-cols-[260px_1fr]">
      <aside className="hidden lg:flex flex-col gap-4 p-4 border-r border-[#1f2937]">
        <div className="text-2xl font-black">beatair</div>
        <div className="text-sm text-slate-400">Owner Dashboard</div>
        <div className="mt-3 grid gap-2">
          <button className="btn" onClick={()=>endpoints.login()}>Connect Spotify</button>
          <div className="grid grid-cols-3 gap-2">
            <button className="btn" onClick={()=>endpoints.pause()}>Pause</button>
            <button className="btn" onClick={()=>endpoints.resume()}>Play</button>
            <button className="btn" onClick={()=>endpoints.skip()}>Skip</button>
          </div>
        </div>
        <div className="mt-auto text-xs text-slate-500 space-y-1">
          <div>API bases tried: <span className="font-mono">{DEBUG_BASES.map(b=>b||'(relative)').join('  →  ')}</span></div>
        </div>
      </aside>

      <main className="p-5 space-y-5">
        <div className="grid md:grid-cols-2 gap-5">
          <Section title="Now Playing">
            <NowPlaying track={state?.playingTrack} progress={progress} />
          </Section>
          <Section title="Devices"><DevicePicker devices={devices} currentId={state?.deviceId} onPick={pickDevice} /></Section>
        </div>

        <div className="grid lg:grid-cols-3 gap-5">
          <Section title="Search & Add" right={<button className="btn btn-primary" onClick={doSearch}>Search</button>}>
            <input className="input w-full mb-3" placeholder="Search tracks…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter' && doSearch()} />
            <div className="space-y-3">
              {results.map(it => <SearchRow key={it.id} item={it} onVote={doVote} onBan={(t)=>saveSettings({ bannedTracks: [ ...((settings.data?.bannedTracks)||[]), `id:${t.id}` ] })} />)}
            </div>
          </Section>

          <Section title="Leaderboard">
            <div className="space-y-3">
              {(state?.votes||[]).filter(v => (v.count||0) > 0).map(v => (
                <VoteRow key={v.track.id} v={v} total={totalVotes} onPlus={doVote} onBan={(t)=>saveSettings({ bannedTracks: [ ...((settings.data?.bannedTracks)||[]), `id:${t.id}` ] })} />
              ))}
            </div>
          </Section>

          <Section title="Settings" right={<button className="btn" onClick={loadSettings}>Reload</button>}>
            {settings.loading && <div className="text-slate-400">Loading…</div>}
            {settings.error && (<div className="rounded-2xl border border-red-800 bg-red-900/20 text-red-200 p-3 mb-3">Settings failed: <span className="font-mono">{settings.error}</span></div>)}
            {settings.data && (
              <div className="grid gap-4">
                <div className="grid grid-cols-[160px_1fr] items-center gap-3">
                  <label className="text-sm text-slate-300">Vote policy</label>
                  <select className="input" value={settings.data.votePolicy || 'perTrack'} onChange={(e)=>saveSettings({ votePolicy: e.target.value })}>
                    <option value="perTrack">One vote / IP / track</option>
                    <option value="perRound">One vote / IP / round</option>
                    <option value="ttl">One vote / IP / TTL</option>
                  </select>
                </div>

                <div className="grid grid-cols-[160px_1fr] items-center gap-3">
                  <label className="text-sm text-slate-300">TTL seconds</label>
                  <input type="number" className="input" min={30} value={settings.data.voteTtlSeconds ?? 900} onChange={(e)=>saveSettings({ voteTtlSeconds: Number(e.target.value || 0) })} />
                </div>

                <div className="grid grid-cols-[160px_1fr] items-center gap-3">
                  <label className="text-sm text-slate-300">Min votes to override</label>
                  <input type="number" className="input" min={1} value={settings.data.minVotesToOverride ?? 1} onChange={(e)=>saveSettings({ minVotesToOverride: Number(e.target.value || 1) })} />
                </div>

                <div className="grid grid-cols-[160px_1fr] items-center gap-3">
                  <label className="text-sm text-slate-300">Max track duration (min)</label>
                  <input type="number" className="input" min={1} value={Math.round((settings.data.maxDurationMs ?? 600000)/60000)} onChange={(e)=>saveSettings({ maxDurationMs: Number(e.target.value || 0)*60000 })} />
                </div>

                <div className="grid grid-cols-[160px_1fr] gap-3">
                  <label className="text-sm text-slate-300">Banned artists</label>
                  <textarea className="input h-24" value={(settings.data.bannedArtists || []).join('\n')} onChange={(e)=>saveSettings({ bannedArtists: e.target.value.split(/\n+/).map(s=>s.trim()).filter(Boolean) })} />
                </div>

                <div className="grid grid-cols-[160px_1fr] gap-3">
                  <label className="text-sm text-slate-300">Banned tracks</label>
                  <div>
                    <div className="flex gap-2">
                      <input id="banTrackInput" className="input flex-1" placeholder="id:TRACKID or any text…" />
                      <button className="btn" onClick={()=>{
                        const el = document.getElementById('banTrackInput')
                        const val = (el?.value||'').trim()
                        if (!val) return
                        saveSettings({ bannedTracks: [ ...((settings.data.bannedTracks||[])), val ] })
                        if (el) el.value = ''
                      }}>Add</button>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {(settings.data.bannedTracks || []).map((t,i)=>(
                        <span key={i} className="badge flex items-center gap-2">
                          {t}
                          <button className="opacity-70 hover:opacity-100" onClick={()=>{
                            const copy = (settings.data.bannedTracks||[]).slice(); copy.splice(i,1); saveSettings({ bannedTracks: copy })
                          }}>×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-[160px_1fr] gap-3">
                  <label className="text-sm text-slate-300">Banned users</label>
                  <div>
                    <div className="flex gap-2">
                      <input id="banUserInput" className="input flex-1" placeholder="username or ip:1.2.3.4" />
                      <button className="btn" onClick={()=>{
                        const el = document.getElementById('banUserInput')
                        const val = (el?.value||'').trim()
                        if (!val) return
                        saveSettings({ bannedUsers: [ ...((settings.data.bannedUsers||[])), val ] })
                        if (el) el.value = ''
                      }}>Add</button>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {(settings.data.bannedUsers || []).map((t,i)=>(
                        <span key={i} className="badge flex items-center gap-2">
                          {t}
                          <button className="opacity-70 hover:opacity-100" onClick={()=>{
                            const copy = (settings.data.bannedUsers||[]).slice(); copy.splice(i,1); saveSettings({ bannedUsers: copy })
                          }}>×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Section>
        </div>

        {/* Users Admin */}
        <Section title="Users">
          <UsersPanel users={users} onBanUsername={addBanByUsername} onBanIp={addBanByIp} />
        </Section>
      </main>
    </div>
  )
}
