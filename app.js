// ============================================================
// RISHI MUSIC - BULLETPROOF ENGINE WITH PERMANENT REPO TRACKS
// ============================================================

const DB_NAME = "RishiMusicDB";
const DB_VERSION = 3;
const STORES = {
  TRACKS: "tracks",
  PLAYLISTS: "playlists",
  METADATA: "metadata"
};

// ------------------------------------------------------------
// ADD YOUR PERMANENT GITHUB SONGS HERE
// Put MP3 files inside a "songs/" folder in your repository
// ------------------------------------------------------------
const DEFAULT_CATALOG = [
  {
    title: "Example Song 1",
    director: "HARRIS JAYARAJ",
    url: "./songs/track1.mp3"
  },
  {
    title: "Example Song 2",
    director: "ANIRUDH RAVICHANDER",
    url: "./songs/track2.mp3"
  }
];

// App State
let db = null;
let songs = [];
let currentIndex = -1;
let activeDirector = "all";
let searchQuery = "";

let favorites = new Set();
let recentlyPlayed = [];
let playlists = {};
let playHistoryStats = {};
let repeatMode = "off";
let isShuffle = false;
let sleepTimerId = null;
let sleepTimerRemaining = 0;

// Web Audio & Equalizer Nodes
let audioCtx = null;
let audioSource = null;
let bassNode = null;
let trebleNode = null;
let eqInitialized = false;

// Playback Pipeline Control
let playbackGeneration = 0;
let isTransitioning = false;
let nextSongTimer = null;
let activePlayPromise = null;
let unplayedQueue = [];
const blobUrlCache = new WeakMap();

const audio = document.getElementById("audioEngine") || new Audio();
if (!document.getElementById("audioEngine")) {
  audio.id = "audioEngine";
  audio.preload = "auto";
  audio.setAttribute("playsinline", "true");
  document.body.appendChild(audio);
}

// ============================================================
// 1. PERSISTENT STORAGE & INDEXEDDB
// ============================================================

