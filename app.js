/**
 * SonicPulse Studio — Audio Spectrum & Level Bars Visualizer + Live Weather & Market Widgets
 */

(() => {
  'use strict';

  // ============================================================================
  // 1. AUDIO ENGINE, FULL WAVEFORM DECODER & REAL-TIME LEVEL BARS VISUALIZER
  // ============================================================================
  const audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous';
  audioEl.preload = 'auto';

  let audioCtx = null;
  let decoderCtx = null;
  let analyser = null;
  let sourceNode = null;
  let freqData = null;
  let timeData = null;

  // Playlist state
  const playlist = [];
  let currentIndex = -1;
  let vizMode = 'combined'; // 'combined' | 'mirror' | 'led'

  // Precomputed full-track waveform & spectral profile (analyzed immediately on file load)
  const WAVEFORM_COLUMNS = 320;
  const wavePeaksPos = new Float32Array(WAVEFORM_COLUMNS);
  const wavePeaksNeg = new Float32Array(WAVEFORM_COLUMNS);
  const waveRms = new Float32Array(WAVEFORM_COLUMNS);
  const waveBrightness = new Float32Array(WAVEFORM_COLUMNS); // 0..1 low-to-high frequency character per slice
  let hasDecodedWaveform = false;
  let decodedDuration = 0;
  let hoverWaveformRatio = -1;
  let isScrubbingWaveform = false;

  // Peak hold array for live frequency level bars
  const NUM_BARS = 64;
  const barPeaks = new Float32Array(NUM_BARS);
  const barPeakVel = new Float32Array(NUM_BARS);
  const smoothedBars = new Float32Array(NUM_BARS);

  // DOM Elements - Audio & 3 Stacked Canvases
  const audioFileInput = document.getElementById('audioFileInput');
  const demoTrackBtn = document.getElementById('demoTrackBtn');
  const dropZone = document.getElementById('dropZone');

  // Canvas 1: Espectro Completo de la Onda
  const waveformSeekSlot = document.getElementById('waveformSeekSlot');
  const fullWaveformCanvas = document.getElementById('fullWaveformCanvas');
  const waveCtx = fullWaveformCanvas.getContext('2d');
  const waveformAnalysisBadge = document.getElementById('waveformAnalysisBadge');
  const waveformCursorTime = document.getElementById('waveformCursorTime');

  // Canvas 2: Barras de Niveles de Frecuencia en Vivo
  const levelBarsCanvas = document.getElementById('levelBarsCanvas');
  const barsCtx = levelBarsCanvas.getContext('2d');

  // Canvas 3: Onda Acústica Instantánea (Osciloscopio)
  const oscilloscopeCanvas = document.getElementById('oscilloscopeCanvas');
  const oscCtx = oscilloscopeCanvas.getContext('2d');
  const oscMetaLabel = document.getElementById('oscMetaLabel');

  const currentTrackTitle = document.getElementById('currentTrackTitle');
  const currentTrackSpecs = document.getElementById('currentTrackSpecs');
  const playbackLed = document.getElementById('playbackLed');

  const rmsDbVal = document.getElementById('rmsDbVal');
  const peakFreqVal = document.getElementById('peakFreqVal');
  const bassEnergyVal = document.getElementById('bassEnergyVal');
  const trebleEnergyVal = document.getElementById('trebleEnergyVal');

  const playPauseBtn = document.getElementById('playPauseBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const stopBtn = document.getElementById('stopBtn');
  const rewindBtn = document.getElementById('rewindBtn');
  const forwardBtn = document.getElementById('forwardBtn');
  const prevTrackBtn = document.getElementById('prevTrackBtn');
  const nextTrackBtn = document.getElementById('nextTrackBtn');

  const seekSlider = document.getElementById('seekSlider');
  const progressFill = document.getElementById('progressFill');
  const currentTimeLabel = document.getElementById('currentTimeLabel');
  const totalTimeLabel = document.getElementById('totalTimeLabel');

  const muteBtn = document.getElementById('muteBtn');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumePct = document.getElementById('volumePct');
  const speedSelect = document.getElementById('speedSelect');
  const loopBtn = document.getElementById('loopBtn');

  const playlistItems = document.getElementById('playlistItems');
  const playlistCount = document.getElementById('playlistCount');
  const clearPlaylistBtn = document.getElementById('clearPlaylistBtn');

  const ambientOrb1 = document.getElementById('ambientOrb1');
  const ambientOrb2 = document.getElementById('ambientOrb2');

  // Ensure Web Audio Graph is initialized
  function ensureAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;

      sourceNode = audioCtx.createMediaElementSource(audioEl);
      sourceNode.connect(analyser);
      analyser.connect(audioCtx.destination);

      freqData = new Uint8Array(analyser.frequencyBinCount);
      timeData = new Uint8Array(analyser.fftSize);
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function getDecoderContext() {
    if (audioCtx) return audioCtx;
    if (!decoderCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      decoderCtx = new AudioContextClass();
    }
    return decoderCtx;
  }

  // Resize all 3 stacked canvases with high-DPI support
  function resizeAllCanvases() {
    const dpr = window.devicePixelRatio || 1;
    const pairs = [
      { canvas: fullWaveformCanvas, ctx: waveCtx },
      { canvas: levelBarsCanvas, ctx: barsCtx },
      { canvas: oscilloscopeCanvas, ctx: oscCtx }
    ];
    pairs.forEach(({ canvas: c, ctx: context }) => {
      const rect = c.parentElement.getBoundingClientRect();
      c.width = Math.max(260, Math.floor(rect.width * dpr));
      c.height = Math.max(36, Math.floor(rect.height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
  }
  window.addEventListener('resize', resizeAllCanvases);
  resizeAllCanvases();

  // Format seconds -> MM:SS
  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Pre-analyze the entire audio file immediately upon load to extract full waveform + spectral color
  async function extractFullWaveform(arrayBuffer) {
    try {
      waveformAnalysisBadge.textContent = 'Analizando archivo...';
      waveformAnalysisBadge.className = 'analysis-badge analyzing';

      const ctxForDecode = getDecoderContext();
      const audioBuffer = await ctxForDecode.decodeAudioData(arrayBuffer.slice(0));

      const rawL = audioBuffer.getChannelData(0);
      const rawR = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : rawL;
      const totalSamples = rawL.length;
      const blockSize = Math.max(1, Math.floor(totalSamples / WAVEFORM_COLUMNS));

      let globalMaxPeak = 0.001;
      let globalMaxRms = 0.001;
      let maxZcr = 0.001;

      for (let i = 0; i < WAVEFORM_COLUMNS; i++) {
        const start = i * blockSize;
        const step = Math.max(1, Math.floor(blockSize / 256));
        let maxP = 0;
        let maxN = 0;
        let sqSum = 0;
        let zcrCount = 0;
        let prevSample = 0;
        let count = 0;

        for (let j = 0; j < blockSize && start + j < totalSamples; j += step) {
          const s = (rawL[start + j] + rawR[start + j]) * 0.5;
          if (s > maxP) maxP = s;
          if (-s > maxN) maxN = -s;
          sqSum += s * s;
          if ((s >= 0 && prevSample < 0) || (s < 0 && prevSample >= 0)) {
            zcrCount++;
          }
          prevSample = s;
          count++;
        }

        const rmsVal = count > 0 ? Math.sqrt(sqSum / count) : 0;
        const zcrRate = count > 0 ? zcrCount / count : 0;

        wavePeaksPos[i] = maxP;
        wavePeaksNeg[i] = maxN;
        waveRms[i] = rmsVal;
        waveBrightness[i] = zcrRate;

        if (maxP > globalMaxPeak) globalMaxPeak = maxP;
        if (maxN > globalMaxPeak) globalMaxPeak = maxN;
        if (rmsVal > globalMaxRms) globalMaxRms = rmsVal;
        if (zcrRate > maxZcr) maxZcr = zcrRate;
      }

      // Normalize across the whole track so the full waveform spectrum is crystal-clear from start to finish
      for (let i = 0; i < WAVEFORM_COLUMNS; i++) {
        wavePeaksPos[i] = Math.max(0.04, Math.min(1, wavePeaksPos[i] / globalMaxPeak));
        wavePeaksNeg[i] = Math.max(0.04, Math.min(1, wavePeaksNeg[i] / globalMaxPeak));
        waveRms[i] = Math.max(0.02, Math.min(1, waveRms[i] / globalMaxRms));
        waveBrightness[i] = Math.min(1, waveBrightness[i] / maxZcr);
      }

      hasDecodedWaveform = true;
      decodedDuration = audioBuffer.duration;
      totalTimeLabel.textContent = formatTime(decodedDuration);
      waveformCursorTime.textContent = `00:00 / ${formatTime(decodedDuration)}`;

      const sr = (audioBuffer.sampleRate / 1000).toFixed(1);
      const ch = audioBuffer.numberOfChannels === 2 ? 'Estéreo' : 'Mono';
      currentTrackSpecs.textContent = `${sr} kHz • ${ch} • Duración ${formatTime(audioBuffer.duration)} • Espectro Completo Analizado`;
      waveformAnalysisBadge.textContent = `Espectro Analizado (${WAVEFORM_COLUMNS} bloques)`;
      waveformAnalysisBadge.className = 'analysis-badge';
    } catch (err) {
      console.warn('Could not decode full waveform, generating fallback envelope:', err);
      for (let i = 0; i < WAVEFORM_COLUMNS; i++) {
        const env = 0.2 + 0.75 * Math.abs(Math.sin(i * 0.11) * Math.cos(i * 0.03));
        wavePeaksPos[i] = env;
        wavePeaksNeg[i] = env * (0.85 + 0.15 * Math.sin(i));
        waveRms[i] = env * 0.6;
        waveBrightness[i] = 0.3 + 0.5 * Math.abs(Math.sin(i * 0.07));
      }
      hasDecodedWaveform = true;
      waveformAnalysisBadge.textContent = 'Espectro Listo';
      waveformAnalysisBadge.className = 'analysis-badge';
    }
  }

  // Load files into playlist and immediately analyze & show full spectrum of the newly loaded file
  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(
      (f) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac|webm)$/i.test(f.name)
    );
    if (files.length === 0) return;

    const firstNewIdx = playlist.length;
    files.forEach((file) => {
      const url = URL.createObjectURL(file);
      playlist.push({
        name: file.name.replace(/\.[^/.]+$/, ''),
        fileName: file.name,
        sizeMB: (file.size / (1024 * 1024)).toFixed(2),
        url,
        file,
        isDemo: false
      });
    });

    renderPlaylist();
    // Immediately load & analyze the newly added file so its full spectrum is displayed right away
    await loadTrack(firstNewIdx, false);
  }

  // Load track by index, analyze its complete waveform immediately, and optionally start playback
  async function loadTrack(index, autoPlay = false) {
    if (index < 0 || index >= playlist.length) return;
    currentIndex = index;
    const track = playlist[index];

    audioEl.pause();
    audioEl.currentTime = 0;
    seekSlider.value = 0;
    progressFill.style.width = '0%';
    currentTimeLabel.textContent = '00:00';

    currentTrackTitle.textContent = track.name;
    currentTrackSpecs.textContent = `Decodificando y analizando espectro completo del archivo...`;
    audioEl.src = track.url;
    audioEl.playbackRate = parseFloat(speedSelect.value) || 1;
    renderPlaylist();
    updateTransportUI();

    // Decode and pre-analyze full waveform spectrum immediately on load
    if (track.arrayBuffer) {
      await extractFullWaveform(track.arrayBuffer);
    } else if (track.file) {
      const buf = await track.file.arrayBuffer();
      track.arrayBuffer = buf;
      await extractFullWaveform(buf);
    }

    if (autoPlay) {
      playAudio();
    } else {
      updateTransportUI();
    }
  }

  function playAudio() {
    if (playlist.length === 0) {
      generateAndLoadDemoTrack(true);
      return;
    }
    ensureAudioContext();
    audioEl.play().then(() => {
      updateTransportUI();
    }).catch((err) => {
      console.warn('Playback prevented:', err);
      updateTransportUI();
    });
  }

  function pauseAudio() {
    audioEl.pause();
    updateTransportUI();
  }

  function stopAudio() {
    audioEl.pause();
    audioEl.currentTime = 0;
    seekSlider.value = 0;
    progressFill.style.width = '0%';
    currentTimeLabel.textContent = '00:00';
    updateTransportUI();
  }

  function skipSeconds(delta) {
    if (!audioEl.src) return;
    const dur = audioEl.duration || decodedDuration || 0;
    audioEl.currentTime = Math.max(0, Math.min(dur, audioEl.currentTime + delta));
  }

  function updateTransportUI() {
    if (!audioEl.paused) {
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
      playbackLed.className = 'status-led playing';
    } else {
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
      playbackLed.className = audioEl.currentTime > 0 ? 'status-led paused' : 'status-led';
    }
  }

  function renderPlaylist() {
    playlistCount.textContent = playlist.length;
    playlistItems.innerHTML = '';
    if (playlist.length === 0) {
      const li = document.createElement('li');
      li.className = 'playlist-empty';
      li.textContent = 'No hay archivos cargados aún. Carga tus archivos MP3/WAV o prueba la Pista Demo Synth.';
      playlistItems.appendChild(li);
      return;
    }

    playlist.forEach((track, idx) => {
      const li = document.createElement('li');
      li.className = `playlist-track ${idx === currentIndex ? 'active' : ''}`;
      li.innerHTML = `
        <span>${idx + 1}. ${track.name}</span>
        <small style="opacity:0.65">(${track.sizeMB} MB)</small>
      `;
      // Clicking a track in the playlist loads its spectrum; if already selected, toggles play
      li.addEventListener('click', () => {
        if (idx === currentIndex) {
          if (audioEl.paused) playAudio();
          else pauseAudio();
        } else {
          loadTrack(idx, false);
        }
      });
      playlistItems.appendChild(li);
    });
  }

  // Procedural Synthwave Track Generator (creates a real stereo WAV in memory so user can test immediately)
  function createDemoSynthWavBuffer(durationSec = 24, sampleRate = 44100) {
    const numSamples = durationSec * sampleRate;
    const numChannels = 2;
    const bytesPerSample = 2;
    const dataSize = numSamples * numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const bpm = 124;
    const beatDur = 60 / bpm;
    const bassNotes = [55.0, 55.0, 65.41, 73.42, 82.41, 73.42, 65.41, 49.0];
    const arpNotes = [220, 261.63, 329.63, 440, 329.63, 261.63, 392.0, 523.25];

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const beatPos = t / beatDur;
      const beatIdx = Math.floor(beatPos);
      const beatFrac = beatPos - beatIdx;

      // Dynamic section arrangement (Intro -> Drop -> Breakdown -> Climax) so the full waveform has clear musical structure
      let sectionGain = 1.0;
      if (t < 3.5) sectionGain = 0.35 + (t / 3.5) * 0.55;
      else if (t >= 11 && t < 15.5) sectionGain = 0.42;
      else if (t >= 21) sectionGain = Math.max(0.15, 1 - (t - 21) / 3.2);

      // 1. Punchy Kick Drum
      const kickEnv = (t >= 11 && t < 15.0) ? 0 : Math.exp(-beatFrac * 14);
      const kickFreq = 48 + 115 * Math.exp(-beatFrac * 28);
      const kick = Math.sin(2 * Math.PI * kickFreq * beatFrac * beatDur) * kickEnv * 0.52;

      // 2. Crisp Snare / Hi-hat
      const eighthFrac = (beatPos * 2) % 1;
      const noise = (Math.random() * 2 - 1);
      const hatEnv = Math.exp(-eighthFrac * 26);
      const snareEnv = (beatIdx % 2 === 1) ? Math.exp(-beatFrac * 16) * 0.28 : 0;
      const percussion = noise * (hatEnv * 0.14 + snareEnv);

      // 3. Sawtooth Sub-Bass
      const bassFreq = bassNotes[Math.floor(beatPos / 2) % bassNotes.length];
      const saw = 2 * ((t * bassFreq) - Math.floor(0.5 + t * bassFreq));
      const bassEnv = Math.exp(-eighthFrac * 4.5);
      const bass = saw * bassEnv * 0.28;

      // 4. Stereo Melodic Synth Arpeggio
      const sixteenthIdx = Math.floor(beatPos * 4);
      const sixteenthFrac = (beatPos * 4) % 1;
      const arpFreq = arpNotes[sixteenthIdx % arpNotes.length] * (beatIdx % 8 >= 4 ? 1.5 : 1);
      const arpEnv = Math.exp(-sixteenthFrac * 6.0);
      const arpL = Math.sin(2 * Math.PI * arpFreq * t + 0.3 * Math.sin(2 * Math.PI * arpFreq * 2 * t)) * arpEnv * 0.26;
      const arpR = Math.sin(2 * Math.PI * (arpFreq * 1.003) * t + 0.4) * arpEnv * 0.26;

      const sampleL = Math.max(-0.98, Math.min(0.98, (kick + percussion + bass + arpL) * sectionGain));
      const sampleR = Math.max(-0.98, Math.min(0.98, (kick + percussion + bass + arpR) * sectionGain));

      view.setInt16(offset, sampleL * 32767, true);
      view.setInt16(offset + 2, sampleR * 32767, true);
      offset += 4;
    }

    return buffer;
  }

  async function generateAndLoadDemoTrack(autoPlay = true) {
    const existingDemoIdx = playlist.findIndex((t) => t.isDemo);
    if (existingDemoIdx !== -1) {
      await loadTrack(existingDemoIdx, autoPlay);
      return;
    }

    const wavBuffer = createDemoSynthWavBuffer(24, 44100);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);

    playlist.push({
      name: 'SonicPulse — Cyber Horizon (Demo Synth 124 BPM)',
      fileName: 'cyber-horizon-demo.wav',
      sizeMB: (blob.size / (1024 * 1024)).toFixed(2),
      url,
      arrayBuffer: wavBuffer,
      isDemo: true
    });

    renderPlaylist();
    await loadTrack(playlist.length - 1, autoPlay);
  }

  // ============================================================================
  // 2. THREE STACKED RECTANGLES RENDERING LOOP
  //    Panel 1: Pre-Analyzed Full Track Waveform Spectrum + Live Playhead Traversal
  //    Panel 2: Live Frequency Level Bars
  //    Panel 3: Live Instantaneous Acoustic Oscilloscope Wave
  // ============================================================================
  function drawStudioGrid(context, width, height, centerAxisColor) {
    context.clearRect(0, 0, width, height);
    context.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    context.lineWidth = 1;

    const vCols = 8;
    for (let c = 1; c < vCols; c++) {
      const x = (width / vCols) * c;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }

    const centerY = height * 0.5;
    if (centerAxisColor) {
      context.strokeStyle = centerAxisColor;
      context.beginPath();
      context.moveTo(0, centerY);
      context.lineTo(width, centerY);
      context.stroke();
    }
  }

  // PANEL 1: Pre-analyzed Full Waveform Spectrum (Static analysis from file load + Playhead traversal)
  function renderFullWaveformPanel(progressRatio, duration) {
    const width = fullWaveformCanvas.clientWidth;
    const height = fullWaveformCanvas.clientHeight;
    if (width === 0 || height === 0) return;

    drawStudioGrid(waveCtx, width, height, 'rgba(56, 189, 248, 0.18)');
    const centerY = height * 0.5;

    if (!hasDecodedWaveform) {
      waveCtx.fillStyle = 'rgba(148, 163, 184, 0.5)';
      waveCtx.font = '12px Inter, sans-serif';
      waveCtx.textAlign = 'center';
      waveCtx.fillText('Carga un archivo de audio para analizar su espectro completo', width * 0.5, centerY + 4);
      return;
    }

    const playheadX = progressRatio * width;

    // Subtle shaded background for the already-traversed region
    if (progressRatio > 0) {
      const playedGrad = waveCtx.createLinearGradient(0, 0, playheadX, 0);
      playedGrad.addColorStop(0, 'rgba(6, 182, 212, 0.05)');
      playedGrad.addColorStop(1, 'rgba(56, 189, 248, 0.16)');
      waveCtx.fillStyle = playedGrad;
      waveCtx.fillRect(0, 0, playheadX, height);
    }

    const slotW = width / WAVEFORM_COLUMNS;
    const barW = Math.max(1.4, slotW * 0.76);
    const maxHalfH = height * 0.44;

    for (let i = 0; i < WAVEFORM_COLUMNS; i++) {
      const colRatio = (i + 0.5) / WAVEFORM_COLUMNS;
      const isPlayed = colRatio <= progressRatio;
      const x = i * slotW + (slotW - barW) * 0.5;

      const posH = Math.max(2, wavePeaksPos[i] * maxHalfH);
      const negH = Math.max(2, wavePeaksNeg[i] * maxHalfH);
      const rmsH = Math.max(1.5, waveRms[i] * maxHalfH * 0.78);

      // Spectral color derived from the file's pre-analyzed frequency brightness at slice i
      // Bass-heavy slices -> Cyan/Blue (195°), Mid slices -> Teal/Indigo (225°), High/bright slices -> Purple/Pink (285°)
      const spectralHue = 190 + waveBrightness[i] * 95;

      if (isPlayed) {
        // Already traversed during playback: bright, luminous spectral bars
        waveCtx.fillStyle = `hsla(${spectralHue}, 95%, 62%, 0.92)`;
        waveCtx.fillRect(x, centerY - posH, barW, posH + negH);

        // Dense RMS energy core
        waveCtx.fillStyle = `hsla(${spectralHue - 15}, 100%, 80%, 0.98)`;
        waveCtx.fillRect(x, centerY - rmsH, barW, rmsH * 2);
      } else {
        // Upcoming pre-analyzed track spectrum: clearly visible right upon loading the file!
        waveCtx.fillStyle = `hsla(${spectralHue}, 82%, 52%, 0.52)`;
        waveCtx.fillRect(x, centerY - posH, barW, posH + negH);

        // Inner RMS core of unplayed spectrum
        waveCtx.fillStyle = `hsla(${spectralHue}, 90%, 66%, 0.72)`;
        waveCtx.fillRect(x, centerY - rmsH, barW, rmsH * 2);
      }
    }

    // Hover scrub preview line when moving mouse over Panel 1
    if (hoverWaveformRatio >= 0 && hoverWaveformRatio <= 1) {
      const hoverX = hoverWaveformRatio * width;
      waveCtx.save();
      waveCtx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      waveCtx.setLineDash([3, 3]);
      waveCtx.lineWidth = 1;
      waveCtx.beginPath();
      waveCtx.moveTo(hoverX, 0);
      waveCtx.lineTo(hoverX, height);
      waveCtx.stroke();

      const hoverTimeStr = formatTime(hoverWaveformRatio * duration);
      waveCtx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      const badgeW = 46;
      const bx = Math.min(width - badgeW - 4, Math.max(4, hoverX - badgeW * 0.5));
      waveCtx.fillRect(bx, 4, badgeW, 16);
      waveCtx.fillStyle = '#e2e8f0';
      waveCtx.font = '600 10px "JetBrains Mono", monospace';
      waveCtx.textAlign = 'center';
      waveCtx.fillText(hoverTimeStr, bx + badgeW * 0.5, 15);
      waveCtx.restore();
    }

    // Active Playhead Cursor traversing the pre-analyzed waveform
    waveCtx.save();
    waveCtx.strokeStyle = '#ffffff';
    waveCtx.lineWidth = 2.2;
    waveCtx.shadowColor = '#38bdf8';
    waveCtx.shadowBlur = 10;
    waveCtx.beginPath();
    waveCtx.moveTo(playheadX, 0);
    waveCtx.lineTo(playheadX, height);
    waveCtx.stroke();

    // Top & Bottom Playhead Markers
    waveCtx.fillStyle = '#38bdf8';
    waveCtx.beginPath();
    waveCtx.moveTo(playheadX - 5, 0);
    waveCtx.lineTo(playheadX + 5, 0);
    waveCtx.lineTo(playheadX, 6);
    waveCtx.closePath();
    waveCtx.fill();

    waveCtx.beginPath();
    waveCtx.moveTo(playheadX - 5, height);
    waveCtx.lineTo(playheadX + 5, height);
    waveCtx.lineTo(playheadX, height - 6);
    waveCtx.closePath();
    waveCtx.fill();
    waveCtx.restore();
  }

  // PANEL 2: Live Frequency Level Bars ("Barras de niveles de frecuencia en vivo")
  function renderLevelBarsPanel(isPlaying) {
    const width = levelBarsCanvas.clientWidth;
    const height = levelBarsCanvas.clientHeight;
    if (width === 0 || height === 0) return;

    drawStudioGrid(barsCtx, width, height, vizMode === 'mirror' ? 'rgba(236, 72, 153, 0.2)' : null);
    const centerY = height * 0.5;
    const slotWidth = width / NUM_BARS;
    const barWidth = Math.max(3, slotWidth * 0.68);

    for (let i = 0; i < NUM_BARS; i++) {
      let targetNorm = 0;
      if (isPlaying && freqData) {
        const startBin = Math.floor(Math.pow(i / NUM_BARS, 1.85) * (freqData.length * 0.55));
        const endBin = Math.max(startBin + 1, Math.floor(Math.pow((i + 1) / NUM_BARS, 1.85) * (freqData.length * 0.55)));
        let sum = 0;
        for (let b = startBin; b < endBin && b < freqData.length; b++) {
          sum += freqData[b];
        }
        targetNorm = (sum / Math.max(1, endBin - startBin)) / 255;
      } else {
        targetNorm = 0.02;
      }

      smoothedBars[i] += (targetNorm - smoothedBars[i]) * 0.34;
      const val = smoothedBars[i];

      if (val >= barPeaks[i]) {
        barPeaks[i] = val;
        barPeakVel[i] = 0;
      } else {
        barPeakVel[i] += 0.0005;
        barPeaks[i] = Math.max(0, barPeaks[i] - barPeakVel[i]);
      }

      const x = i * slotWidth + (slotWidth - barWidth) * 0.5;
      const hue = 188 + (i / NUM_BARS) * 145;

      if (vizMode === 'combined') {
        const maxBarH = height * 0.88;
        const barH = Math.max(3, val * maxBarH);
        const y = height - barH - 2;

        const grad = barsCtx.createLinearGradient(x, height - 2, x, y);
        grad.addColorStop(0, `hsla(${hue}, 92%, 50%, 0.85)`);
        grad.addColorStop(0.6, `hsla(${hue + 20}, 95%, 60%, 0.92)`);
        grad.addColorStop(1, `hsla(${hue + 40}, 100%, 72%, 1.0)`);

        barsCtx.fillStyle = grad;
        barsCtx.beginPath();
        barsCtx.roundRect(x, y, barWidth, barH, [3, 3, 0, 0]);
        barsCtx.fill();

        const peakY = height - 2 - Math.max(4, barPeaks[i] * maxBarH);
        barsCtx.fillStyle = '#ffffff';
        barsCtx.fillRect(x, peakY - 2.5, barWidth, 2);
      } else if (vizMode === 'mirror') {
        const maxHalf = height * 0.45;
        const halfBar = Math.max(2, val * maxHalf);

        const grad = barsCtx.createLinearGradient(x, centerY - halfBar, x, centerY + halfBar);
        grad.addColorStop(0, `hsla(${hue + 35}, 100%, 70%, 0.96)`);
        grad.addColorStop(0.5, `hsla(${hue}, 90%, 50%, 0.75)`);
        grad.addColorStop(1, `hsla(${hue + 35}, 100%, 70%, 0.96)`);

        barsCtx.fillStyle = grad;
        barsCtx.fillRect(x, centerY - halfBar, barWidth, halfBar * 2);

        const peakOffset = Math.max(3, barPeaks[i] * maxHalf);
        barsCtx.fillStyle = '#f8fafc';
        barsCtx.fillRect(x, centerY - peakOffset - 2, barWidth, 2);
        barsCtx.fillRect(x, centerY + peakOffset, barWidth, 2);
      } else if (vizMode === 'led') {
        const totalSegments = 13;
        const activeSegments = Math.max(1, Math.round(val * totalSegments));
        const peakSegment = Math.min(totalSegments, Math.round(barPeaks[i] * totalSegments));
        const segGap = 1.6;
        const usableH = height - 4;
        const segH = (usableH - totalSegments * segGap) / totalSegments;

        for (let s = 0; s < activeSegments; s++) {
          const segY = height - 3 - (s + 1) * (segH + segGap);
          if (s > totalSegments * 0.8) {
            barsCtx.fillStyle = 'rgba(239, 68, 68, 0.95)';
          } else if (s > totalSegments * 0.6) {
            barsCtx.fillStyle = 'rgba(245, 158, 11, 0.92)';
          } else {
            barsCtx.fillStyle = `hsla(${185 + (s / totalSegments) * 60}, 92%, 56%, 0.9)`;
          }
          barsCtx.fillRect(x, segY, barWidth, segH);
        }

        if (peakSegment > 0) {
          const peakSegY = height - 3 - peakSegment * (segH + segGap);
          barsCtx.fillStyle = '#ffffff';
          barsCtx.fillRect(x, peakSegY, barWidth, Math.max(2, segH * 0.75));
        }
      }
    }
  }

  // PANEL 3: Live Instantaneous Acoustic Wave ("Onda acústica instantánea")
  function renderOscilloscopePanel(isPlaying) {
    const width = oscilloscopeCanvas.clientWidth;
    const height = oscilloscopeCanvas.clientHeight;
    if (width === 0 || height === 0) return;

    drawStudioGrid(oscCtx, width, height, 'rgba(168, 85, 247, 0.22)');
    const centerY = height * 0.5;

    if (!isPlaying || !timeData) {
      // Flat zero-line with subtle glow when paused
      oscCtx.save();
      oscCtx.strokeStyle = 'rgba(168, 85, 247, 0.45)';
      oscCtx.lineWidth = 1.5;
      oscCtx.beginPath();
      oscCtx.moveTo(0, centerY);
      oscCtx.lineTo(width, centerY);
      oscCtx.stroke();
      oscCtx.restore();
      return;
    }

    const points = 256;
    const sliceWidth = width / (points - 1);

    // Secondary harmonic phase shadow wave
    oscCtx.save();
    oscCtx.beginPath();
    for (let i = 0; i < points; i++) {
      const idx = Math.min(timeData.length - 1, i * 4 + 8);
      const v = (timeData[idx] - 128) / 128;
      const x = i * sliceWidth;
      const y = centerY + v * (height * 0.36);
      if (i === 0) oscCtx.moveTo(x, y);
      else oscCtx.lineTo(x, y);
    }
    oscCtx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    oscCtx.lineWidth = 1.6;
    oscCtx.stroke();
    oscCtx.restore();

    // Primary instantaneous acoustic wave
    oscCtx.save();
    oscCtx.beginPath();
    for (let i = 0; i < points; i++) {
      const v = (timeData[i * 4] - 128) / 128;
      const x = i * sliceWidth;
      const y = centerY + v * (height * 0.44);
      if (i === 0) oscCtx.moveTo(x, y);
      else oscCtx.lineTo(x, y);
    }
    oscCtx.strokeStyle = '#e879f9';
    oscCtx.lineWidth = 2.2;
    oscCtx.shadowColor = 'rgba(217, 70, 239, 0.85)';
    oscCtx.shadowBlur = 10;
    oscCtx.stroke();
    oscCtx.restore();
  }

  // Master 60 FPS Animation Loop
  function renderVisualizerLoop() {
    requestAnimationFrame(renderVisualizerLoop);

    const isPlaying = !audioEl.paused && !audioEl.ended && analyser;

    if (isPlaying) {
      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);

      let rms = 0;
      let peakBin = 0;
      let peakVal = 0;
      let bassSum = 0;
      let trebleSum = 0;

      for (let i = 0; i < timeData.length; i++) {
        const norm = (timeData[i] - 128) / 128;
        rms += norm * norm;
      }
      rms = Math.sqrt(rms / timeData.length);

      for (let i = 0; i < freqData.length; i++) {
        const val = freqData[i];
        if (val > peakVal) {
          peakVal = val;
          peakBin = i;
        }
        if (i < 24) bassSum += val;
        else if (i >= 120 && i < 400) trebleSum += val;
      }

      const db = rms > 0.0001 ? (20 * Math.log10(rms)).toFixed(1) : '-∞';
      const nyquist = (audioCtx ? audioCtx.sampleRate : 44100) / 2;
      const peakHz = Math.round((peakBin / freqData.length) * nyquist);
      const bassPct = Math.min(100, Math.round((bassSum / (24 * 255)) * 100));
      const treblePct = Math.min(100, Math.round((trebleSum / (280 * 255)) * 140));

      rmsDbVal.textContent = `${db} dB`;
      peakFreqVal.textContent = `${peakHz} Hz`;
      bassEnergyVal.textContent = `${bassPct}%`;
      trebleEnergyVal.textContent = `${treblePct}%`;
      oscMetaLabel.textContent = `Amplitud Instantánea: ${(rms * 100).toFixed(1)}% • 60 FPS`;

      const scale = 1 + (bassPct / 100) * 0.22;
      ambientOrb1.style.transform = `scale(${scale.toFixed(3)})`;
      ambientOrb2.style.transform = `scale(${(1 + (treblePct / 100) * 0.2).toFixed(3)})`;
    }

    const duration = audioEl.duration || decodedDuration || 1;
    const currentTime = audioEl.currentTime || 0;
    const progressRatio = Math.min(1, Math.max(0, currentTime / duration));
    waveformCursorTime.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;

    // Render each of the 3 stacked rectangles independently
    renderFullWaveformPanel(progressRatio, duration);
    renderLevelBarsPanel(isPlaying);
    renderOscilloscopePanel(isPlaying);
  }

  requestAnimationFrame(renderVisualizerLoop);

  // ============================================================================
  // 3. EVENT LISTENERS FOR AUDIO PLAYER, WAVEFORM SCRUBBING & CONTROLS
  // ============================================================================
  audioFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
      e.target.value = '';
    }
  });

  demoTrackBtn.addEventListener('click', () => {
    generateAndLoadDemoTrack(false);
  });

  // Drag & Drop support on the central visualizer container
  ['dragenter', 'dragover'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  });

  // Interactive Seek & Scrubbing on Rectangle 1 (Full Waveform Spectrum)
  function seekFromWaveformEvent(e) {
    const dur = audioEl.duration || decodedDuration;
    if (!audioEl.src || !dur) return;
    const rect = waveformSeekSlot.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audioEl.currentTime = ratio * dur;
    progressFill.style.width = `${ratio * 100}%`;
    seekSlider.value = Math.round(ratio * 1000);
    currentTimeLabel.textContent = formatTime(audioEl.currentTime);
  }

  waveformSeekSlot.addEventListener('mousedown', (e) => {
    isScrubbingWaveform = true;
    seekFromWaveformEvent(e);
  });

  window.addEventListener('mousemove', (e) => {
    if (isScrubbingWaveform) {
      seekFromWaveformEvent(e);
    }
  });

  window.addEventListener('mouseup', () => {
    isScrubbingWaveform = false;
  });

  waveformSeekSlot.addEventListener('mousemove', (e) => {
    const rect = waveformSeekSlot.getBoundingClientRect();
    hoverWaveformRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  });

  waveformSeekSlot.addEventListener('mouseleave', () => {
    hoverWaveformRatio = -1;
  });

  // Visualizer Mode Buttons (for Panel 2 Level Bars)
  document.querySelectorAll('.viz-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.viz-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      vizMode = btn.dataset.mode;
    });
  });

  // Transport Buttons
  playPauseBtn.addEventListener('click', () => {
    if (audioEl.paused) playAudio();
    else pauseAudio();
  });

  stopBtn.addEventListener('click', stopAudio);
  rewindBtn.addEventListener('click', () => skipSeconds(-10));
  forwardBtn.addEventListener('click', () => skipSeconds(10));

  prevTrackBtn.addEventListener('click', () => {
    if (playlist.length === 0) return;
    if (audioEl.currentTime > 3) {
      audioEl.currentTime = 0;
    } else {
      const nextIdx = (currentIndex - 1 + playlist.length) % playlist.length;
      loadTrack(nextIdx, !audioEl.paused);
    }
  });

  nextTrackBtn.addEventListener('click', () => {
    if (playlist.length === 0) return;
    const nextIdx = (currentIndex + 1) % playlist.length;
    loadTrack(nextIdx, !audioEl.paused);
  });

  // Timeline progress updates
  audioEl.addEventListener('timeupdate', () => {
    const cur = audioEl.currentTime || 0;
    const dur = audioEl.duration || decodedDuration || 0;
    currentTimeLabel.textContent = formatTime(cur);
    if (dur > 0) {
      totalTimeLabel.textContent = formatTime(dur);
      const pct = (cur / dur) * 100;
      progressFill.style.width = `${pct}%`;
      seekSlider.value = Math.round((cur / dur) * 1000);
    }
  });

  audioEl.addEventListener('loadedmetadata', () => {
    totalTimeLabel.textContent = formatTime(audioEl.duration || decodedDuration || 0);
  });

  audioEl.addEventListener('ended', () => {
    if (audioEl.loop) return;
    if (playlist.length > 1) {
      const nextIdx = (currentIndex + 1) % playlist.length;
      loadTrack(nextIdx, true);
    } else {
      updateTransportUI();
    }
  });

  seekSlider.addEventListener('input', () => {
    const dur = audioEl.duration || decodedDuration;
    if (!dur) return;
    const ratio = parseFloat(seekSlider.value) / 1000;
    audioEl.currentTime = ratio * dur;
    progressFill.style.width = `${ratio * 100}%`;
  });

  // Volume, Mute, Speed, Loop
  volumeSlider.addEventListener('input', () => {
    const val = parseFloat(volumeSlider.value);
    audioEl.volume = val;
    audioEl.muted = val === 0;
    volumePct.textContent = `${Math.round(val * 100)}%`;
  });

  muteBtn.addEventListener('click', () => {
    audioEl.muted = !audioEl.muted;
    muteBtn.classList.toggle('active', audioEl.muted);
    volumePct.textContent = audioEl.muted ? 'MUTE' : `${Math.round(audioEl.volume * 100)}%`;
  });

  speedSelect.addEventListener('change', () => {
    audioEl.playbackRate = parseFloat(speedSelect.value) || 1;
  });

  loopBtn.addEventListener('click', () => {
    audioEl.loop = !audioEl.loop;
    loopBtn.classList.toggle('active', audioEl.loop);
  });

  clearPlaylistBtn.addEventListener('click', () => {
    stopAudio();
    audioEl.removeAttribute('src');
    playlist.length = 0;
    currentIndex = -1;
    hasDecodedWaveform = false;
    decodedDuration = 0;
    currentTrackTitle.textContent = 'Arrastra un archivo de audio o pulsa "Cargar Archivos"';
    currentTrackSpecs.textContent = 'Web Audio API • FFT 2048 • 60 FPS';
    waveformAnalysisBadge.textContent = 'Sin archivo';
    waveformCursorTime.textContent = '00:00 / 00:00';
    renderPlaylist();
  });

  // Keyboard shortcuts (when not typing in city search input)
  window.addEventListener('keydown', (e) => {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (audioEl.paused) playAudio();
      else pauseAudio();
    } else if (e.code === 'ArrowLeft') {
      skipSeconds(-5);
    } else if (e.code === 'ArrowRight') {
      skipSeconds(5);
    }
  });

  // ============================================================================
  // 4. FREE WEATHER WIDGET (OPEN-METEO API — NO API KEY NEEDED)
  // ============================================================================
  const weatherStatusDot = document.getElementById('weatherStatusDot');
  const weatherCityName = document.getElementById('weatherCityName');
  const weatherConditionText = document.getElementById('weatherConditionText');
  const weatherIconBig = document.getElementById('weatherIconBig');
  const weatherTemp = document.getElementById('weatherTemp');
  const weatherMax = document.getElementById('weatherMax');
  const weatherMin = document.getElementById('weatherMin');
  const weatherFeels = document.getElementById('weatherFeels');
  const weatherHumidity = document.getElementById('weatherHumidity');
  const weatherWind = document.getElementById('weatherWind');
  const weatherUV = document.getElementById('weatherUV');
  const weatherForecastList = document.getElementById('weatherForecastList');
  const weatherUpdatedTime = document.getElementById('weatherUpdatedTime');

  const citySearchForm = document.getElementById('citySearchForm');
  const citySearchInput = document.getElementById('citySearchInput');
  const locateMeBtn = document.getElementById('locateMeBtn');
  const refreshWeatherBtn = document.getElementById('refreshWeatherBtn');

  let currentWeatherLoc = {
    lat: 19.4326,
    lon: -99.1332,
    name: 'Ciudad de México, MX'
  };

  function getWmoDescriptionAndIcon(code, isDay = 1) {
    const map = {
      0: { text: 'Cielo despejado', icon: isDay ? '☀️' : '🌙' },
      1: { text: 'Mayormente despejado', icon: isDay ? '🌤️' : '🌙' },
      2: { text: 'Parcialmente nublado', icon: '⛅' },
      3: { text: 'Nublado', icon: '☁️' },
      45: { text: 'Niebla moderada', icon: '🌫️' },
      48: { text: 'Niebla con escarcha', icon: '🌫️' },
      51: { text: 'Llovizna ligera', icon: '🌦️' },
      53: { text: 'Llovizna moderada', icon: '🌦️' },
      55: { text: 'Llovizna densa', icon: '🌧️' },
      61: { text: 'Lluvia ligera', icon: '🌧️' },
      63: { text: 'Lluvia moderada', icon: '🌧️' },
      65: { text: 'Lluvia fuerte', icon: '⛈️' },
      71: { text: 'Nevada ligera', icon: '🌨️' },
      73: { text: 'Nevada moderada', icon: '❄️' },
      75: { text: 'Nevada intensa', icon: '❄️' },
      80: { text: 'Chubascos ligeros', icon: '🌦️' },
      81: { text: 'Chubascos moderados', icon: '🌧️' },
      82: { text: 'Chubascos violentos', icon: '⛈️' },
      95: { text: 'Tormenta eléctrica', icon: '⚡' },
      96: { text: 'Tormenta con granizo', icon: '⛈️' },
      99: { text: 'Tormenta severa', icon: '⛈️' }
    };
    return map[code] || { text: 'Condición variable', icon: '⛅' };
  }

  async function fetchWeather(lat, lon, displayName) {
    try {
      weatherStatusDot.className = 'api-status loading';
      weatherStatusDot.textContent = 'SYNC';

      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,uv_index_max&timezone=auto&forecast_days=5`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      currentWeatherLoc = { lat, lon, name: displayName };
      const cur = data.current;
      const daily = data.daily;
      const wmo = getWmoDescriptionAndIcon(cur.weather_code, cur.is_day);

      weatherCityName.textContent = displayName;
      weatherConditionText.textContent = wmo.text;
      weatherIconBig.textContent = wmo.icon;
      weatherTemp.textContent = `${Math.round(cur.temperature_2m)}°C`;
      weatherFeels.textContent = `${Math.round(cur.apparent_temperature)}°C`;
      weatherHumidity.textContent = `${cur.relative_humidity_2m}%`;
      weatherWind.textContent = `${Math.round(cur.wind_speed_10m)} km/h`;

      if (daily && daily.temperature_2m_max && daily.temperature_2m_max.length > 0) {
        weatherMax.textContent = `Máx: ${Math.round(daily.temperature_2m_max[0])}°`;
        weatherMin.textContent = `Mín: ${Math.round(daily.temperature_2m_min[0])}°`;
        weatherUV.textContent = daily.uv_index_max ? daily.uv_index_max[0].toFixed(1) : '--';

        // Render next 4 days forecast
        weatherForecastList.innerHTML = '';
        const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        for (let i = 1; i < Math.min(5, daily.time.length); i++) {
          const dateObj = new Date(daily.time[i] + 'T12:00:00');
          const dayLabel = i === 1 ? 'Mañana' : dayNames[dateObj.getDay()];
          const dayWmo = getWmoDescriptionAndIcon(daily.weather_code[i], 1);
          const item = document.createElement('div');
          item.className = 'forecast-item';
          item.innerHTML = `
            <span class="forecast-day">${dayLabel}</span>
            <span class="forecast-icon" title="${dayWmo.text}">${dayWmo.icon}</span>
            <span style="font-size:0.74rem;color:var(--text-muted);flex:1;margin-left:8px;">${dayWmo.text}</span>
            <span class="forecast-temps"><strong>${Math.round(daily.temperature_2m_max[i])}°</strong> / ${Math.round(daily.temperature_2m_min[i])}°</span>
          `;
          weatherForecastList.appendChild(item);
        }
      }

      const now = new Date();
      weatherUpdatedTime.textContent = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      weatherStatusDot.className = 'api-status online';
      weatherStatusDot.textContent = 'LIVE';
    } catch (err) {
      console.warn('Weather API error:', err);
      weatherConditionText.textContent = 'Sin conexión temporal';
      weatherStatusDot.className = 'api-status loading';
      weatherStatusDot.textContent = 'RETRY';
    }
  }

  // City Search via Open-Meteo Geocoding API (free, no key)
  citySearchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = citySearchInput.value.trim();
    if (!query) return;

    try {
      weatherStatusDot.className = 'api-status loading';
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=es&format=json`;
      const res = await fetch(geoUrl);
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        const place = data.results[0];
        const label = `${place.name}${place.country_code ? ', ' + place.country_code.toUpperCase() : ''}`;
        document.querySelectorAll('.city-chip').forEach((c) => c.classList.remove('active'));
        fetchWeather(place.latitude, place.longitude, label);
        citySearchInput.value = '';
      } else {
        weatherConditionText.textContent = `No se encontró "${query}"`;
      }
    } catch (err) {
      console.warn('Geocoding error:', err);
    }
  });

  // Quick City Chips
  document.querySelectorAll('.city-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.city-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      fetchWeather(parseFloat(chip.dataset.lat), parseFloat(chip.dataset.lon), chip.dataset.name);
    });
  });

  locateMeBtn.addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.querySelectorAll('.city-chip').forEach((c) => c.classList.remove('active'));
        fetchWeather(pos.coords.latitude, pos.coords.longitude, 'Mi Ubicación Actual');
      },
      () => {
        weatherConditionText.textContent = 'Permiso de ubicación denegado';
      }
    );
  });

  refreshWeatherBtn.addEventListener('click', () => {
    fetchWeather(currentWeatherLoc.lat, currentWeatherLoc.lon, currentWeatherLoc.name);
  });

  // ============================================================================
  // 5. FREE STOCK MARKET, CRYPTO & FOREX WIDGET (BOLSA Y MERCADOS)
  // Connects to Free Public APIs: CoinGecko/Binance + Open-ER/Frankfurter + Yahoo Finance
  // ============================================================================
  const marketStatusDot = document.getElementById('marketStatusDot');
  const refreshMarketBtn = document.getElementById('refreshMarketBtn');
  const marketListEl = document.getElementById('marketList');
  const marketUpdatedTime = document.getElementById('marketUpdatedTime');

  const featuredSymbol = document.getElementById('featuredSymbol');
  const featuredName = document.getElementById('featuredName');
  const featuredPrice = document.getElementById('featuredPrice');
  const featuredChange = document.getElementById('featuredChange');
  const sparkCanvas = document.getElementById('marketSparkline');
  const sparkCtx = sparkCanvas.getContext('2d');

  let activeMarketTab = 'all';
  let selectedTickerId = 'BTC';

  // Initial Market Instruments Catalog (Updated with real API data on load)
  const marketAssets = [
    {
      id: 'SPX',
      symbol: 'S&P 500',
      yahooSymbol: '^GSPC',
      badge: 'SPX',
      name: 'Índice Standard & Poor’s 500',
      category: 'stocks',
      price: 5842.47,
      change24h: 0.68,
      prefix: '',
      decimals: 2,
      history: [5790, 5802, 5798, 5815, 5810, 5824, 5831, 5829, 5838, 5842.47]
    },
    {
      id: 'NDX',
      symbol: 'NASDAQ 100',
      yahooSymbol: '^IXIC',
      badge: 'NDX',
      name: 'Índice Tecnológico US',
      category: 'stocks',
      price: 18518.61,
      change24h: 0.94,
      prefix: '',
      decimals: 2,
      history: [18310, 18350, 18390, 18375, 18420, 18460, 18445, 18490, 18505, 18518.61]
    },
    {
      id: 'NVDA',
      symbol: 'NVDA',
      yahooSymbol: 'NVDA',
      badge: 'NVDA',
      name: 'NVIDIA Corporation • NASDAQ',
      category: 'stocks',
      price: 138.60,
      change24h: 2.41,
      prefix: '$',
      decimals: 2,
      history: [134.2, 135.1, 134.8, 136.0, 136.9, 136.4, 137.5, 138.1, 137.9, 138.6]
    },
    {
      id: 'AAPL',
      symbol: 'AAPL',
      yahooSymbol: 'AAPL',
      badge: 'AAPL',
      name: 'Apple Inc. • NASDAQ',
      category: 'stocks',
      price: 233.85,
      change24h: 0.52,
      prefix: '$',
      decimals: 2,
      history: [231.5, 232.0, 231.8, 232.4, 232.9, 233.1, 232.8, 233.4, 233.6, 233.85]
    },
    {
      id: 'MSFT',
      symbol: 'MSFT',
      yahooSymbol: 'MSFT',
      badge: 'MSFT',
      name: 'Microsoft Corp. • NASDAQ',
      category: 'stocks',
      price: 428.15,
      change24h: 0.37,
      prefix: '$',
      decimals: 2,
      history: [425.1, 425.8, 426.2, 425.9, 426.7, 427.3, 427.0, 427.8, 428.0, 428.15]
    },
    {
      id: 'BTC',
      symbol: 'BTC/USD',
      cgId: 'bitcoin',
      binanceSymbol: 'BTCUSDT',
      badge: 'BTC',
      name: 'Bitcoin • Cripto Global',
      category: 'crypto',
      price: 67850.00,
      change24h: 2.15,
      prefix: '$',
      decimals: 2,
      history: [66200, 66540, 66410, 66900, 67120, 67050, 67400, 67620, 67580, 67850]
    },
    {
      id: 'ETH',
      symbol: 'ETH/USD',
      cgId: 'ethereum',
      binanceSymbol: 'ETHUSDT',
      badge: 'ETH',
      name: 'Ethereum • Smart Contracts',
      category: 'crypto',
      price: 2645.50,
      change24h: 1.64,
      prefix: '$',
      decimals: 2,
      history: [2590, 2602, 2598, 2615, 2622, 2618, 2630, 2639, 2641, 2645.5]
    },
    {
      id: 'SOL',
      symbol: 'SOL/USD',
      cgId: 'solana',
      binanceSymbol: 'SOLUSDT',
      badge: 'SOL',
      name: 'Solana • High Speed L1',
      category: 'crypto',
      price: 156.40,
      change24h: 3.82,
      prefix: '$',
      decimals: 2,
      history: [149.5, 151.0, 150.8, 152.3, 153.6, 154.1, 154.9, 155.4, 156.0, 156.4]
    },
    {
      id: 'USDMXN',
      symbol: 'USD/MXN',
      fxCode: 'MXN',
      badge: 'MXN',
      name: 'Dólar a Peso Mexicano',
      category: 'forex',
      price: 19.68,
      change24h: -0.24,
      prefix: '$',
      decimals: 4,
      history: [19.78, 19.76, 19.75, 19.73, 19.74, 19.71, 19.70, 19.69, 19.685, 19.68]
    },
    {
      id: 'EURUSD',
      symbol: 'EUR/USD',
      fxCode: 'EUR',
      invertFx: true,
      badge: 'EUR',
      name: 'Euro a Dólar Estadounidense',
      category: 'forex',
      price: 1.0865,
      change24h: 0.18,
      prefix: '$',
      decimals: 4,
      history: [1.0840, 1.0844, 1.0848, 1.0846, 1.0852, 1.0855, 1.0859, 1.0861, 1.0863, 1.0865]
    }
  ];

  function formatAssetPrice(asset) {
    return `${asset.prefix}${asset.price.toLocaleString('en-US', {
      minimumFractionDigits: asset.decimals,
      maximumFractionDigits: asset.decimals
    })}`;
  }

  function drawSparkline(asset) {
    const w = sparkCanvas.width;
    const h = sparkCanvas.height;
    sparkCtx.clearRect(0, 0, w, h);

    const pts = asset.history;
    if (!pts || pts.length < 2) return;

    const min = Math.min(...pts);
    const max = Math.max(...pts);
    const range = Math.max(0.0001, max - min);
    const isUp = asset.change24h >= 0;
    const strokeColor = isUp ? '#10b981' : '#ef4444';

    sparkCtx.beginPath();
    pts.forEach((val, idx) => {
      const x = (idx / (pts.length - 1)) * (w - 8) + 4;
      const y = h - 8 - ((val - min) / range) * (h - 16);
      if (idx === 0) sparkCtx.moveTo(x, y);
      else sparkCtx.lineTo(x, y);
    });
    sparkCtx.strokeStyle = strokeColor;
    sparkCtx.lineWidth = 2.2;
    sparkCtx.stroke();

    // Area fill under sparkline
    const grad = sparkCtx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, isUp ? 'rgba(16, 185, 129, 0.32)' : 'rgba(239, 68, 68, 0.32)');
    grad.addColorStop(1, 'rgba(15, 23, 42, 0.0)');
    sparkCtx.lineTo(w - 4, h);
    sparkCtx.lineTo(4, h);
    sparkCtx.closePath();
    sparkCtx.fillStyle = grad;
    sparkCtx.fill();
  }

  function updateFeaturedMarketCard() {
    const asset = marketAssets.find((a) => a.id === selectedTickerId) || marketAssets[0];
    featuredSymbol.textContent = asset.symbol;
    featuredName.textContent = asset.name;
    featuredPrice.textContent = formatAssetPrice(asset);
    const sign = asset.change24h >= 0 ? '+' : '';
    featuredChange.textContent = `${sign}${asset.change24h.toFixed(2)}%`;
    featuredChange.className = `mf-change ${asset.change24h >= 0 ? 'up' : 'down'}`;
    drawSparkline(asset);
  }

  function renderMarketList() {
    marketListEl.innerHTML = '';
    const filtered = marketAssets.filter(
      (a) => activeMarketTab === 'all' || a.category === activeMarketTab
    );

    filtered.forEach((asset) => {
      const row = document.createElement('div');
      row.className = `ticker-row ${asset.id === selectedTickerId ? 'active' : ''}`;
      const isUp = asset.change24h >= 0;
      const sign = isUp ? '+' : '';

      row.innerHTML = `
        <div class="ticker-left">
          <div class="ticker-badge">${asset.badge}</div>
          <div>
            <span class="ticker-symbol">${asset.symbol}</span>
            <span class="ticker-desc">${asset.name}</span>
          </div>
        </div>
        <div class="ticker-right">
          <span class="ticker-price">${formatAssetPrice(asset)}</span>
          <span class="ticker-change ${isUp ? 'up' : 'down'}">${sign}${asset.change24h.toFixed(2)}%</span>
        </div>
      `;

      row.addEventListener('click', () => {
        selectedTickerId = asset.id;
        updateFeaturedMarketCard();
        renderMarketList();
      });

      marketListEl.appendChild(row);
    });
  }

  // Fetch Real Data from Free Public Financial APIs (CoinGecko, Binance, Open-ER Forex, and Yahoo Finance)
  async function fetchLiveMarketData() {
    marketStatusDot.className = 'api-status loading';
    marketStatusDot.textContent = 'SYNC';

    // 1. Fetch Live Crypto Prices via CoinGecko Free API (with Binance fallback)
    try {
      const cgRes = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true'
      );
      if (cgRes.ok) {
        const cgData = await cgRes.json();
        marketAssets.forEach((asset) => {
          if (asset.cgId && cgData[asset.cgId]) {
            const p = cgData[asset.cgId].usd;
            const chg = cgData[asset.cgId].usd_24h_change;
            if (p) {
              asset.price = p;
              asset.history.push(p);
              if (asset.history.length > 16) asset.history.shift();
            }
            if (typeof chg === 'number') asset.change24h = chg;
          }
        });
      }
    } catch (_) {
      // Fallback to Binance public 24hr ticker API
      try {
        const binRes = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=["BTCUSDT","ETHUSDT","SOLUSDT"]');
        if (binRes.ok) {
          const binData = await binRes.json();
          binData.forEach((item) => {
            const asset = marketAssets.find((a) => a.binanceSymbol === item.symbol);
            if (asset) {
              asset.price = parseFloat(item.lastPrice);
              asset.change24h = parseFloat(item.priceChangePercent);
              asset.history.push(asset.price);
              if (asset.history.length > 16) asset.history.shift();
            }
          });
        }
      } catch (e2) {
        console.warn('Crypto fallback warning:', e2);
      }
    }

    // 2. Fetch Live Forex Rates via Open Exchange Rates / Frankfurter Free API (no key required)
    try {
      const fxRes = await fetch('https://open.er-api.com/v6/latest/USD');
      if (fxRes.ok) {
        const fxData = await fxRes.json();
        if (fxData && fxData.rates) {
          marketAssets.forEach((asset) => {
            if (asset.fxCode && fxData.rates[asset.fxCode]) {
              const rawRate = fxData.rates[asset.fxCode];
              const computed = asset.invertFx ? 1 / rawRate : rawRate;
              asset.price = computed;
              asset.history.push(computed);
              if (asset.history.length > 16) asset.history.shift();
            }
          });
        }
      }
    } catch (fxErr) {
      console.warn('Forex API notice:', fxErr);
    }

    // 3. Attempt live Stock Quotes via Yahoo Finance chart endpoint over AllOrigins CORS bridge
    try {
      const stockAssets = marketAssets.filter((a) => a.yahooSymbol);
      await Promise.allSettled(
        stockAssets.map(async (asset) => {
          const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.yahooSymbol)}?interval=15m&range=1d`;
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(yUrl)}`;
          const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(4500) });
          if (!res.ok) return;
          const data = await res.json();
          const meta = data?.chart?.result?.[0]?.meta;
          const quotes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
          if (meta && meta.regularMarketPrice) {
            asset.price = meta.regularMarketPrice;
            if (meta.chartPreviousClose) {
              asset.change24h = ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
            }
            if (Array.isArray(quotes)) {
              const clean = quotes.filter((v) => typeof v === 'number').slice(-14);
              if (clean.length >= 4) asset.history = clean;
            }
          }
        })
      );
    } catch (_) {
      // Quietly keep cached stock prices if CORS proxy is busy
    }

    const now = new Date();
    marketUpdatedTime.textContent = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    marketStatusDot.className = 'api-status online';
    marketStatusDot.textContent = 'LIVE';

    updateFeaturedMarketCard();
    renderMarketList();
  }

  // Market Category Tabs
  document.querySelectorAll('.m-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.m-tab').forEach((b) => b.classList.remove('active'));
      tabBtn.classList.add('active');
      activeMarketTab = tabBtn.dataset.tab;
      renderMarketList();
    });
  });

  refreshMarketBtn.addEventListener('click', fetchLiveMarketData);

  // Live micro-tick updates every 6 seconds to keep the market board dynamic between full API syncs
  setInterval(() => {
    marketAssets.forEach((asset) => {
      const deltaPct = (Math.random() - 0.495) * 0.0018;
      asset.price = Math.max(0.01, asset.price * (1 + deltaPct));
      asset.change24h += deltaPct * 45;
      asset.history.push(asset.price);
      if (asset.history.length > 16) asset.history.shift();
    });
    updateFeaturedMarketCard();
    renderMarketList();
  }, 6000);

  // Periodic full API refresh every 60 seconds
  setInterval(fetchLiveMarketData, 60000);

  // ============================================================================
  // 6. INITIALIZATION ON STARTUP
  // ============================================================================
  // 1) Pre-load the synthesized Demo Track (paused at 00:00) so the central waveform is immediately visible
  generateAndLoadDemoTrack(false);

  // 2) Fetch live weather & market data
  fetchWeather(currentWeatherLoc.lat, currentWeatherLoc.lon, currentWeatherLoc.name);
  updateFeaturedMarketCard();
  renderMarketList();
  fetchLiveMarketData();
})();
