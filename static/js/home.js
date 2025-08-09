// home.js - main app logic
document.addEventListener('DOMContentLoaded', () => {
  // Boot overlay minimum visible duration
  const BOOT_MIN_MS = 3000;
  const bootStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const token = localStorage.getItem('token');
  if (!token) { window.location.href = '/'; return; }
  const authFetch = (url, opts={}) => {
    opts.headers = opts.headers || {};
    opts.headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, opts);
  };

  // DOM
  const navButtons = document.querySelectorAll('.nav .item');
  const pages = document.querySelectorAll('.page');
  const profileSelect = document.getElementById('profile-select');
  const profilesBtn = document.getElementById('profiles-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsClose = document.getElementById('settings-close');
  // (Old inline IPTV settings removed; use standalone page)
  const compatToggle = null;
  const themeSelect = document.getElementById('theme-select');

  const iptvForm = document.getElementById('iptv-credentials-form');
  const iptvError = document.getElementById('iptv-error');
  const saveIptvBtn = document.getElementById('save-iptv-btn');

  // Search
  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const searchTypeChips = document.getElementById('search-type');
  const searchResults = document.getElementById('search-results');

  // Live (rows + see-all)
  const liveRowsEl = document.getElementById('live-rows');
  const liveAllEl = document.getElementById('live-all');
  const liveAllTitle = document.getElementById('live-all-title');
  const liveAllStreams = document.getElementById('live-all-streams');
  const liveBackBtn = document.getElementById('live-back');

  // Series (rows + see-all)
  const seriesRowsEl = document.getElementById('series-rows');
  const seriesAllEl = document.getElementById('series-all');
  const seriesAllTitle = document.getElementById('series-all-title');
  const seriesAllStreams = document.getElementById('series-all-streams');
  const seriesBackBtn = document.getElementById('series-back');

  const moviesRowsEl = document.getElementById('movies-rows');
  const moviesAllEl = document.getElementById('movies-all');
  const moviesAllTitle = document.getElementById('movies-all-title');
  const moviesAllStreams = document.getElementById('movies-all-streams');
  const moviesBackBtn = document.getElementById('movies-back');

  const player = document.getElementById('player-section');
  const playerTitle = document.getElementById('player-title');
  const playerClose = document.getElementById('player-close');
  const video = document.getElementById('video-player');
  // Custom controls
  const playBtn = document.getElementById('ctrl-play');
  const rewBtn = document.getElementById('ctrl-rew');
  const fwdBtn = document.getElementById('ctrl-fwd');
  const muteBtn = document.getElementById('ctrl-mute');
  const volume = document.getElementById('ctrl-volume');
  const fsBtn = document.getElementById('ctrl-fs');
  const backBtn = document.getElementById('ctrl-back');
  const progress = document.getElementById('ctrl-progress');
  const timeLabel = document.getElementById('ctrl-time');
  const centerBtn = document.getElementById('ctrl-center');
  const centerRew = document.getElementById('ctrl-center-rew');
  const centerFwd = document.getElementById('ctrl-center-fwd');
  const centerWrap = document.querySelector('.center-controls');
  const centerVolumeWrap = document.querySelector('.side-volume');
  const boostSlider = document.getElementById('ctrl-boost');

  // Boot screen
  const bootOverlay = document.getElementById('boot-overlay');
  const bootProgressBar = document.getElementById('boot-progress');
  const bootText = document.getElementById('boot-text');
  function setBootProgress(percent, text) {
    try {
      const p = Math.max(0, Math.min(100, Math.floor(percent)));
      if (bootProgressBar) bootProgressBar.style.width = p + '%';
      if (text && bootText) bootText.textContent = text;
    } catch {}
  }
  async function hideBootOverlayAfterMin() {
    try {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const elapsed = now - bootStartedAt;
      const remaining = Math.max(0, BOOT_MIN_MS - elapsed);
      if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
      if (bootOverlay) bootOverlay.style.display = 'none';
    } catch {}
  }

  // Fullscreen helpers
  function enterFullscreenForVideo(el) {
    try {
      if (el.requestFullscreen) return el.requestFullscreen();
      if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
      if (el.msRequestFullscreen) return el.msRequestFullscreen();
      if (el.webkitEnterFullscreen) { el.webkitEnterFullscreen(); return; }
    } catch (_) { /* no-op */ }
  }
  function exitFullscreenIfAny() {
    try {
      if (document.fullscreenElement && document.exitFullscreen) return document.exitFullscreen();
      if (document.webkitFullscreenElement && document.webkitExitFullscreen) return document.webkitExitFullscreen();
      if (document.msFullscreenElement && document.msExitFullscreen) return document.msExitFullscreen();
    } catch (_) { /* no-op */ }
  }

  // Attach custom player controls if present
  (function attachCustomControls(){
    if (!video || !muteBtn || !volume || !player || !progress || !timeLabel || !backBtn || !centerBtn || !centerWrap || !centerRew || !centerFwd || !centerVolumeWrap) return;
    const SEEK_STEP = 10;
    function updatePlayIcon() { try { playBtn.textContent = (video.paused ? '▶' : '❚❚'); } catch {} }
    function updateMuteIcon() {
      try {
        const muted = usingAudioGraph ? (softMuted || userVolume === 0) : (video.muted || video.volume === 0);
        muteBtn.textContent = muted ? '🔇' : '🔊';
      } catch {}
    }
    function isFullscreen() { return document.fullscreenElement === player || document.fullscreenElement === video; }
    function updateFsIcon() { try { fsBtn.textContent = isFullscreen() ? '⤡' : '⛶'; } catch {} }

    try { video.controls = false; } catch {}
    updatePlayIcon(); updateMuteIcon(); updateFsIcon();

    // bottom play/rew/fwd removed; use center controls instead
    muteBtn.addEventListener('click', () => { try { video.muted = !video.muted; } catch {} });
    // WebAudio gain pipeline to support consistent volume and optional boost
    let audioCtx = null, sourceNode = null, gainNode = null, usingAudioGraph = false;
    let userVolume = Number(volume.value || 1);
    let boostValue = Number((boostSlider && boostSlider.value) || 1);
    let softMuted = false;

    function applyEffectiveGain() {
      try {
        if (!usingAudioGraph || !gainNode) return;
        const effective = softMuted ? 0 : Math.max(0, Math.min(1, userVolume)) * Math.max(1, Math.min(3, boostValue));
        gainNode.gain.value = effective;
      } catch {}
    }

    function isSameOriginUrl(u) {
      try {
        if (!u) return true;
        if (u.startsWith('/')) return true;
        const loc = window.location;
        const url = new URL(u, loc.origin);
        return url.origin === loc.origin;
      } catch { return false; }
    }

    function ensureAudioGraph() {
      try {
        // Only enable WebAudio graph for same-origin media to avoid CORS silence
        const current = video.currentSrc || video.src || '';
        if (!isSameOriginUrl(current)) return false;
        if (!window.AudioContext && !window.webkitAudioContext) return false;
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (!sourceNode) {
          sourceNode = audioCtx.createMediaElementSource(video);
          gainNode = audioCtx.createGain();
          sourceNode.connect(gainNode).connect(audioCtx.destination);
          usingAudioGraph = true;
          // Mute element path to avoid double playback; control via gain
          video.muted = true;
          applyEffectiveGain();
        }
        return true;
      } catch { return false; }
    }

    // Remove auto-switching sources on boost to avoid resets/replays

    // Hook volume slider to gain when graph is active; otherwise fallback to element volume
    volume.addEventListener('input', () => {
      try {
        userVolume = Number(volume.value);
        if (usingAudioGraph) {
          applyEffectiveGain();
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        } else {
          video.volume = userVolume;
          if (video.volume > 0) video.muted = false; // unmute element on manual volume raise
        }
        updateMuteIcon();
      } catch {}
    });

    if (boostSlider) {
      boostSlider.addEventListener('input', () => {
        try {
          let ok = ensureAudioGraph();
          if (!ok) {
            // Fallback: cannot enable graph (likely cross-origin), keep native audio path
            video.muted = false;
            usingAudioGraph = false;
            return;
          }
          const newBoost = Math.max(1, Math.min(3, Number(boostSlider.value) || 1));
          boostValue = newBoost;
          // If user reduces boost to ~1, optionally tear down graph and revert to native path
          if (boostValue <= 1.01) {
            try {
              if (sourceNode) { try { sourceNode.disconnect(); } catch {} }
            } catch {}
            sourceNode = null; gainNode = null; usingAudioGraph = false;
            video.muted = false;
            video.volume = userVolume;
            updateMuteIcon();
            return;
          }
          applyEffectiveGain();
          if (audioCtx.state === 'suspended') audioCtx.resume();
        } catch {}
      });
    }

    // Mute toggle should control our soft mute when using audio graph
    muteBtn.addEventListener('click', () => {
      try {
        if (usingAudioGraph) {
          softMuted = !softMuted;
          applyEffectiveGain();
          updateMuteIcon();
        } else {
          video.muted = !video.muted;
          updateMuteIcon();
        }
      } catch {}
    });
    // fullscreen toggle removed from bottom controls
    backBtn.addEventListener('click', () => { try { playerClose.click(); } catch {} });
    centerBtn.addEventListener('click', () => { try { if (video.paused) { video.play().catch(()=>{}); } else { video.pause(); } } catch {} });
    centerRew.addEventListener('click', () => { try { video.currentTime = Math.max(0, (video.currentTime||0) - 10); } catch {} });
    centerFwd.addEventListener('click', () => { try { const d = isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY; video.currentTime = Math.min(d, (video.currentTime||0) + 10); } catch {} });

    function formatTime(s) {
      if (!isFinite(s) || s < 0) s = 0;
      const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); const sec = Math.floor(s%60);
      const mm = (h>0 ? String(m).padStart(2,'0') : String(m));
      const hh = String(h);
      const ss = String(sec).padStart(2,'0');
      return (h>0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`);
    }
    function updateProgressUi() {
      try {
        const dur = isFinite(video.duration) ? video.duration : 0;
        const cur = isFinite(video.currentTime) ? video.currentTime : 0;
        const val = dur>0 ? Math.round((cur/dur)*1000) : 0;
        if (Number(progress.value) !== val) progress.value = String(val);
        timeLabel.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
      } catch {}
    }
    progress.addEventListener('input', () => {
      try {
        const dur = isFinite(video.duration) ? video.duration : 0;
        if (dur > 0) {
          const ratio = Math.min(1000, Math.max(0, Number(progress.value))) / 1000;
          video.currentTime = ratio * dur;
          updateProgressUi();
        }
      } catch {}
    });
    video.addEventListener('timeupdate', updateProgressUi);
    video.addEventListener('durationchange', updateProgressUi);
    video.addEventListener('seeking', updateProgressUi);
    video.addEventListener('seeked', updateProgressUi);
    updateProgressUi();

    video.addEventListener('play', updatePlayIcon);
    video.addEventListener('pause', updatePlayIcon);
    video.addEventListener('volumechange', () => { try { if (Number(volume.value) !== video.volume) volume.value = video.volume; updateMuteIcon(); } catch {} });
    document.addEventListener('fullscreenchange', () => { try { player.dispatchEvent(new Event('forceShowUi')); } catch {} });
    // Auto-hide UI on inactivity within player
    let uiHideTimer = null;
    function showUiTemporarily() {
      try { player.classList.remove('hide-ui'); } catch {}
      if (uiHideTimer) clearTimeout(uiHideTimer);
      uiHideTimer = setTimeout(() => { try { if (!video.paused) player.classList.add('hide-ui'); } catch {} }, 2500);
    }
    function forceShowUiNow() {
      try { player.classList.remove('hide-ui'); } catch {}
      if (uiHideTimer) clearTimeout(uiHideTimer);
    }
    ['mousemove','touchstart','touchmove','keydown'].forEach(evt => {
      player.addEventListener(evt, showUiTemporarily, { passive: true });
    });
    player.addEventListener('forceShowUi', showUiTemporarily);
    // expose helpers for external calls
    try { player._forceShowUi = forceShowUiNow; player._scheduleAutoHide = showUiTemporarily; } catch {}
    video.addEventListener('play', showUiTemporarily);
    video.addEventListener('pause', () => { try { player.classList.remove('hide-ui'); centerWrap.classList.add('show'); centerVolumeWrap.classList.add('show'); centerBtn.textContent = '▶'; } catch {} });
    video.addEventListener('loadedmetadata', showUiTemporarily);
    video.addEventListener('play', () => { try { centerWrap.classList.remove('show'); centerVolumeWrap.classList.remove('show'); centerBtn.textContent = '❚❚'; } catch {} });
    showUiTemporarily();
  })();

  // (Removed preparing overlay and download-to-cache flow)

  // About modal
  const aboutOverlay = document.getElementById('about-overlay');
  const aboutClose = document.getElementById('about-close');
  const aboutPlay = document.getElementById('about-play');
  const aboutAdd = document.getElementById('about-add');
  const aboutCover = document.getElementById('about-cover');
  const aboutTitle = document.getElementById('about-title');
  const aboutQuality = document.getElementById('about-quality');
  const aboutYear = document.getElementById('about-year');
  const aboutOverview = document.getElementById('about-overview');
  const aboutSeriesBlock = document.getElementById('about-series');
  const seasonChips = document.getElementById('season-chips');
  const episodesGrid = document.getElementById('episodes-grid');

  // Settings persistence (localStorage)
  const settings = {
    get compat() { return true; }, // Always on for VOD
    set compat(v) { /* no-op, forced on */ },
    get compatLive() { return true; }, // Always on for Live
    set compatLive(v) { /* no-op, forced on */ },
    get compatSeries() { return false; }, // Keep off by default for Series
    set compatSeries(v) { localStorage.setItem('compatSeriesMode', v ? '1' : '0'); },
    get theme() { return localStorage.getItem('theme') || 'aurora'; },
    set theme(v) { localStorage.setItem('theme', v); }
  };
  // Apply theme on load
  document.documentElement.setAttribute('data-theme', settings.theme);
  themeSelect.value = settings.theme;
  // No compat toggles in UI anymore

  themeSelect.addEventListener('change', () => {
    settings.theme = themeSelect.value;
    document.documentElement.setAttribute('data-theme', settings.theme);
  });
  // Removed compat toggle listeners

  // Navigation
  function switchPage(id) {
    navButtons.forEach(b => b.classList.toggle('active', b.dataset.section === id));
    pages.forEach(p => p.classList.toggle('show', p.id === id));
    // Auto-load content for selected section
    if (id === 'movies') loadMovies();
    if (id === 'live') loadLive();
    if (id === 'series') loadSeries();
  }
  navButtons.forEach(btn => btn.addEventListener('click', () => switchPage(btn.dataset.section)));

  profilesBtn.addEventListener('click', () => switchPage('profiles-section'));
  logoutBtn.addEventListener('click', () => { localStorage.clear(); window.location.href = '/'; });
  settingsBtn.addEventListener('click', () => settingsOverlay.classList.remove('hidden'));
  settingsClose.addEventListener('click', () => settingsOverlay.classList.add('hidden'));

  // (No preload of IPTV settings in modal anymore)

  // Link to full IPTV Settings page
  (function addIptvSettingsNav(){
    try {
      const container = document.querySelector('#settings-overlay .settings');
      if (!container) return;
      // Avoid duplicate insertion
      if (container.querySelector('[data-id="iptv-settings-link-row"]')) return;
      const linkRow = document.createElement('div');
      linkRow.className = 'setting';
      linkRow.setAttribute('data-id', 'iptv-settings-link-row');
      linkRow.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><div><strong>Open IPTV Settings</strong><div class="muted">Manage IPTV credentials and refresh connection</div></div><a class="button" href="/settings/iptv">Open</a></div>';
      const ref = container.querySelector('.actions');
      if (ref && ref.parentNode === container) {
        container.insertBefore(linkRow, ref);
      } else {
        container.appendChild(linkRow);
      }
    } catch {}
  })();

  // (No save/refresh handlers in modal anymore)

  // Profiles
  async function loadProfiles() {
    try {
      const res = await authFetch('/profiles');
      const data = await res.json();
      if (res.ok) {
        profileSelect.innerHTML = '';
        data.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id; opt.textContent = p.name;
          profileSelect.appendChild(opt);
        });
        if (!localStorage.getItem('profileId') && data.length) {
          localStorage.setItem('profileId', data[0].id);
        }
        if (localStorage.getItem('profileId')) {
          profileSelect.value = localStorage.getItem('profileId');
        }
        const list = document.getElementById('profiles-list');
        list.innerHTML = '';
        data.forEach(p => {
          const card = document.createElement('div');
          card.className = 'card card-item';
          card.style.padding = '10px'; card.style.display = 'grid'; card.style.placeItems = 'center';
          card.textContent = p.name;
          list.appendChild(card);
        });
      }
    } catch {}
  }
  profileSelect.addEventListener('change', () => localStorage.setItem('profileId', profileSelect.value));

  // IPTV credentials
  async function checkIptv() {
    try {
      const res = await authFetch('/categories/live');
      if (res.ok) {
        if (iptvForm) iptvForm.style.display = 'none';
        return true; // Has credentials
      } else {
        if (iptvForm) iptvForm.style.display = 'block';
        return false; // No credentials
      }
    } catch {
      if (iptvForm) iptvForm.style.display = 'block';
      return false; // Error means no credentials
    }
  }
  saveIptvBtn.addEventListener('click', async () => {
    iptvError.textContent = '';
    const server_url = document.getElementById('server-url').value.trim();
    const username = document.getElementById('iptv-username').value.trim();
    const password = document.getElementById('iptv-password').value.trim();
    if (!server_url || !username || !password) { iptvError.textContent = 'All IPTV fields are required.'; return; }
    try {
      const res = await authFetch('/iptv/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({server_url, username, password})});
      const data = await res.json();
      if (res.ok) {
        iptvForm.style.display = 'none';
        await buildHomeRows();
      } else {
        iptvError.textContent = data.error || 'Failed to save IPTV credentials.';
      }
    } catch {
      iptvError.textContent = 'Could not connect to server.';
    }
  });

  // Live TV catalog (rows + see all)
  async function loadLive() {
    if (!liveRowsEl) return;
    liveRowsEl.style.display = '';
    if (liveAllEl) liveAllEl.style.display = 'none';
    liveRowsEl.innerHTML = '';
    try {
      const cats = await cachedFetchJson('/categories/live', 600);
      if (!Array.isArray(cats)) { liveRowsEl.textContent = 'Failed to load categories'; return; }
      for (const cat of cats) {
        const wrap = document.createElement('div');
        const h = document.createElement('h2');
        h.className = 'section-title';
        h.textContent = cat.category_name;
        const row = document.createElement('div');
        row.className = 'cards-row';
        wrap.appendChild(h);
        wrap.appendChild(row);
        liveRowsEl.appendChild(wrap);
        try {
          const items = await cachedFetchJson('/streams/live/' + cat.category_id, 300);
          if (Array.isArray(items)) {
            items.slice(0,10).forEach(item => row.appendChild(createLiveCard(item)));
            const seeCard = document.createElement('div');
            seeCard.className = 'card-item';
            const seeImg = document.createElement('img');
            seeImg.src = 'https://via.placeholder.com/300x420?text=See+All';
            const seeLabel = document.createElement('div');
            seeLabel.className = 'label';
            seeLabel.textContent = 'See All';
            seeCard.appendChild(seeImg);
            seeCard.appendChild(seeLabel);
            seeCard.addEventListener('click', () => showAllLive(cat));
            row.appendChild(seeCard);
          }
        } catch {}
      }
    } catch {
      liveRowsEl.textContent = 'Failed to load categories';
    }
  }

  function createLiveCard(item) {
    const card = document.createElement('div');
    card.className = 'card-item';
    const img = document.createElement('img');
    img.src = item.stream_icon || item.cover || 'https://via.placeholder.com/300x420?text=No+Image';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = item.name || item.title || 'Untitled';
    card.dataset.streamId = item.stream_id;
    card.dataset.type = 'live';
    card.dataset.title = label.textContent;
    card.dataset.thumb = img.src;
    card.appendChild(img);
    card.appendChild(label);
    card.addEventListener('click', () => openAbout(card));
    return card;
  }

  async function showAllLive(cat) {
    if (!liveAllEl) return;
    liveRowsEl.style.display = 'none';
    liveAllEl.style.display = 'block';
    liveAllTitle.textContent = cat.category_name;
    liveAllStreams.innerHTML = '';
    try {
      const streams = await cachedFetchJson('/streams/live/' + cat.category_id, 300);
      if (!Array.isArray(streams)) { liveAllStreams.textContent = 'Failed to load streams'; return; }
      streams.forEach(item => liveAllStreams.appendChild(createLiveCard(item)));
    } catch {
      liveAllStreams.textContent = 'Failed to load streams';
    }
  }

  if (liveBackBtn) {
    liveBackBtn.addEventListener('click', () => {
      liveAllEl.style.display = 'none';
      liveRowsEl.style.display = '';
    });
  }

  // Series catalog (rows + see all)
  async function loadSeries() {
    if (!seriesRowsEl) return;
    seriesRowsEl.style.display = '';
    if (seriesAllEl) seriesAllEl.style.display = 'none';
    seriesRowsEl.innerHTML = '';
    try {
      const cats = await cachedFetchJson('/categories/series', 600);
      if (!Array.isArray(cats)) { seriesRowsEl.textContent = 'Failed to load categories'; return; }
      for (const cat of cats) {
        const wrap = document.createElement('div');
        const h = document.createElement('h2');
        h.className = 'section-title';
        h.textContent = cat.category_name;
        const row = document.createElement('div');
        row.className = 'cards-row';
        wrap.appendChild(h);
        wrap.appendChild(row);
        seriesRowsEl.appendChild(wrap);
        try {
          const items = await cachedFetchJson('/streams/series/' + cat.category_id, 300);
          if (Array.isArray(items)) {
            items.slice(0,10).forEach(item => row.appendChild(createSeriesCard(item)));
            const seeCard = document.createElement('div');
            seeCard.className = 'card-item';
            const seeImg = document.createElement('img');
            seeImg.src = 'https://via.placeholder.com/300x420?text=See+All';
            const seeLabel = document.createElement('div');
            seeLabel.className = 'label';
            seeLabel.textContent = 'See All';
            seeCard.appendChild(seeImg);
            seeCard.appendChild(seeLabel);
            seeCard.addEventListener('click', () => showAllSeries(cat));
            row.appendChild(seeCard);
          }
        } catch {}
      }
    } catch {
      seriesRowsEl.textContent = 'Failed to load categories';
    }
  }

  function createSeriesCard(item) {
    const card = document.createElement('div');
    card.className = 'card-item';
    const img = document.createElement('img');
    img.src = item.stream_icon || item.cover || 'https://via.placeholder.com/300x420?text=No+Image';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = item.series_name || item.name || item.title || 'Untitled';
    card.dataset.seriesId = item.series_id;
    card.dataset.type = 'series';
    card.dataset.title = label.textContent;
    card.dataset.thumb = img.src;
    card.appendChild(img);
    card.appendChild(label);
    card.addEventListener('click', () => openAbout(card));
    return card;
  }

  async function showAllSeries(cat) {
    if (!seriesAllEl) return;
    seriesRowsEl.style.display = 'none';
    seriesAllEl.style.display = 'block';
    seriesAllTitle.textContent = cat.category_name;
    seriesAllStreams.innerHTML = '';
    try {
      const streams = await cachedFetchJson('/streams/series/' + cat.category_id, 300);
      if (!Array.isArray(streams)) { seriesAllStreams.textContent = 'Failed to load streams'; return; }
      streams.forEach(item => seriesAllStreams.appendChild(createSeriesCard(item)));
    } catch {
      seriesAllStreams.textContent = 'Failed to load streams';
    }
  }

  if (seriesBackBtn) {
    seriesBackBtn.addEventListener('click', () => {
      seriesAllEl.style.display = 'none';
      seriesRowsEl.style.display = '';
    });
  }

  // Movies catalog
  async function loadMovies() {
    moviesRowsEl.style.display = '';
    moviesAllEl.style.display = 'none';
    moviesRowsEl.innerHTML = '';
    try {
      const cats = await cachedFetchJson('/categories/vod', 600);
      if (!Array.isArray(cats)) { moviesRowsEl.textContent = 'Failed to load categories'; return; }
      for (const cat of cats) {
        const wrap = document.createElement('div');
        const h = document.createElement('h2');
        h.className = 'section-title';
        h.textContent = cat.category_name;
        const row = document.createElement('div');
        row.className = 'cards-row';
        wrap.appendChild(h);
        wrap.appendChild(row);
        moviesRowsEl.appendChild(wrap);
        try {
          const items = await cachedFetchJson('/streams/vod/' + cat.category_id, 300);
          if (Array.isArray(items)) {
            items.slice(0,10).forEach(item => row.appendChild(createVodCard(item)));
            const seeCard = document.createElement('div');
            seeCard.className = 'card-item';
            const seeImg = document.createElement('img');
            seeImg.src = 'https://via.placeholder.com/300x420?text=See+All';
            const seeLabel = document.createElement('div');
            seeLabel.className = 'label';
            seeLabel.textContent = 'See All';
            seeCard.appendChild(seeImg);
            seeCard.appendChild(seeLabel);
            seeCard.addEventListener('click', () => showAllMovies(cat));
            row.appendChild(seeCard);
          }
        } catch {}
      }
    } catch {
      moviesRowsEl.textContent = 'Failed to load categories';
    }
  }

  function createVodCard(item) {
    const card = document.createElement('div');
    card.className = 'card-item';
    const img = document.createElement('img');
    img.src = item.stream_icon || item.cover || 'https://via.placeholder.com/300x420?text=No+Image';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = item.name || item.title || 'Untitled';
    card.dataset.streamId = item.stream_id;
    card.dataset.type = 'vod';
    card.dataset.ext = item.container_extension || 'mp4';
    card.dataset.title = label.textContent;
    card.dataset.thumb = img.src;
    card.appendChild(img);
    card.appendChild(label);
    card.addEventListener('click', () => openAbout(card));
    return card;
  }

  async function showAllMovies(cat) {
    moviesRowsEl.style.display = 'none';
    moviesAllEl.style.display = 'block';
    moviesAllTitle.textContent = cat.category_name;
    moviesAllStreams.innerHTML = '';
    try {
      const streams = await cachedFetchJson('/streams/vod/' + cat.category_id, 300);
      if (!Array.isArray(streams)) { moviesAllStreams.textContent = 'Failed to load streams'; return; }
      streams.forEach(item => moviesAllStreams.appendChild(createVodCard(item)));
    } catch {
      moviesAllStreams.textContent = 'Failed to load streams';
    }
  }

  moviesBackBtn.addEventListener('click', () => {
    moviesAllEl.style.display = 'none';
    moviesRowsEl.style.display = '';
  });

  // Search implementation
  function renderSearchGroup(title, items, type) {
    if (!items || !items.length) return null;
    const wrap = document.createElement('div');
    const h = document.createElement('h2'); h.className='section-title'; h.textContent = title;
    const row = document.createElement('div'); row.className='cards-row';
    wrap.appendChild(h); wrap.appendChild(row);
    items.forEach(item => {
      if (type === 'vod') row.appendChild(createVodCard(item));
      else if (type === 'series') row.appendChild(createSeriesCard(item));
      else if (type === 'live') row.appendChild(createLiveCard(item));
    });
    return wrap;
  }

  async function performSearch() {
    if (!searchResults) return;
    const q = (searchInput?.value || '').trim();
    const typeChip = searchTypeChips?.querySelector('.chip.active');
    const contentType = typeChip ? typeChip.dataset.type : 'all';
    if (!q) { searchResults.innerHTML = ''; return; }
    searchResults.innerHTML = '<div class="card padded">Searching…</div>';
    try {
      const data = await cachedFetchJson('/search?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(contentType), 60);
      if (!data || typeof data !== 'object') { searchResults.textContent = 'Search failed'; return; }
      // data: { live:[], vod:[], series:[] }
      const groups = [];
      if (contentType === 'all' || contentType === 'live') groups.push(['Live TV', data.live, 'live']);
      if (contentType === 'all' || contentType === 'vod') groups.push(['Movies', data.vod, 'vod']);
      if (contentType === 'all' || contentType === 'series') groups.push(['Series', data.series, 'series']);
      searchResults.innerHTML = '';
      let appended = 0;
      groups.forEach(([title, items, t]) => {
        const block = renderSearchGroup(title, items, t);
        if (block) { searchResults.appendChild(block); appended++; }
      });
      if (appended === 0) {
        searchResults.innerHTML = '<div class="card padded">No results found.</div>';
      }
    } catch {
      searchResults.textContent = 'Search failed';
    }
  }

  if (searchBtn) searchBtn.addEventListener('click', performSearch);
  if (searchInput) searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') performSearch(); });
  if (searchTypeChips) searchTypeChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    Array.from(searchTypeChips.children).forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    performSearch();
  });

  // About modal + series seasons/episodes
  let currentAbout = null; // {type, id, ext}
  function openAbout(card) {
    aboutOverlay.classList.remove('hidden');
    aboutSeriesBlock.classList.add('hidden');
    aboutTitle.textContent = card.dataset.title;
    aboutCover.src = card.dataset.thumb;
    aboutOverview.textContent = 'Loading details…';
    aboutQuality.textContent = '';
    aboutYear.textContent = '';

    const type = card.dataset.type;
    if (type === 'vod') {
      const id = card.dataset.streamId;
      currentAbout = {type, id, ext: (card.dataset.ext || 'mp4')};
      fetchInfo('vod', id).then(info => {
        aboutOverview.textContent = (info.info && (info.info.plot || info.info.description)) || 'No description available.';
        aboutYear.textContent = (info.info && (info.info.releasedate || info.info.releaseDate || '')).toString().slice(0,4);
        aboutQuality.textContent = (info.info && (info.info.container_extension || card.dataset.ext || 'mp4')).toUpperCase();
      });
    } else if (type === 'series') {
      const sid = card.dataset.seriesId;
      currentAbout = {type, id: sid};
      aboutSeriesBlock.classList.remove('hidden');
      fetchInfo('series', sid).then(info => {
        const details = info.info || {};
        aboutOverview.textContent = details.plot || 'No description available.';
        aboutYear.textContent = (details.releaseDate || details.start) ? String(details.releaseDate || details.start).slice(0,4) : '';
        aboutQuality.textContent = 'HD';
        // Build seasons
        seasonChips.innerHTML = '';
        episodesGrid.innerHTML = '';
        const seasons = info.seasons || [];
        const episodesBySeason = info.episodes || {};
        seasons.forEach((s, idx) => {
          const chip = document.createElement('div');
          chip.className = 'chip' + (idx===0 ? ' active' : '');
          chip.textContent = s.name || ('Season ' + (s.season_number || (idx+1)));
          chip.addEventListener('click', () => {
            Array.from(seasonChips.children).forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            renderEpisodes(episodesBySeason[String(s.season_number)] || []);
          });
          seasonChips.appendChild(chip);
          if (idx===0) renderEpisodes(episodesBySeason[String(s.season_number)] || []);
        });
      });
    } else {
      // live
      currentAbout = {type: 'live', id: card.dataset.streamId};
      aboutOverview.textContent = 'Live channel.';
      aboutQuality.textContent = 'LIVE';
    }
  }

  function renderEpisodes(list) {
    episodesGrid.innerHTML = '';
    list.forEach(ep => {
      const epDiv = document.createElement('div');
      epDiv.className = 'card-item';
      const img = document.createElement('img');
      img.src = ep.info && ep.info.movie_image ? ep.info.movie_image : 'https://via.placeholder.com/300x180?text=Episode';
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = (ep.title || ('Episode ' + ep.episode_num));
      epDiv.appendChild(img); epDiv.appendChild(label);
      epDiv.addEventListener('click', () => {
        playStream('series', ep.id, label.textContent, 'mp4');
        aboutOverlay.classList.add('hidden');
      });
      episodesGrid.appendChild(epDiv);
    });
  }

  async function fetchInfo(kind, id) {
    return await cachedFetchJson('/info/' + kind + '/' + id, 1200);
  }

  // About actions
  aboutClose.addEventListener('click', () => aboutOverlay.classList.add('hidden'));
  aboutPlay.addEventListener('click', () => {
    if (!currentAbout) return;
    if (currentAbout.type === 'vod') {
      playStream('vod', currentAbout.id, aboutTitle.textContent, currentAbout.ext);
    } else if (currentAbout.type === 'live') {
      const liveCompat = settings.compatLive;
      playStream(liveCompat ? 'compat-live' : 'live', currentAbout.id, aboutTitle.textContent, liveCompat ? 'mp4' : 'ts');
    } else if (currentAbout.type === 'series') {
      const serCompat = settings.compatSeries;
      playStream('series', currentAbout.id, aboutTitle.textContent, serCompat ? 'mp4' : 'mp4');
    }
    aboutOverlay.classList.add('hidden');
  });
  aboutAdd.addEventListener('click', async () => {
    const pid = localStorage.getItem('profileId');
    if (!pid) return alert('Create a profile first');
    if (!currentAbout) return;
    const payload = { content_type: currentAbout.type, item_id: String(currentAbout.id), title: aboutTitle.textContent, thumbnail: aboutCover.src };
    const res = await authFetch('/profiles/' + pid + '/favourites', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
    if (res.ok) alert('Added to My List'); else alert('Failed to add');
  });

  // Playback
  let currentPlayback = null; // {type, id}

  playerClose.addEventListener('click', async () => {
    try { video.pause(); } catch {}
    player.classList.add('hidden');
    exitFullscreenIfAny();
    currentPlayback = null;
  });

  // Removed unload cache clearing

  async function playStream(type, id, title, ext) {
    const tokenParam = 'token=' + encodeURIComponent(token);
    const needsToken = (u) => typeof u === 'string' && (u.startsWith('/') || u.startsWith(window.location.origin));
    const addTokenIfNeeded = (u) => needsToken(u) ? (u + (u.includes('?') ? '&' : '?') + tokenParam) : u;

    async function getDirectUrl() {
      const directType = (type === 'compat-live') ? 'live' : type;
      const u = '/stream_url/' + directType + '/' + id + (directType !== 'live' ? ('?ext=' + encodeURIComponent(ext || 'mp4')) : '');
      try {
        const data = await authFetch(u).then(r => r.json());
        return (data && data.url) ? data.url : '';
      } catch { return ''; }
    }

    // HLS pipeline removed (no /hls endpoint); rely on compat/direct/cached

    async function buildCandidates() {
      const candidates = [];
      if (type === 'vod') {
        // Decide between HLS VOD and MP4 proxy
        let hlsOk = false; let hlsUrl = '';
        try {
          const chk = await authFetch('/hls/check/vod/' + id).then(r => r.json());
          hlsOk = !!(chk && chk.ok);
          hlsUrl = (chk && chk.url) || '';
        } catch {}
        if (hlsOk && hlsUrl) {
          candidates.push(hlsUrl);
        } else {
          // Use MP4 path: prefer direct, else proxy with Range forwarding
          const direct = await getDirectUrl();
          if (direct) candidates.push(direct);
          candidates.push(addTokenIfNeeded('/proxy/vod/' + id + '?ext=' + encodeURIComponent(ext || 'mp4')));
          // Fallback to compat if needed
          candidates.push(addTokenIfNeeded('/compat/vod/' + id + '?ext=' + encodeURIComponent(ext || 'mp4')));
        }
      } else if (type === 'live') {
        // Prefer live compat first to keep same-origin for booster
        candidates.push(addTokenIfNeeded('/compat/live/' + id));
        const direct = await getDirectUrl();
        if (direct) candidates.push(direct);
      } else if (type === 'series') {
        // Series behaves like VOD: try HLS VOD per-episode id; if not, MP4/proxy/compat
        let hlsOk = false; let hlsUrl = '';
        try {
          const chk = await authFetch('/hls/check/vod/' + id).then(r => r.json());
          hlsOk = !!(chk && chk.ok);
          hlsUrl = (chk && chk.url) || '';
        } catch {}
        if (hlsOk && hlsUrl) {
          candidates.push(hlsUrl);
        } else {
          const direct = await getDirectUrl();
          if (direct) candidates.push(direct);
          candidates.push(addTokenIfNeeded('/proxy/vod/' + id + '?ext=' + encodeURIComponent(ext || 'mp4')));
          candidates.push(addTokenIfNeeded('/compat/series/' + id + '?ext=' + encodeURIComponent(ext || 'mp4')));
        }
      }
      return candidates;
    }

    function tryPlay(list, idx) {
      if (idx >= list.length) { alert('Playback error'); return; }
      const src = list[idx];
      let suppressFallbackUntil = 0;
      playerTitle.textContent = title || '';
      player.classList.remove('hidden');
      try {
        player.classList.remove('hide-ui');
        if (player._forceShowUi) player._forceShowUi();
        if (player._scheduleAutoHide) player._scheduleAutoHide();
      } catch {}
      try { centerWrap.classList.add('show'); centerBtn.textContent = video.paused ? '▶' : '❚❚'; } catch {}
      video.muted = false;
      video.autoplay = true;
      // Player policy:
      // - <video preload="metadata">
      // - Never call load() or reset src unnecessarily
      // - If HLS m3u8: use native HLS on Safari; otherwise hls.js
      const isM3U8 = typeof src === 'string' && src.includes('.m3u8');
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
      try { video.preload = 'metadata'; } catch {}
      if (isM3U8) {
        if (isSafari) {
          video.src = src;
        } else if (window.Hls && window.Hls.isSupported()) {
          if (video._hls) { try { video._hls.destroy(); } catch {} }
          const hls = new window.Hls({ enableWorker: true });
          video._hls = hls;
          hls.attachMedia(video);
          hls.on(window.Hls.Events.MEDIA_ATTACHED, () => { try { hls.loadSource(src); } catch {} });
          hls.on(window.Hls.Events.ERROR, () => fallback());
        } else {
          // No HLS support; fallback
          return fallback();
        }
      } else {
        video.src = src;
      }

      let settled = false;
      const cleanup = () => {
        video.onerror = null;
        video.onstalled = null;
        video.onabort = null;
        video.oncanplay = null;
        video.onplaying = null;
      };
      const fallback = () => {
        if (settled) return;
        if (Date.now() < suppressFallbackUntil) return; // avoid switching sources during user seeks
        settled = true;
        cleanup();
        if (video._hls) { try { video._hls.destroy(); } catch {} video._hls = null; }
        tryPlay(list, idx + 1);
      };
      video.onerror = fallback;
      video.onstalled = () => setTimeout(fallback, 5000);
      video.onabort = fallback;
      video.onplaying = () => {
        settled = true; cleanup();
        // Request fullscreen after playback actually begins so UI is visible
        try {
          if (!document.fullscreenElement && type === 'vod') {
            if (player.requestFullscreen) player.requestFullscreen();
            else if (video.requestFullscreen) video.requestFullscreen();
          }
        } catch {}
        try { centerWrap.classList.remove('show'); centerBtn.textContent = '❚❚'; } catch {}
        // If using WebAudio boost, ensure audio graph applies
        try {
          if (usingAudioGraph) {
            applyEffectiveGain();
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
          }
        } catch {}
        // If bad duration (e.g., grows from 10s), switch to HLS fallback
        setTimeout(() => {
          const dur = video.duration;
          // Do not force fallback based on duration anymore to avoid restarts on certain files
        }, 1500);
      };
      video.addEventListener('seeking', () => { suppressFallbackUntil = Date.now() + 6000; });
      // Seeking policy: set currentTime and wait for 'seeked' handled by default events
      // No cache cleanup on end

      const playPromise = video.play();
      if (playPromise && playPromise.catch) playPromise.catch(() => setTimeout(fallback, 1000));

    }

    // No cache lifecycle
    currentPlayback = { type, id: String(id), ext: ext };
    buildCandidates().then(cands => tryPlay(cands, 0));
  }

  // Caching helpers and boot preload
  const cache = {
    get(key) {
      try {
        const raw = localStorage.getItem('cache:' + key);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        const { v, t, ttl } = obj;
        if (Date.now() - t > ttl) { localStorage.removeItem('cache:' + key); return null; }
        return v;
      } catch { return null; }
    },
    set(key, value, ttlMs) {
      try { localStorage.setItem('cache:' + key, JSON.stringify({ v: value, t: Date.now(), ttl: ttlMs })); } catch {}
    }
  };

  async function cachedFetchJson(path, ttlSeconds, bypassCacheOnce) {
    const key = path;
    const ttlMs = (ttlSeconds || 300) * 1000;
    if (!bypassCacheOnce) {
      const cached = cache.get(key);
      if (cached !== null && cached !== undefined) return cached;
    }
    const resp = await authFetch(path);
    const data = await resp.json();
    if (resp.ok) cache.set(key, data, ttlMs);
    return data;
  }

  // Warm the localStorage cache for faster initial rendering
  async function warmHomeCache() {
    try {
      const typeList = ['vod', 'series', 'live'];
      // Fetch categories in parallel
      const catsByType = await Promise.all(typeList.map(t => cachedFetchJson('/categories/' + t, 600)));
      const tasks = [];
      catsByType.forEach((cats, idx) => {
        const t = typeList[idx];
        if (!Array.isArray(cats)) return;
        // Prefetch streams for first few categories per type
        const limit = (t === 'live') ? 6 : 10;
        cats.slice(0, limit).forEach(cat => {
          const catId = cat && (cat.category_id || cat.categoryId);
          if (!catId) return;
          tasks.push(cachedFetchJson('/streams/' + t + '/' + catId, 300));
        });
      });
      await Promise.allSettled(tasks);
    } catch {}
  }

  // Build rows across Movies, Series and Live after credentials are present
  async function buildHomeRows() {
    try {
      await warmHomeCache();
    } catch {}
    try {
      await Promise.all([
        (async () => { try { await loadMovies(); } catch {} })(),
        (async () => { try { await loadSeries(); } catch {} })(),
        (async () => { try { await loadLive(); } catch {} })()
      ]);
    } catch {}
  }

  // Add timeout wrapper for async operations
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
    ]);
  }

  async function bootPreload() {
    // Minimal, non-blocking boot: always reveal UI immediately
    try { await loadProfiles(); } catch {}

    let hasCredentials = false;
    try { hasCredentials = await checkIptv(); } catch {}

    // Show/hide IPTV form based on credentials
    if (iptvForm) iptvForm.style.display = hasCredentials ? 'none' : 'block';

    // Kick off content loading in background
    const rowsPromise = hasCredentials ? buildHomeRows() : Promise.resolve();
    // Keep boot overlay visible for at least BOOT_MIN_MS
    await hideBootOverlayAfterMin();
    // Ensure any pending build completes (without blocking overlay timing)
    try { await rowsPromise; } catch {}
  }

  // init
  bootPreload().catch(() => { 
    console.warn('bootPreload failed');
    try { if (bootOverlay) bootOverlay.style.display = 'none'; } catch {} 
  });
  // Safety: ensure overlay never sticks on first load
  setTimeout(() => { 
    try { if (bootOverlay && bootOverlay.style.display !== 'none') bootOverlay.style.display = 'none'; } catch {} 
  }, Math.max(BOOT_MIN_MS + 2000, 6000));
});