async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    const isPersisted = await navigator.storage.persisted();
    if (!isPersisted) {
      await navigator.storage.persist();
    }
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORES.TRACKS)) {
        database.createObjectStore(STORES.TRACKS, { keyPath: "id", autoIncrement: true });
      }
      if (!database.objectStoreNames.contains(STORES.PLAYLISTS)) {
        database.createObjectStore(STORES.PLAYLISTS, { keyPath: "name" });
      }
      if (!database.objectStoreNames.contains(STORES.METADATA)) {
        database.createObjectStore(STORES.METADATA, { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

function saveTrackToDB(track) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database unavailable"));
    const tx = db.transaction(STORES.TRACKS, "readwrite");
    const store = tx.objectStore(STORES.TRACKS);
    const req = store.add(track);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function updateTrackInDB(track) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database unavailable"));
    const tx = db.transaction(STORES.TRACKS, "readwrite");
    const store = tx.objectStore(STORES.TRACKS);
    const req = store.put(track);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function loadAllTracksFromDB() {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database unavailable"));
    const tx = db.transaction(STORES.TRACKS, "readonly");
    const store = tx.objectStore(STORES.TRACKS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function setPersistentMeta(key, value) {
  return new Promise((resolve) => {
    if (!db) return resolve();
    const tx = db.transaction(STORES.METADATA, "readwrite");
    const store = tx.objectStore(STORES.METADATA);
    store.put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function getPersistentMeta(key) {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    const tx = db.transaction(STORES.METADATA, "readonly");
    const store = tx.objectStore(STORES.METADATA);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => resolve(null);
  });
}

// ============================================================
// 2. EQUALIZER ENGINE (WEB AUDIO API)
// ============================================================

function initEqualizer() {
  if (eqInitialized) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    audioSource = audioCtx.createMediaElementSource(audio);

    bassNode = audioCtx.createBiquadFilter();
    bassNode.type = "lowshelf";
    bassNode.frequency.value = 250;
    bassNode.gain.value = 0;

    trebleNode = audioCtx.createBiquadFilter();
    trebleNode.type = "highshelf";
    trebleNode.frequency.value = 4000;
    trebleNode.gain.value = 0;

    audioSource.connect(bassNode);
    bassNode.connect(trebleNode);
    trebleNode.connect(audioCtx.destination);
    eqInitialized = true;
  } catch (err) {
    console.debug("Equalizer waiting for interaction:", err);
  }
}

function applyEqualizerPreset(presetName) {
  if (!eqInitialized) initEqualizer();
  if (!bassNode || !trebleNode) return;

  switch (presetName) {
    case "Bass Boost":
      bassNode.gain.value = 8;
      trebleNode.gain.value = -1;
      break;
    case "Vocal":
      bassNode.gain.value = -2;
      trebleNode.gain.value = 6;
      break;
    case "Rock":
      bassNode.gain.value = 5;
      trebleNode.gain.value = 4;
      break;
    case "Flat":
    default:
      bassNode.gain.value = 0;
      trebleNode.gain.value = 0;
      break;
  }
}

// ============================================================
// 3. SLEEP TIMER & FORMATTERS
// ============================================================

function setSleepTimer(minutes) {
  if (sleepTimerId) {
    clearInterval(sleepTimerId);
    sleepTimerId = null;
  }

  const buttons = {
    15: document.getElementById("timer15"),
    30: document.getElementById("timer30"),
    60: document.getElementById("timer60"),
    0: document.getElementById("timerOff")
  };

  Object.values(buttons).forEach(b => b?.classList.remove("active"));

  if (!minutes || minutes <= 0) {
    sleepTimerRemaining = 0;
    buttons[0]?.classList.add("active");
    updateSleepTimerUI();
    return;
  }

  buttons[minutes]?.classList.add("active");
  sleepTimerRemaining = minutes * 60;
  updateSleepTimerUI();

  sleepTimerId = setInterval(() => {
    sleepTimerRemaining--;
    updateSleepTimerUI();

    if (sleepTimerRemaining <= 0) {
      clearInterval(sleepTimerId);
      sleepTimerId = null;
      audio.pause();
      updatePlayButton();
      setMediaSessionState("paused");
      buttons[0]?.classList.add("active");
    }
  }, 1000);
}

function updateSleepTimerUI() {
  const timerLabel = document.getElementById("sleepTimerDisplay");
  if (!timerLabel) return;
  timerLabel.textContent = sleepTimerRemaining <= 0 ? "Off" : formatTime(sleepTimerRemaining);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// ============================================================
// 4. METADATA HELPERS & DIVERSE QUEUE
// ============================================================

function getSongDirector(song) {
  return String(song?.director || song?.artist || "UNKNOWN DIRECTOR").trim().toUpperCase();
}

function getSongTitle(song) {
  return song?.title || song?.name || "Unknown Track";
}

function getSongSource(song) {
  if (!song) return null;
  if (song.blob) {
    if (!blobUrlCache.has(song.blob)) {
      blobUrlCache.set(song.blob, URL.createObjectURL(song.blob));
    }
    return blobUrlCache.get(song.blob);
  }
  return song.url || null;
}

function getFilteredSongIndexes() {
  const result = [];
  const query = searchQuery.trim().toLowerCase();

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    if (activeDirector !== "all" && getSongDirector(song) !== activeDirector) continue;
    if (query) {
      const match = [song.title || "", song.director || "", song.artist || ""].join(" ").toLowerCase();
      if (!match.includes(query)) continue;
    }
    result.push(i);
  }
  return result;
}

function getAutomaticSongIndexes() {
  const result = [];
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    if (activeDirector !== "all" && getSongDirector(song) !== activeDirector) continue;
    result.push(i);
  }
  return result;
}

function getNextUniqueSongIndex() {
  const pool = getAutomaticSongIndexes();
  if (pool.length === 0) return -1;
  if (pool.length === 1) return pool[0];

  unplayedQueue = unplayedQueue.filter(idx => pool.includes(idx));

  if (unplayedQueue.length === 0) {
    unplayedQueue = pool.filter(idx => idx !== currentIndex);
    if (unplayedQueue.length === 0) unplayedQueue = pool.slice();

    for (let i = unplayedQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unplayedQueue[i], unplayedQueue[j]] = [unplayedQueue[j], unplayedQueue[i]];
    }
  }

  let chosenIndex = 0;
  if (activeDirector === "all" && unplayedQueue.length > 1) {
    const currentDirector = songs[currentIndex] ? getSongDirector(songs[currentIndex]) : null;
    const diffIndex = unplayedQueue.findIndex(idx => getSongDirector(songs[idx]) !== currentDirector);
    if (diffIndex !== -1) chosenIndex = diffIndex;
  }

  return unplayedQueue.splice(chosenIndex, 1)[0];
}

// ============================================================
// 5. AIRPODS / BLUETOOTH MEDIA SESSION
// ============================================================

function setMediaSessionState(state) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch (e) {}
}

function updateMediaSession(song) {
  if (!("mediaSession" in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: getSongTitle(song),
      artist: getSongDirector(song),
      album: "Rishi Music"
    });
    updateMediaPositionState();
  } catch (e) {}
}

function updateMediaPositionState() {
  if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime || 0, audio.duration)
      });
    } catch (e) {}
  }
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  // Single Click: Play / Unstick
  navigator.mediaSession.setActionHandler("play", async () => {
    isTransitioning = false;
    if (nextSongTimer) clearTimeout(nextSongTimer);
    try {
      if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
      await audio.play();
      updatePlayButton();
      setMediaSessionState("playing");
    } catch (err) {
      playNextAutomaticSong();
    }
  });

  // Single Click: Pause
  navigator.mediaSession.setActionHandler("pause", () => {
    isTransitioning = false;
    audio.pause();
    updatePlayButton();
    setMediaSessionState("paused");
  });

  // Double Click: Skip Next
  navigator.mediaSession.setActionHandler("nexttrack", () => {
    isTransitioning = false;
    if (nextSongTimer) clearTimeout(nextSongTimer);
    playNextAutomaticSong();
  });

  // Triple Click: Skip Previous
  navigator.mediaSession.setActionHandler("previoustrack", () => {
    isTransitioning = false;
    if (nextSongTimer) clearTimeout(nextSongTimer);
    prevSong();
  });

  // Scrubbing & Seeking
  try {
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      const skip = details.seekOffset || 10;
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + skip);
      updateMediaPositionState();
    });

    navigator.mediaSession.setActionHandler("seekbackward", (details) => {
      const skip = details.seekOffset || 10;
      audio.currentTime = Math.max(0, audio.currentTime - skip);
      updateMediaPositionState();
    });

    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime !== undefined && Number.isFinite(details.seekTime)) {
        audio.currentTime = details.seekTime;
        updateMediaPositionState();
      }
    });
  } catch (e) {}
}

