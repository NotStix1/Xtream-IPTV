document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('video-player');
  const player = document.getElementById('player-section');
  const playBtn = document.getElementById('ctrl-play');
  const rewBtn = document.getElementById('ctrl-rew');
  const fwdBtn = document.getElementById('ctrl-fwd');
  const muteBtn = document.getElementById('ctrl-mute');
  const volume = document.getElementById('ctrl-volume');
  const fsBtn = document.getElementById('ctrl-fs');

  const SEEK_STEP = 10;

  function updatePlayIcon() { playBtn.textContent = video.paused ? '▶' : '❚❚'; }
  function updateMuteIcon() {
    const muted = video.muted || video.volume === 0;
    muteBtn.textContent = muted ? '🔇' : '🔊';
  }
  function isFullscreen() { return document.fullscreenElement === player; }
  function updateFsIcon() { fsBtn.textContent = isFullscreen() ? '⤡' : '⛶'; }

  video.controls = false;
  updatePlayIcon(); updateMuteIcon(); updateFsIcon();

  playBtn.addEventListener('click', () => { if (video.paused) { video.play().catch(()=>{}); } else { video.pause(); }});
  rewBtn.addEventListener('click', () => { try { video.currentTime = Math.max(0, (video.currentTime||0) - SEEK_STEP); } catch {} });
  fwdBtn.addEventListener('click', () => {
    try { const d = isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY; video.currentTime = Math.min(d, (video.currentTime||0) + SEEK_STEP); } catch {}
  });
  muteBtn.addEventListener('click', () => { video.muted = !video.muted; });
  volume.addEventListener('input', () => { video.volume = Number(volume.value); if (video.volume > 0 && video.muted) video.muted = false; });
  fsBtn.addEventListener('click', async () => { if (!isFullscreen()) { await player.requestFullscreen?.(); } else { await document.exitFullscreen?.(); } });

  video.addEventListener('play', updatePlayIcon);
  video.addEventListener('pause', updatePlayIcon);
  video.addEventListener('volumechange', () => { if (Number(volume.value) !== video.volume) volume.value = video.volume; updateMuteIcon(); });
  document.addEventListener('fullscreenchange', updateFsIcon);
});



