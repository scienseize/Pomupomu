// ─── State ───────────────────────────────────────────────────────────────
// States: 'idle' | 'editing' | 'running' | 'paused' | 'confirm-reset' | 'alarm' | 'done'
//
// Colors:  running / paused / confirm-reset  → normal  (black bg, white text)
//          everything else                   → inverted (white bg, black text)

let appState = 'idle';
let preResetState = null;     // which state we paused from when asking to reset
let cancelEditTarget = 'idle'; // which state Escape returns to from editing
let digitBuffer = [];          // up to 6 digits, newest at end → renders as HH:MM:SS
let remainingSeconds = 0;
let lastSetSeconds = 0;        // last timer value confirmed by the user
let timerInterval = null;
let currentMode = 'pomodoro';
let tasks = [];
let nextId = 1;

// Alarm
let alarmActive = false;
let alarmBeepInterval = null;
let audioCtx = null;

const taglines = {
  pomodoro: `it's time to <em>focus.</em>`,
  break:    `time for a <em>break.</em>`,
};

// ─── Display helpers ──────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

function secondsToHMS(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function bufferToDisplay() {
  const d = [...digitBuffer];
  while (d.length < 6) d.unshift(0);
  return `${d[0]}${d[1]}:${d[2]}${d[3]}:${d[4]}${d[5]}`;
}

function secondsToDigits(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const all = [Math.floor(h / 10), h % 10, Math.floor(m / 10), m % 10, Math.floor(s / 10), s % 10];
  let i = 0;
  while (i < all.length - 1 && all[i] === 0) i++;
  return all.slice(i);
}

function bufferToSeconds() {
  const d = [...digitBuffer];
  while (d.length < 6) d.unshift(0);
  const h = d[0] * 10 + d[1];
  const m = Math.min(d[2] * 10 + d[3], 59);
  const s = Math.min(d[4] * 10 + d[5], 59);
  return h * 3600 + m * 60 + s;
}

function updateTimerDisplay() {
  const el = document.getElementById('timer-display');
  el.textContent = appState === 'editing' ? bufferToDisplay() : secondsToHMS(remainingSeconds);
  if (appState === 'running' || appState === 'paused') {
    document.title = `${secondsToHMS(remainingSeconds)} — Pomupomu`;
  }
}

// ─── State machine ────────────────────────────────────────────────────────
function setState(newState) {
  appState = newState;
  const body    = document.body;
  const timerEl = document.getElementById('timer-display');

  // Color scheme
  const isNormal = newState === 'running' || newState === 'paused' || newState === 'confirm-reset';
  body.classList.toggle('inverted', !isNormal);

  // Editing cursor
  timerEl.classList.toggle('editing', newState === 'editing');

  // Timer opacity
  timerEl.style.opacity = (newState === 'paused' || newState === 'confirm-reset') ? '0.45' : '1';

  // Hints
  document.getElementById('edit-hint').classList.toggle('hidden',     newState !== 'editing');
  document.getElementById('confirm-prompt').classList.toggle('hidden', newState !== 'confirm-reset');
  document.getElementById('alarm-hint').classList.toggle('hidden',    newState !== 'alarm');
  document.getElementById('ready-hint').classList.toggle('hidden',    newState !== 'ready');

  // Pause overlay
  document.getElementById('pause-overlay').classList.toggle('visible', newState === 'paused');

  // Start / Pause / Resume button
  const btn = document.getElementById('timer-btn');
  const showBtn = newState === 'ready' || newState === 'running' || newState === 'paused';
  btn.classList.toggle('visible', showBtn);
  if (newState === 'ready')   btn.textContent = 'Start';
  if (newState === 'running') btn.textContent = 'Pause';
  if (newState === 'paused')  btn.textContent = 'Resume';

  // Reset button
  document.getElementById('reset-btn').classList.toggle('visible', showBtn);

  // Lock mode tabs while timer is active
  const timerActive = newState === 'running' || newState === 'paused' || newState === 'confirm-reset';
  document.querySelectorAll('.mode-btn').forEach(b => { b.disabled = timerActive; });

  // Browser tab title — reset when not actively counting
  if (newState !== 'running' && newState !== 'paused') {
    document.title = 'Pomupomu';
  }
}

// ─── Timer control ────────────────────────────────────────────────────────
function startCountdown() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (remainingSeconds <= 0) {
      clearInterval(timerInterval);
      remainingSeconds = 0;
      updateTimerDisplay();
      startAlarm();
      return;
    }
    remainingSeconds--;
    updateTimerDisplay();
  }, 1000);
}