// ============================================================
// 6. ANTI-STALL PLAYBACK ENGINE
// ============================================================

async function playSongAtIndex(index, isAutomatic = false) {
  if (index < 0 || index >= songs.length) return false;
  const song = songs[index];
  if (!song) return false;

  const currentGeneration = ++playbackGeneration;

  if (nextSongTimer) {
    clearTimeout(nextSongTimer);
    nextSongTimer = null;
  }

  currentIndex = index;
  const source = getSongSource(song);
  if (!source) {
    if (isAutomatic) playNextAutomaticSong();
    return false;
  }

  if (activePlayPromise) {
    try {
      await activePlayPromise;
    } catch (e) {}
  }

  // Clear previous audio buffer to eliminate stuck audio memory
  try {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } catch (e) {}

  audio.src = source;
  audio.currentTime = 0;

  updatePlayerInformation(song);
  updateMediaSession(song);
  recordSongPlay(song);
  renderSongList();
  renderMiniPlayer();

  try {
    if (!eqInitialized) initEqualizer();
    if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();

    activePlayPromise = audio.play();
    await activePlayPromise;
    activePlayPromise = null;

    if (currentGeneration === playbackGeneration) {
      updatePlayButton();
      setMediaSessionState("playing");
      return true;
    }
    return false;
  } catch (err) {
    activePlayPromise = null;
    console.warn("Unplayable or interrupted track:", err);
    if (currentGeneration === playbackGeneration) {
      updatePlayButton();
      if (isAutomatic) playNextAutomaticSong();
    }
    return false;
  }
}

