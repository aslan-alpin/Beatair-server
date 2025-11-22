// App.js — Beatair Expo client (account menu, cafe info, library, polished dark UI)
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  SafeAreaView, View, Text, TextInput, FlatList,
  TouchableOpacity, Image, StyleSheet, Modal, ActivityIndicator,
  Platform, NativeModules, Keyboard, Linking
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Network from 'expo-network';
import { io } from 'socket.io-client';

/** ===================== Utilities ===================== */
const fmtTime = (ms=0) => {
  const s = Math.max(0, Math.floor(ms/1000));
  const m = Math.floor(s/60);
  const ss = String(s%60).padStart(2,'0');
  return `${m}:${ss}`;
};

const relTime = (ts) => {
  const d = Math.max(0, Date.now() - ts);
  const mins = Math.floor(d/60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs/24);
  return `${days}d ago`;
};

const fetchJson = async (url, opts={}, timeout=2200) => {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, headers: { 'Content-Type':'application/json', ...(opts.headers||{}) }, signal: ctrl.signal, cache:'no-store' });
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    const isJson = ct.includes('application/json');
    const body = isJson ? await res.json().catch(()=>null) : await res.text().catch(()=>null);
    if (!res.ok) throw new Error((body && (body.error||body.message)) || res.statusText || 'Request failed');
    return body;
  } finally { clearTimeout(t); }
};

const raceAny = (proms) => new Promise((resolve, reject) => {
  let rejCount = 0, done = false;
  proms.forEach(p => Promise.resolve(p).then(val => { if (!done) { done = true; resolve(val); } })
    .catch(() => { rejCount++; if (rejCount === proms.length && !done) reject(new Error('All failed')); }));
});

/** ===================== Fast + Deep discovery ===================== */
function getPackagerHost() {
  try {
    const url = NativeModules?.SourceCode?.scriptURL || '';
    const m = url.match(/^https?:\/\/([^:/]+)(?::\d+)?\//i);
    return m ? m[1] : null;
  } catch { return null; }
}
function buildPorts(prior=[3001,3000,3002,3003,3004,3005], start=3006, end=3100) {
  const rest = []; for (let p=start; p<=end; p++) rest.push(p);
  return Array.from(new Set([...prior, ...rest]));
}
function expandCidr24(ip) {
  const m = String(ip||'').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return [];
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  const out = []; for (let i=2;i<=254;i++) out.push(`${base}.${i}`);
  return out;
}
async function probeBase(base, timeout=800) {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeout);
  try {
    const ok = await fetch(`${base}/health`, { signal: ctrl.signal, cache:'no-store' }).then(r => r.ok).catch(()=>false);
    if (!ok) throw new Error('no health');
    const st = await fetch(`${base}/state`, { signal: ctrl.signal, cache:'no-store' }).then(r => r.json()).catch(()=>null);
    if (!st || typeof st !== 'object') throw new Error('bad state');
    return base;
  } finally { clearTimeout(t); }
}
async function discoverServerUltra() {
  const packager = getPackagerHost();
  let deviceIp = null;
  try { deviceIp = await Network.getIpAddressAsync(); } catch {}

  const hosts = [];
  if (packager) hosts.push(packager);
  if (Platform.OS === 'android') hosts.push('10.0.2.2','10.0.3.2');
  if (Platform.OS === 'ios') hosts.push('127.0.0.1');
  if (deviceIp && deviceIp !== packager) {
    const m = deviceIp.match(/^(\d+\.\d+\.\d+)\.(\d+)$/);
    if (m) hosts.push(`${m[1]}.1`, `${m[1]}.10`, `${m[1]}.100`);
  }
  hosts.push('127.0.0.1','localhost');

  const uniqHosts = Array.from(new Set(hosts));
  const ports = buildPorts();

  // Stage 1
  const stage1 = [];
  for (const h of uniqHosts.slice(0, 3)) for (const p of ports.slice(0, 12)) stage1.push(`http://${h}:${p}`);
  try { return await raceAny(stage1.map(b => probeBase(b, 700))); } catch {}

  // Stage 2
  const subnetHosts = deviceIp ? expandCidr24(deviceIp) : [];
  const prioritizedPorts = ports.slice(0, 12);
  const stage2 = [];
  for (const h of subnetHosts) for (const p of prioritizedPorts) stage2.push(`http://${h}:${p}`);
  const limit = 40;
  let i = 0;
  const runWindow = () => new Promise((resolve, reject) => {
    let inFlight = 0, found = false;
    const launch = () => {
      while (inFlight < limit && i < stage2.length) {
        const base = stage2[i++];
        inFlight++;
        probeBase(base, 650).then(ok => {
          if (!found) { found = true; resolve(ok); }
        }).catch(() => {
          inFlight--;
          if (i < stage2.length) launch();
          else if (inFlight === 0 && !found) reject(new Error('not found'));
        });
      }
    };
    launch();
  });
  try { return await runWindow(); } catch {}

  // Stage 3
  const stage3 = [];
  for (const h of uniqHosts.slice(0,2)) for (const p of ports) stage3.push(`http://${h}:${p}`);
  try { return await raceAny(stage3.map(b => probeBase(b, 800))); } catch {}

  throw new Error('No Beatair server found');
}