function enterEditMode(prefill = false) {
  cancelEditTarget = (appState === 'done' || appState === 'ready') ? appState : 'idle';
  digitBuffer = (prefill && lastSetSeconds > 0) ? secondsToDigits(lastSetSeconds) : [];
  setState('editing');
  updateTimerDisplay();
}

function confirmEdit() {
  const secs = bufferToSeconds();
  if (secs === 0) {
    remainingSeconds = 0;
    setState('idle');
    updateTimerDisplay();
    return;
  }
  lastSetSeconds = secs;
  remainingSeconds = secs;
  setState('ready');
  updateTimerDisplay();
}

function cancelEdit() {
  digitBuffer = [];
  if (cancelEditTarget === 'done' || cancelEditTarget === 'ready') {
    remainingSeconds = lastSetSeconds;
    setState(cancelEditTarget);
  } else {
    remainingSeconds = 0;
    setState('idle');
  }
  updateTimerDisplay();
}

// ─── Reset confirmation ───────────────────────────────────────────────────
function showResetConfirm() {
  preResetState = appState; // 'running' or 'paused'
  clearInterval(timerInterval);
  setState('confirm-reset');
}

function confirmReset() {
  preResetState = null;
  remainingSeconds = 0;
  setState('idle');
  updateTimerDisplay();
}

function cancelReset() {
  const returnTo = preResetState;
  preResetState = null;
  if (returnTo === 'running') {
    setState('running');
    startCountdown();
  } else {
    setState('paused');
  }
}

// ─── Alarm ────────────────────────────────────────────────────────────────
function playBeep() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;

  // Two-tone ascending beep: 660 Hz then 880 Hz
  [[660, 0], [880, 0.2]].forEach(([freq, offset]) => {
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.55, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.18);
    osc.start(now + offset);
    osc.stop(now + offset + 0.18);
  });
}

function startAlarm() {
  // Auto-switch mode for the next session
  setMode(currentMode === 'pomodoro' ? 'break' : 'pomodoro');

  alarmActive = true;
  setState('alarm');
  document.querySelector('.layout').classList.add('shaking');

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  playBeep();
  alarmBeepInterval = setInterval(playBeep, 1200);
}

function stopAlarm() {
  if (!alarmActive) return;
  alarmActive = false;
  document.querySelector('.layout').classList.remove('shaking');
  clearInterval(alarmBeepInterval);
  alarmBeepInterval = null;
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  remainingSeconds = lastSetSeconds;
  setState('done');
  updateTimerDisplay();
}

// ─── Click handler ────────────────────────────────────────────────────────
function onTimerClick() {
  if (alarmActive)            { stopAlarm(); return; }
  if (appState === 'running') { clearInterval(timerInterval); setState('paused'); return; }
  if (appState === 'paused')  { setState('running'); startCountdown(); return; }
  if (appState === 'ready')   { enterEditMode(true); return; }
  if (appState === 'idle')    { enterEditMode(false); return; }
  if (appState === 'done')    { enterEditMode(true); }
}

function onTimerBtnClick() {
  if (appState === 'ready')   { setState('running'); startCountdown(); return; }
  if (appState === 'running') { clearInterval(timerInterval); setState('paused'); return; }
  if (appState === 'paused')  { setState('running'); startCountdown(); }
}

function onResetBtnClick() {
  clearInterval(timerInterval);
  remainingSeconds = 0;
  lastSetSeconds = 0;
  setState('idle');
  updateTimerDisplay();
}