async function playNextAutomaticSong() {
  if (isTransitioning) return;
  isTransitioning = true;

  try {
    if (repeatMode === "one" && currentIndex !== -1) {
      audio.currentTime = 0;
      await audio.play();
      return;
    }

    const pool = getAutomaticSongIndexes();
    if (pool.length === 0) return;

    let attempts = 0;
    const maxAttempts = Math.min(pool.length, 5);

    while (attempts < maxAttempts) {
      attempts++;
      const nextIndex = isShuffle ? Math.floor(Math.random() * pool.length) : getNextUniqueSongIndex();
      if (nextIndex === -1) break;

      const success = await playSongAtIndex(nextIndex, true);
      if (success) return;
    }

    const sequentialIndex = (currentIndex + 1) % songs.length;
    await playSongAtIndex(sequentialIndex, true);
  } catch (err) {
    console.error("Auto transition failure:", err);
  } finally {
    isTransitioning = false;
  }
}

function togglePlay() {
  if (currentIndex === -1 || !audio.src) {
    playNextAutomaticSong();
    return;
  }

  if (audio.paused) {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    audio.play()
      .then(() => {
        updatePlayButton();
        setMediaSessionState("playing");
      })
      .catch(() => playNextAutomaticSong());
  } else {
    audio.pause();
    updatePlayButton();
    setMediaSessionState("paused");
  }
}

function nextSong() {
  isTransitioning = false;
  playNextAutomaticSong();
}

async function prevSong() {
  isTransitioning = false;
  const filtered = getFilteredSongIndexes();
  if (filtered.length === 0) return;

  const pos = filtered.indexOf(currentIndex);
  const prevIndex = pos <= 0 ? filtered[filtered.length - 1] : filtered[pos - 1];
  await playSongAtIndex(prevIndex, false);
}

function toggleShuffle() {
  isShuffle = !isShuffle;
  const btn = document.getElementById("shuffleBtn");
  if (btn) btn.classList.toggle("active", isShuffle);
}

function toggleRepeat() {
  const modes = ["off", "all", "one"];
  const nextModeIndex = (modes.indexOf(repeatMode) + 1) % modes.length;
  repeatMode = modes[nextModeIndex];

  const btn = document.getElementById("repeatBtn");
  if (btn) {
    btn.textContent = repeatMode === "one" ? "🔂" : "🔁";
    btn.classList.toggle("active", repeatMode !== "off");
  }
}

// ============================================================
// 7. USER METRICS & FAVORITES
// ============================================================

function recordSongPlay(song) {
  if (!song || !song.id) return;

  recentlyPlayed = [song.id, ...recentlyPlayed.filter(id => id !== song.id)].slice(0, 30);
  setPersistentMeta("recentlyPlayed", recentlyPlayed);

  if (!playHistoryStats[song.id]) {
    playHistoryStats[song.id] = { playCount: 0, lastPlayed: 0 };
  }
  playHistoryStats[song.id].playCount++;
  playHistoryStats[song.id].lastPlayed = Date.now();
  setPersistentMeta("playHistoryStats", playHistoryStats);
}