/** ===================== App ===================== */
export default function App() {
  // connection
  const [base, setBase] = useState(null);
  const [connectErr, setConnectErr] = useState(null);
  const [scanning, setScanning] = useState(true);

  // identity
  const [username, setUsername] = useState('');
  const [avatar, setAvatar] = useState('🎧');
  const [userId, setUserId] = useState(null);
  const [joining, setJoining] = useState(false);
  const [showJoin, setShowJoin] = useState(true);

  // modals
  const [showAccount, setShowAccount] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  // manual connect
  const [manualUrl, setManualUrl] = useState('');

  // sockets & state
  const [sock, setSock] = useState(null);
  const [state, setState] = useState(null);
  const [progress, setProgress] = useState({ progress_ms:0, duration_ms:0, is_playing:false });

  // search
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // library (session only)
  const [library, setLibrary] = useState([]); // {track, at}
  const upsertLibrary = (track) => {
    setLibrary(prev => {
      const existing = prev.find(x => x.track.id === track.id);
      const now = Date.now();
      if (existing) return prev.map(x => x.track.id === track.id ? { ...x, at: now } : x);
      return [{ track, at: now }, ...prev].slice(0, 200);
    });
  };

  // tabs
  const [tab, setTab] = useState('vote'); // 'vote' | 'library'

  // toasts
  const [toasts, setToasts] = useState([]);
  const pushToast = (msg) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  };

  // derived
  const votes = useMemo(() => (state?.votes || []).filter(v => (v.count||0) > 0), [state]);
  const totalVotes = useMemo(() => votes.reduce((a,b)=>a+(b.count||0), 0), [votes]);

  // progress ticker
  const lastTickRef = useRef(Date.now());
  const progressRef = useRef(progress);
  useEffect(()=>{ progressRef.current = progress; }, [progress]);
  useEffect(() => {
    const id = setInterval(() => {
      const p = progressRef.current;
      if (p.is_playing && p.duration_ms) {
        const now = Date.now();
        const delta = now - lastTickRef.current;
        lastTickRef.current = now;
        const next = Math.min(p.progress_ms + delta, p.duration_ms);
        setProgress({ ...p, progress_ms: next });
      } else {
        lastTickRef.current = Date.now();
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // connection helpers
  const connectTo = async (candidate) => {
    const url = candidate.replace(/\/+$/,'');
    try {
      const st = await fetchJson(`${url}/state`, {}, 1800);
      setBase(url); setConnectErr(null);
      setState(st); if (st && st.progress) setProgress(st.progress);
      pushToast(`Connected: ${url.replace('http://','')}`);
      return true;
    } catch (e) {
      setConnectErr(e.message||String(e));
      return false;
    }
  };

  // discover server
  useEffect(() => {
    let mounted = true;
    (async () => {
      setScanning(true);
      try {
        const found = await discoverServerUltra();
        if (!mounted) return;
        setBase(found); setConnectErr(null);
      } catch (e) {
        if (!mounted) return;
        setConnectErr(e.message || String(e));
      } finally {
        if (mounted) setScanning(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // socket wire-up
  useEffect(() => {
    if (!base) return;
    const s = io(base, { transports: ['websocket'], path: '/socket.io' });
    setSock(s);
    s.on('state', (st) => {
      setState(st);
      if (st && st.progress) setProgress(st.progress);
    });
    s.on('progress', (p) => setProgress(p));
    fetchJson(`${base}/state`).then(st => {
      setState(st);
      if (st && st.progress) setProgress(st.progress);
    }).catch(err => setConnectErr(err.message||String(err)));
    return () => s.close();
  }, [base]);

  // join/update username
  const doJoin = async (nextName) => {
    if (!base) { pushToast('No server yet—hang tight.'); return; }
    const u = String((nextName ?? username) || '').trim();
    if (!u) { pushToast('Pick a username first.'); return; }
    setJoining(true);
    try {
      const res = await fetchJson(`${base}/join`, { method:'POST', body: JSON.stringify({ username: u, avatar }) });
      setUserId(res.userId);
      setUsername(u);
      setShowJoin(false);
      pushToast(`Welcome, ${u}!`);
    } catch (e) { pushToast(e.message || 'Join failed'); }
    finally { setJoining(false); }
  };

  // search
  const doSearch = async () => {
    if (!base) return;
    const q = String(query||'').trim();
    if (!q) { setResults([]); return; }
    setSearching(true);
    try {
      const r = await fetchJson(`${base}/search?q=${encodeURIComponent(q)}`);
      setResults(r.items || []);
      setTab('vote'); // keep in the vote tab
    } catch (e) { pushToast('Search failed: ' + (e.message||'')); }
    finally { setSearching(false); Keyboard.dismiss(); }
  };
  const clearSearch = () => { setQuery(''); setResults([]); setSearching(false); Keyboard.dismiss(); };

  // voting
  const vote = async (trackId, trackMeta) => {
    if (!base) return;
    try {
      const r = await fetchJson(`${base}/vote`, { method:'POST', body: JSON.stringify({ trackId, username }) });
      setState(s => ({ ...(s||{}), votes: r.votes }));
      if (trackMeta) upsertLibrary(trackMeta);
    } catch (e) { pushToast(e.message || 'Vote failed'); }
  };

  /** ===================== UI Bits ===================== */
  const Header = () => (
    <View style={styles.header}>
      <Text style={styles.brand}>{avatar} beatair</Text>
      <View style={{flex:1}} />
      <TouchableOpacity onPress={()=>setShowAbout(true)} style={styles.iconBtn} accessibilityLabel="Cafe Info">
        <Text style={styles.iconTxt}>ℹ️</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={()=>setShowAccount(true)} style={styles.iconBtn} accessibilityLabel="Account">
        <Text style={styles.iconTxt}>👤</Text>
      </TouchableOpacity>
    </View>
  );

  const NowPlaying = () => {
    const t = state?.playingTrack;
    return (
      <View style={styles.card}>
        <View style={{flexDirection:'row', alignItems:'center'}}>
          <Image source={{ uri: t?.image || undefined }} style={styles.cover} />
          <View style={{marginLeft:12, flex:1}}>
            <Text numberOfLines={1} style={styles.title}>{t?.name || '—'}</Text>
            <Text numberOfLines={1} style={styles.subtitle}>{t?.artists || ''}</Text>
          </View>
          <Text style={styles.badge}>{fmtTime(progress?.duration_ms || 0)}</Text>
        </View>
        <ProgressLine p={progress?.progress_ms||0} d={progress?.duration_ms||0} />
        <View style={{flexDirection:'row', justifyContent:'space-between', marginTop:6}}>
          <Text style={styles.time}>{fmtTime(progress?.progress_ms||0)}</Text>
          <Text style={styles.time}>{fmtTime(progress?.duration_ms||0)}</Text>
        </View>
      </View>
    );
  };

  const ProgressLine = ({ p, d }) => {
    const pct = d > 0 ? Math.round(Math.min(100, Math.max(0, (p / d) * 100))) : 0;
    return (<View style={styles.progressOuter}><View style={[styles.progressInner, { width: `${pct}%` }]} /></View>);
  };

  const VoteRow = ({ item }) => {
    const t = item.track;
    const count = item.count || 0;
    const share = totalVotes > 0 ? count / totalVotes : 0;
    if (count <= 0) return null;
    return (
      <View style={styles.row}>
        <Image source={{ uri: t.image || undefined }} style={styles.thumb} />
        <View style={{flex:1, marginHorizontal:10}}>
          <Text numberOfLines={1} style={styles.rowTitle}>{t.name}</Text>
          <Text numberOfLines={1} style={styles.rowSub}>{t.artists}</Text>
          <View style={styles.progressOuter}><View style={[styles.progressInner, { width: `${Math.round(share*100)}%` }]} /></View>
        </View>
        <Text style={styles.badge}>{count}</Text>
        <TouchableOpacity onPress={()=>vote(t.id, t)} style={[styles.btn, styles.btnPrimary]}>
          <Text style={styles.btnText}>+1</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const SearchRow = ({ it }) => (
    <View style={styles.row}>
      <Image source={{ uri: it.image || undefined }} style={styles.thumb} />
      <View style={{flex:1, marginHorizontal:10}}>
        <Text numberOfLines={1} style={styles.rowTitle}>{it.name}</Text>
        <Text numberOfLines={1} style={styles.rowSub}>{it.artists}</Text>
      </View>
      <TouchableOpacity onPress={()=>vote(it.id, it)} style={[styles.btn, styles.btnPrimary]}>
        <Text style={styles.btnText}>Vote</Text>
      </TouchableOpacity>
    </View>
  );

  const SearchBar = () => (
    <View style={{flexDirection:'row', gap:8, paddingHorizontal:16, marginTop:10, alignItems:'center'}}>
      <TextInput
        placeholder="Search tracks…"
        placeholderTextColor="#7b8694"
        selectionColor="#a855f7"
        clearButtonMode="while-editing"
        returnKeyType="search"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={doSearch}
        style={[styles.input, {flex:1}]}
      />
      {query.length > 0 || results.length > 0 ? (
        <TouchableOpacity onPress={clearSearch} style={[styles.btn, styles.btnGhost]} accessibilityLabel="Exit search">
          <Text style={styles.btnGhostText}>Clear</Text>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity onPress={doSearch} style={[styles.btn, styles.btnPrimary]} disabled={searching}>
        {searching ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Search</Text>}
      </TouchableOpacity>
    </View>
  );

  const inSearch = results.length > 0 || (query.trim().length > 0 && searching);

  /** ============== SCREENS ============== */
  const VoteScreen = () => (
    <>
      <NowPlaying />
      <SearchBar />
      {inSearch ? (
        <View style={[styles.card, {marginTop:10}]}>
          <View style={{flexDirection:'row', alignItems:'center', marginBottom:8}}>
            <Text style={[styles.title, {flex:1}]}>Results {results.length ? `(${results.length})` : ''}</Text>
            <TouchableOpacity onPress={clearSearch} style={[styles.btn, styles.btnGhostSm]}>
              <Text style={styles.btnGhostText}>Exit</Text>
            </TouchableOpacity>
          </View>
          {results.length === 0 && searching ? (
            <View style={{paddingVertical:24, alignItems:'center'}}><ActivityIndicator color="#fff" /></View>
          ) : (
            <FlatList
              data={results}
              keyExtractor={(it)=>it.id}
              ItemSeparatorComponent={()=> <View style={{height:10}}/>}
              renderItem={({item}) => <SearchRow it={item} />}
              keyboardDismissMode="on-drag"
            />
          )}
        </View>
      ) : (
        <View style={[styles.card, {flex:1, marginTop:10}]}>
          <Text style={[styles.title, {marginBottom:10}]}>Leaderboard</Text>
          {(state?.votes||[]).filter(v=>v.count>0).length === 0 ? (
            <Text style={styles.rowSub}>No votes yet — go nudge your customers 👀</Text>
          ) : (
            <FlatList
              data={votes}
              keyExtractor={(v)=>v.track.id}
              ItemSeparatorComponent={()=> <View style={{height:10}}/>}
              renderItem={({item}) => <VoteRow item={item} />}
            />
          )}
        </View>
      )}
    </>
  );

  const LibraryScreen = () => (
    <View style={[styles.card, {flex:1}]}>
      <View style={{flexDirection:'row', alignItems:'center', marginBottom:8}}>
        <Text style={[styles.title, {flex:1}]}>Your Library</Text>
        {library.length > 0 && (
          <TouchableOpacity onPress={()=>setLibrary([])} style={[styles.btn, styles.btnGhostSm]}>
            <Text style={styles.btnGhostText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>
      {library.length === 0 ? (
        <Text style={styles.rowSub}>You haven’t voted yet. Your picks will show up here.</Text>
      ) : (
        <FlatList
          data={library}
          keyExtractor={(x)=>x.track.id}
          ItemSeparatorComponent={()=> <View style={{height:10}}/>}
          renderItem={({item}) => (
            <View style={styles.row}>
              <Image source={{ uri: item.track.image || undefined }} style={styles.thumb} />
              <View style={{flex:1, marginHorizontal:10}}>
                <Text numberOfLines={1} style={styles.rowTitle}>{item.track.name}</Text>
                <Text numberOfLines={1} style={styles.rowSub}>{item.track.artists} • {relTime(item.at)}</Text>
              </View>
              <TouchableOpacity onPress={()=>vote(item.track.id, item.track)} style={[styles.btn, styles.btnPrimary]}>
                <Text style={styles.btnText}>Vote</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      )}
    </View>
  );

  /** ============== MODALS ============== */
  const AccountModal = () => {
    const [tempName, setTempName] = useState(username);
    const [tempAvatar, setTempAvatar] = useState(avatar);
    const emojis = ['🎧','🎵','🎶','🎷','🎸','🎹','🎺','🥁','🕺','💃'];

    const save = async () => {
      setAvatar(tempAvatar);
      await doJoin(tempName);      // re-register name (and avatar) with server
      setShowAccount(false);
    };

    return (
      <Modal visible={showAccount} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={[styles.card, { width:'92%' }]}>
            <Text style={[styles.title, {marginBottom:10}]}>Your Profile</Text>
            <Text style={styles.rowSub}>Pick a display name and an avatar.</Text>

            <View style={{flexDirection:'row', alignItems:'center', marginTop:12}}>
              <Text style={[styles.title, {marginRight:10}]}>{tempAvatar}</Text>
              <TextInput
                placeholder="Your name"
                placeholderTextColor="#7b8694"
                selectionColor="#a855f7"
                style={[styles.input, {flex:1}]}
                value={tempName}
                onChangeText={setTempName}
                autoCapitalize="words"
              />
            </View>

            <View style={{flexDirection:'row', flexWrap:'wrap', gap:8, marginTop:12}}>
              {emojis.map(e => (
                <TouchableOpacity key={e} onPress={()=>setTempAvatar(e)} style={[styles.emoji, tempAvatar===e && styles.emojiSel]}>
                  <Text style={{fontSize:20}}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={{flexDirection:'row', justifyContent:'flex-end', marginTop:14}}>
              <TouchableOpacity onPress={()=>setShowAccount(false)} style={[styles.btn, styles.btnGhostSm]}>
                <Text style={styles.btnGhostText}>Close</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={save} style={[styles.btn, styles.btnPrimary, {marginLeft:8}]}>
                <Text style={styles.btnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  const AboutModal = () => (
    <Modal visible={showAbout} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={[styles.card, { width:'92%' }]}>
          <Text style={[styles.title, {marginBottom:10}]}>About this café</Text>
          <Text style={styles.rowSub}>
            <Text style={{color:'#e5e7eb'}}>Starbucks — Bodrum Marina</Text>{'\n'}
            Neyzen Tevfik Cd. No:XX, Bodrum, Muğla{'\n'}
            Open: 08:00 – 23:00 (daily){'\n'}
            Wi-Fi: <Text style={{color:'#e5e7eb'}}>Starbucks_Guest</Text>{'\n'}
            Power outlets near window seats. Quiet hours after 20:00. Friendly baristas,
            mediocre jazz playlist until you fix it 😉
          </Text>
          <View style={{flexDirection:'row', justifyContent:'flex-end', marginTop:14}}>
            <TouchableOpacity
              onPress={()=>Linking.openURL('https://maps.apple.com/?q=Starbucks+Bodrum')}
              style={[styles.btn, styles.btnGhostSm]}>
              <Text style={styles.btnGhostText}>Open in Maps</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={()=>setShowAbout(false)} style={[styles.btn, styles.btnPrimary, {marginLeft:8}]}>
              <Text style={styles.btnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  /** ===================== RENDER ===================== */
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <Header />

      {/* Join overlay (first run / change user) */}
      <Modal visible={showJoin} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={[styles.card, { width:'90%' }]}>
            <Text style={[styles.title, {marginBottom:10}]}>Choose a username</Text>
            <TextInput
              placeholder="e.g. latte_lover"
              placeholderTextColor="#7b8694"
              selectionColor="#a855f7"
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity onPress={()=>doJoin()} style={[styles.btn, styles.btnPrimary, {marginTop:10}]} disabled={joining || !base}>
              {joining ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Join</Text>}
            </TouchableOpacity>

            {!base && !scanning && (
              <View style={{marginTop:12}}>
                <Text style={[styles.rowSub, {marginBottom:6}]}>Or enter server URL:</Text>
                <TextInput
                  placeholder="http://192.168.1.23:3001"
                  placeholderTextColor="#7b8694"
                  selectionColor="#a855f7"
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={manualUrl}
                  onChangeText={setManualUrl}
                />
                <TouchableOpacity onPress={()=>connectTo(manualUrl)} style={[styles.btn, styles.btnPrimary, {marginTop:8}]}>
                  <Text style={styles.btnText}>Connect</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={{marginTop:10, opacity:0.9}}>
              {!base && <Text style={styles.rowSub}>{scanning ? 'Finding server…' : 'No server found.'}</Text>}
              {base && <Text style={styles.rowSub}>Connected to {base.replace('http://','')}</Text>}
              {connectErr && <Text style={[styles.rowSub, {color:'#ff9b9b'}]}>{connectErr}</Text>}
            </View>
          </View>
        </View>
      </Modal>

      {/* Tabs */}
      <View style={{flex:1, paddingBottom:72}}>
        {tab === 'vote' ? <VoteScreen /> : <LibraryScreen />}
      </View>

      {/* Bottom nav */}
      <View style={styles.nav}>
        <TouchableOpacity onPress={()=>setTab('vote')} style={[styles.navBtn, tab==='vote' && styles.navBtnActive]}>
          <Text style={[styles.navTxt, tab==='vote' && styles.navTxtActive]}>Vote</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={()=>setTab('library')} style={[styles.navBtn, tab==='library' && styles.navBtnActive]}>
          <Text style={[styles.navTxt, tab==='library' && styles.navTxtActive]}>Library</Text>
        </TouchableOpacity>
      </View>

      {/* Modals */}
      <AccountModal />
      <AboutModal />

      {/* Toasts (kept above nav) */}
      <View pointerEvents="none" style={[styles.toastWrap, { bottom: 96 }]}>
        {toasts.map(t => (
          <View key={t.id} style={styles.toast}><Text style={{color:'#fff'}}>{t.msg}</Text></View>
        ))}
      </View>
    </SafeAreaView>
  );
}

/** ===================== Styles ===================== */
const styles = StyleSheet.create({
  container: { flex:1, backgroundColor:'#0b1220' },

  header: { flexDirection:'row', alignItems:'center', paddingHorizontal:16, paddingTop:6, paddingBottom:6 },
  brand: { color:'#e5e7eb', fontWeight:'900', fontSize:22 },
  iconBtn: { padding:8, marginLeft:4, borderRadius:10, backgroundColor:'#0f172a', borderWidth:1, borderColor:'#1f2937' },
  iconTxt: { fontSize:16 },

  card: { backgroundColor:'#0f172a', borderColor:'#1f2937', borderWidth:1, borderRadius:20, padding:16, marginHorizontal:16 },

  cover: { width:64, height:64, borderRadius:16, backgroundColor:'#111827' },
  title: { color:'#e5e7eb', fontWeight:'800', fontSize:18 },
  subtitle: { color:'#94a3b8', marginTop:2 },
  badge: { color:'#e5e7eb', backgroundColor:'#0b1220', borderColor:'#1f2937', borderWidth:1, paddingHorizontal:8, paddingVertical:4, borderRadius:999, overflow:'hidden' },

  progressOuter: { height:8, backgroundColor:'#1f2937', borderRadius:999, overflow:'hidden', marginTop:10 },
  progressInner: { height:8, backgroundColor:'#a855f7' },
  time: { color:'#94a3b8', fontSize:12 },

  row: { flexDirection:'row', alignItems:'center', backgroundColor:'#0f172a', padding:10, borderRadius:16, borderWidth:1, borderColor:'#1f2937' },
  thumb: { width:48, height:48, borderRadius:12, backgroundColor:'#111827' },
  rowTitle: { color:'#e5e7eb', fontWeight:'700' },
  rowSub: { color:'#94a3b8' },

  btn: { paddingHorizontal:12, paddingVertical:8, borderRadius:14, borderWidth:1, borderColor:'#1f2937', backgroundColor:'#0f172a', marginLeft:8 },
  btnPrimary: { backgroundColor:'#2563eb', borderColor:'#2563eb' },
  btnText: { color:'#e5e7eb', fontWeight:'700' },

  btnGhost: { backgroundColor:'transparent', borderColor:'#334155' },
  btnGhostSm: { backgroundColor:'transparent', borderColor:'#334155', paddingHorizontal:10, paddingVertical:6, borderRadius:12 },
  btnGhostText: { color:'#e5e7eb', fontWeight:'700' },

  input: {
    backgroundColor:'#0b1220',
    borderColor:'#1f2937',
    borderWidth:1,
    borderRadius:14,
    paddingHorizontal:12,
    paddingVertical:10,
    color:'#e5e7eb'
  },

  emoji: { paddingVertical:6, paddingHorizontal:10, borderRadius:10, borderWidth:1, borderColor:'#1f2937', backgroundColor:'#0b1220' },
  emojiSel: { borderColor:'#a855f7', shadowColor:'#a855f7', shadowOpacity:0.3, shadowRadius:6 },

  overlay: { flex:1, backgroundColor:'rgba(0,0,0,0.6)', alignItems:'center', justifyContent:'center' },

  nav: {
    position:'absolute', left:12, right:12, bottom:16,
    backgroundColor:'#0f172a', borderColor:'#1f2937', borderWidth:1, borderRadius:20,
    padding:8, flexDirection:'row', justifyContent:'space-around'
  },
  navBtn: { flex:1, alignItems:'center', paddingVertical:10, borderRadius:12 },
  navBtnActive: { backgroundColor:'#111827' },
  navTxt: { color:'#94a3b8', fontWeight:'700' },
  navTxtActive: { color:'#e5e7eb' },

  toastWrap: { position:'absolute', left:16, right:16, gap:8 },
  toast: { backgroundColor:'#111827', borderColor:'#1f2937', borderWidth:1, borderRadius:12, padding:12, alignSelf:'center' },
});