// ─── Keyboard ─────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Alarm takes highest priority
  if (alarmActive) {
    stopAlarm();
    e.preventDefault();
    return;
  }

  // Let the task input handle its own keys
  if (document.activeElement === document.getElementById('task-input')) return;

  if (appState === 'editing') {
    if (e.key >= '0' && e.key <= '9') {
      if (digitBuffer.length < 6) { digitBuffer.push(parseInt(e.key)); updateTimerDisplay(); }
    } else if (e.key === 'Backspace') {
      digitBuffer.pop(); updateTimerDisplay();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); confirmEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }

  } else if (appState === 'ready') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault(); setState('running'); startCountdown();
    } else if (e.key === 'Escape') {
      remainingSeconds = 0; lastSetSeconds = 0; setState('idle'); updateTimerDisplay();
    } else if (e.key >= '0' && e.key <= '9') {
      enterEditMode(false);
      digitBuffer.push(parseInt(e.key));
      updateTimerDisplay();
    }

  } else if (appState === 'idle' || appState === 'done') {
    if (e.key >= '0' && e.key <= '9') {
      enterEditMode(false);
      digitBuffer.push(parseInt(e.key));
      updateTimerDisplay();
    }

  } else if (appState === 'running') {
    if (e.key === ' ') {
      e.preventDefault(); clearInterval(timerInterval); setState('paused');
    }

  } else if (appState === 'paused') {
    if (e.key === ' ') {
      e.preventDefault(); setState('running'); startCountdown();
    } else if (e.key >= '0' && e.key <= '9') {
      clearInterval(timerInterval);
      enterEditMode();
      digitBuffer.push(parseInt(e.key));
      updateTimerDisplay();
    }
  }
});

// ─── Quick time buttons ───────────────────────────────────────────────────
function addMinutes(mins) {
  if (appState === 'alarm' || appState === 'confirm-reset') return;
  const add = mins * 60;

  if (appState === 'editing') {
    remainingSeconds = bufferToSeconds() + add;
    digitBuffer = [];
    lastSetSeconds = remainingSeconds;
    setState('ready');
    updateTimerDisplay();
  } else if (appState === 'idle') {
    remainingSeconds = add;
    lastSetSeconds = remainingSeconds;
    setState('ready');
    updateTimerDisplay();
  } else if (appState === 'done') {
    remainingSeconds += add;
    lastSetSeconds = remainingSeconds;
    setState('ready');
    updateTimerDisplay();
  } else if (appState === 'ready') {
    remainingSeconds += add;
    lastSetSeconds = remainingSeconds;
    updateTimerDisplay();
  } else if (appState === 'running' || appState === 'paused') {
    remainingSeconds += add;
    updateTimerDisplay();
  }
}

// ─── Mode ─────────────────────────────────────────────────────────────────
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  document.getElementById('tagline').innerHTML = taglines[mode];
}

// ─── Tasks ────────────────────────────────────────────────────────────────
function handleTaskInput(e) {
  if (e.key === 'Enter') addTask();
}

function addTask() {
  const input = document.getElementById('task-input');
  const text = input.value.trim();
  if (!text) return;
  tasks.push({ id: nextId++, text, done: false });
  input.value = '';
  renderTasks();
}

function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  if (task) { task.done = !task.done; renderTasks(); }
}

function deleteTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  renderTasks();
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clearDone() {
  tasks = tasks.filter(t => !t.done);
  renderTasks();
}

function editTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const span = document.querySelector(`.task-text[data-id="${id}"]`);
  if (!span) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = task.text;
  input.className = 'task-edit-input';
  input.maxLength = 80;
  span.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  function save() {
    if (committed) return;
    committed = true;
    const newText = input.value.trim();
    if (newText) task.text = newText;
    renderTasks();
  }
  function cancel() {
    if (committed) return;
    committed = true;
    renderTasks();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', save);
}

function renderTasks() {
  const list = document.getElementById('task-list');
  const sorted = [...tasks].sort((a, b) => a.done - b.done);
  list.innerHTML = sorted.map(t => `
    <li class="task-item ${t.done ? 'task-done' : ''}">
      <span class="task-check ${t.done ? 'checked' : ''}" onclick="toggleTask(${t.id})"></span>
      <span class="task-text" onclick="editTask(${t.id})" data-id="${t.id}">${escapeHtml(t.text)}</span>
      <button class="delete-btn" onclick="deleteTask(${t.id})" title="Delete">×</button>
    </li>
  `).join('');
  document.getElementById('clear-done-btn').classList.toggle('visible', tasks.some(t => t.done));
}

// ─── Document-level click — stop alarm from anywhere ──────────────────────
document.addEventListener('click', () => {
  if (alarmActive) stopAlarm();
});

// ─── Init ─────────────────────────────────────────────────────────────────
setState('idle');
updateTimerDisplay();
renderTasks();