function toggleFavorite(songId) {
  if (favorites.has(songId)) {
    favorites.delete(songId);
  } else {
    favorites.add(songId);
  }
  setPersistentMeta("favorites", Array.from(favorites));
  renderSongList();
  renderFavoritesView();
  if (songs[currentIndex]) {
    updatePlayerInformation(songs[currentIndex]);
  }
}

function createPlaylist(name) {
  if (!name || playlists[name]) return;
  playlists[name] = [];
  setPersistentMeta("playlists", playlists);
  renderPlaylistsView();
}

// ============================================================
// 8. AUDIO EVENT LISTENERS
// ============================================================

audio.addEventListener("play", () => {
  updatePlayButton();
  setMediaSessionState("playing");
});

audio.addEventListener("pause", () => {
  updatePlayButton();
  if (!audio.ended) setMediaSessionState("paused");
});

audio.addEventListener("ended", () => {
  if (nextSongTimer) clearTimeout(nextSongTimer);
  isTransitioning = false;
  playNextAutomaticSong();
});

audio.addEventListener("error", () => {
  isTransitioning = false;
  playNextAutomaticSong();
});

audio.addEventListener("loadedmetadata", () => {
  const totalTime = document.getElementById("totalTime");
  if (totalTime) totalTime.textContent = formatTime(audio.duration);
  updateMediaPositionState();
});

audio.addEventListener("timeupdate", () => {
  const progressBar = document.getElementById("progressBar");
  const currentTime = document.getElementById("currentTime");

  if (currentTime) currentTime.textContent = formatTime(audio.currentTime);
  if (progressBar && Number.isFinite(audio.duration) && audio.duration > 0) {
    progressBar.value = (audio.currentTime / audio.duration) * 100;
  }
});

const progressBar = document.getElementById("progressBar");
if (progressBar) {
  progressBar.addEventListener("input", () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = (progressBar.value / 100) * audio.duration;
      updateMediaPositionState();
    }
  });
}

// ============================================================
// 9. UI RENDERING & DASHBOARD
// ============================================================

function updatePlayButton() {
  const playButton = document.getElementById("playBtn");
  const miniPlay = document.getElementById("miniPlayBtn");
  const text = audio.paused ? "▶" : "❚❚";
  if (playButton) playButton.textContent = text;
  if (miniPlay) miniPlay.textContent = text;
}

function updatePlayerInformation(song) {
  if (!song) return;
  const title = document.getElementById("playerTitle");
  const artist = document.getElementById("playerArtist");
  const favoriteBtn = document.getElementById("playerFavoriteBtn");

  if (title) title.textContent = getSongTitle(song);
  if (artist) artist.textContent = getSongDirector(song);
  if (favoriteBtn) {
    favoriteBtn.textContent = favorites.has(song.id) ? "❤️" : "🤍";
  }
}

function renderMiniPlayer() {
  const miniPlayer = document.getElementById("miniPlayer");
  if (!miniPlayer || currentIndex === -1) return;
  const song = songs[currentIndex];

  const miniTitle = document.getElementById("miniPlayerTitle");
  const miniArtist = document.getElementById("miniPlayerArtist");

  if (miniTitle) miniTitle.textContent = getSongTitle(song);
  if (miniArtist) miniArtist.textContent = getSongDirector(song);
  miniPlayer.style.display = "flex";
}

function renderSmartDashboard() {
  const hour = new Date().getHours();
  const greetingEl = document.getElementById("dashboardGreeting");
  if (greetingEl) {
    const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    greetingEl.textContent = `${greeting}, Rishi 👋`;
  }

  const dirContainer = document.getElementById("topDirectorsList");
  if (dirContainer) {
    dirContainer.innerHTML = "";
    const dirMap = {};
    songs.forEach((s) => {
      const d = getSongDirector(s);
      dirMap[d] = (dirMap[d] || 0) + 1;
    });

    Object.keys(dirMap)
      .sort((a, b) => dirMap[b] - dirMap[a])
      .slice(0, 6)
      .forEach((director) => {
        const item = document.createElement("div");
        item.className = "director-tile";
        item.innerHTML = `<h4>🎼 ${director}</h4><p>${dirMap[director]} Track${dirMap[director] === 1 ? "" : "s"}</p>`;
        item.onclick = () => openDirectorView(director);
        dirContainer.appendChild(item);
      });
  }
}

function openDirectorView(directorName) {
  activeDirector = directorName.toUpperCase();
  const filter = document.getElementById("directorFilter");
  if (filter) filter.value = activeDirector === "ALL" ? "all" : activeDirector;
  unplayedQueue = [];
  renderSongList();

  const title = document.getElementById("viewTitle");
  if (title) title.textContent = activeDirector === "ALL" ? "All Songs" : `🎼 ${activeDirector}`;
}

function renderSongList() {
  const container = document.getElementById("songListContainer") || document.querySelector(".song-list");
  if (!container) return;
  const filtered = getFilteredSongIndexes();
  container.innerHTML = "";

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding: 24px; opacity: 0.6; text-align: center;">No tracks found in library.</div>`;
    return;
  }

  filtered.forEach((index) => {
    const song = songs[index];
    const isFav = favorites.has(song.id);
    const card = document.createElement("div");
    card.className = "song-card" + (index === currentIndex ? " active" : "");

    card.innerHTML = `
      <div class="song-info">
        <span class="song-icon">♫</span>
        <div class="song-meta">
          <h4>${getSongTitle(song)}</h4>
          <p>${getSongDirector(song)}</p>
        </div>
      </div>
      <div class="song-actions">
        <button class="fav-btn" type="button">${isFav ? "❤️" : "🤍"}</button>
        <button class="edit-btn" type="button">Edit</button>
        <button class="play-mini" type="button">▶</button>
      </div>
    `;

    card.querySelector(".fav-btn").onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(song.id);
    };

    card.querySelector(".edit-btn").onclick = (e) => {
      e.stopPropagation();
      editSong(index);
    };

    card.querySelector(".play-mini").onclick = (e) => {
      e.stopPropagation();
      playSongAtIndex(index, false);
    };

    card.onclick = () => playSongAtIndex(index, false);
    container.appendChild(card);
  });
}

async function editSong(index) {
  const song = songs[index];
  if (!song) return;

  const newTitle = prompt("Enter song name:", getSongTitle(song));
  if (!newTitle || !newTitle.trim()) return;

  const newDirector = prompt("Enter music director name:", getSongDirector(song));
  if (!newDirector || !newDirector.trim()) return;

  song.title = newTitle.trim();
  song.director = newDirector.trim().toUpperCase();
  song.artist = song.director;

  if (song.id !== undefined && song.id !== null) {
    await updateTrackInDB(song);
  }

  updateDirectorFilter();
  renderSongList();
  renderSmartDashboard();
  if (currentIndex === index) {
    updatePlayerInformation(song);
    updateMediaSession(song);
  }
}

function updateDirectorFilter() {
  const filter = document.getElementById("directorFilter");
  if (!filter) return;
  const current = activeDirector;
  filter.innerHTML = `<option value="all">ALL DIRECTORS</option>`;

  const directors = new Set();
  songs.forEach((s) => {
    const d = getSongDirector(s);
    if (d && d !== "UNKNOWN DIRECTOR") directors.add(d);
  });

  Array.from(directors)
    .sort()
    .forEach((dir) => {
      const opt = document.createElement("option");
      opt.value = dir;
      opt.textContent = dir;
      filter.appendChild(opt);
    });

  filter.value = Array.from(filter.options).some(o => o.value === current) ? current : "all";
  activeDirector = filter.value === "all" ? "all" : filter.value;
}

function renderFavoritesView() {
  const favContainer = document.getElementById("favoritesContainer");
  if (!favContainer) return;
  favContainer.innerHTML = "";

  const favSongs = songs.filter(s => favorites.has(s.id));
  if (favSongs.length === 0) {
    favContainer.innerHTML = `<p style="padding: 12px; opacity: 0.6; font-size: 0.8rem;">No favorites marked yet.</p>`;
    return;
  }

  favSongs.forEach((song) => {
    const item = document.createElement("div");
    item.className = "song-card mini";
    item.innerHTML = `<span>❤️ ${getSongTitle(song)}</span>`;
    item.onclick = () => {
      const idx = songs.findIndex(s => s.id === song.id);
      if (idx !== -1) playSongAtIndex(idx, false);
    };
    favContainer.appendChild(item);
  });
}

function renderPlaylistsView() {
  const container = document.getElementById("playlistsContainer");
  if (!container) return;
  container.innerHTML = "";

  const listNames = Object.keys(playlists);
  if (listNames.length === 0) {
    container.innerHTML = `<span style="font-size:0.75rem; color:#666; padding: 4px;">No playlists</span>`;
    return;
  }

  listNames.forEach((name) => {
    const pEl = document.createElement("div");
    pEl.className = "playlist-item";
    pEl.innerHTML = `📁 ${name} (${playlists[name].length})`;
    pEl.onclick = () => {
      const playlistTrackIds = playlists[name];
      const foundIdx = songs.findIndex(s => playlistTrackIds.includes(s.id));
      if (foundIdx !== -1) {
        playSongAtIndex(foundIdx, false);
      }
    };
    container.appendChild(pEl);
  });
}

function updateTrackCountUI() {
  const badge = document.getElementById("trackCountBadge");
  if (badge) {
    badge.textContent = `${songs.length} track${songs.length === 1 ? "" : "s"}`;
  }
}

// ============================================================
// 10. INITIALIZATION & BUNDLED SONGS SYNC
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await requestPersistentStorage();
    await openDatabase();

    // Load saved database songs
    const storedSongs = await loadAllTracksFromDB();

    // Auto-sync default bundled GitHub songs if not already in database
    for (const defSong of DEFAULT_CATALOG) {
      const exists = storedSongs.some(s => s.title === defSong.title && s.director === defSong.director);
      if (!exists) {
        const id = await saveTrackToDB({
          title: defSong.title,
          director: defSong.director.toUpperCase(),
          artist: defSong.director.toUpperCase(),
          url: defSong.url,
          createdAt: Date.now()
        });
        storedSongs.push({
          id,
          title: defSong.title,
          director: defSong.director.toUpperCase(),
          artist: defSong.director.toUpperCase(),
          url: defSong.url
        });
      }
    }

    songs = storedSongs;
    songs.sort((a, b) => (a.id || 0) - (b.id || 0));

    const savedFavs = await getPersistentMeta("favorites");
    if (savedFavs) favorites = new Set(savedFavs);

    const savedPlaylists = await getPersistentMeta("playlists");
    if (savedPlaylists) playlists = savedPlaylists;

    const savedStats = await getPersistentMeta("playHistoryStats");
    if (savedStats) playHistoryStats = savedStats;

    const savedRecent = await getPersistentMeta("recentlyPlayed");
    if (savedRecent) recentlyPlayed = savedRecent;

    unplayedQueue = [];
    updateDirectorFilter();
    updateTrackCountUI();
    renderSmartDashboard();
    renderSongList();
    renderFavoritesView();
    renderPlaylistsView();
    updatePlayButton();
    setupMediaSession();
  } catch (err) {
    console.error("Bootloader failed to initialize:", err);
  }

  // File Upload (Manual addition)
  const audioFileInput = document.getElementById("audioFileInput");
  if (audioFileInput) {
    audioFileInput.addEventListener("change", async (event) => {
      const files = Array.from(event.target.files);
      for (const file of files) {
        const cleanName = file.name.replace(/\.[^/.]+$/, "");
        const songName = prompt("Enter song name:", cleanName);
        if (!songName || !songName.trim()) continue;

        const directorName = prompt("Enter music director name:", "UNKNOWN DIRECTOR");
        if (!directorName || !directorName.trim()) continue;

        const track = {
          title: songName.trim(),
          name: file.name,
          artist: directorName.trim().toUpperCase(),
          director: directorName.trim().toUpperCase(),
          blob: file,
          type: file.type,
          createdAt: Date.now()
        };

        const id = await saveTrackToDB(track);
        track.id = id;
        songs.push(track);
      }

      unplayedQueue = [];
      updateDirectorFilter();
      updateTrackCountUI();
      renderSongList();
      renderSmartDashboard();
      audioFileInput.value = "";
    });
  }

  // Search Filter
  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value;
      renderSongList();
    });
  }

  // Director Dropdown
  const directorFilter = document.getElementById("directorFilter");
  if (directorFilter) {
    directorFilter.addEventListener("change", () => {
      openDirectorView(directorFilter.value);
    });
  }

  // Control Buttons
  document.getElementById("playBtn")?.addEventListener("click", togglePlay);
  document.getElementById("miniPlayBtn")?.addEventListener("click", togglePlay);
  document.getElementById("nextBtn")?.addEventListener("click", nextSong);
  document.getElementById("prevBtn")?.addEventListener("click", prevSong);
  document.getElementById("shuffleBtn")?.addEventListener("click", toggleShuffle);
  document.getElementById("repeatBtn")?.addEventListener("click", toggleRepeat);

  document.getElementById("playerFavoriteBtn")?.addEventListener("click", () => {
    if (currentIndex !== -1 && songs[currentIndex]) {
      toggleFavorite(songs[currentIndex].id);
    }
  });

  // Volume Bar & Mute
  const volumeBar = document.getElementById("volumeBar");
  const muteBtn = document.getElementById("muteBtn");

  if (volumeBar) {
    volumeBar.addEventListener("input", (e) => {
      audio.volume = parseFloat(e.target.value);
      if (muteBtn) muteBtn.textContent = audio.volume === 0 ? "🔇" : "🔊";
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      if (audio.volume > 0) {
        audio.dataset.prevVolume = audio.volume;
        audio.volume = 0;
        if (volumeBar) volumeBar.value = 0;
        muteBtn.textContent = "🔇";
      } else {
        const restored = parseFloat(audio.dataset.prevVolume || "1");
        audio.volume = restored;
        if (volumeBar) volumeBar.value = restored;
        muteBtn.textContent = "🔊";
      }
    });
  }

  // Playback Speed Controls
  const speedButtons = document.querySelectorAll(".btn-speed");
  speedButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      speedButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const speed = parseFloat(btn.dataset.speed || "1.0");
      audio.playbackRate = speed;
    });
  });

  // Sleep Timers
  document.getElementById("timer15")?.addEventListener("click", () => setSleepTimer(15));
  document.getElementById("timer30")?.addEventListener("click", () => setSleepTimer(30));
  document.getElementById("timer60")?.addEventListener("click", () => setSleepTimer(60));
  document.getElementById("timerOff")?.addEventListener("click", () => setSleepTimer(0));

  // EQ Preset
  document.getElementById("eqPresetSelector")?.addEventListener("change", (e) => {
    applyEqualizerPreset(e.target.value);
  });

  // Playlists
  document.getElementById("newPlaylistBtn")?.addEventListener("click", () => {
    const name = prompt("Enter new playlist name:");
    if (name && name.trim()) {
      createPlaylist(name.trim());
    }
  });
});

// Offline Support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

// Background Cleanup
window.addEventListener("beforeunload", () => {
  if (nextSongTimer) clearTimeout(nextSongTimer);
  playbackGeneration++;
});
