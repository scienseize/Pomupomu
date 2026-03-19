// ─── State ───────────────────────────────────────────────────────────────
// States: 'idle' | 'editing' | 'running' | 'paused' | 'confirm-reset' | 'alarm' | 'done'
//
// Colors:  running / paused / confirm-reset  → normal  (black bg, white text)
//          everything else                   → inverted (white bg, black text)

let appState = 'idle';
let preResetState = null;     // which state we paused from when asking to reset
let cancelEditTarget = 'idle'; // which state Escape returns to from editing
let digitBuffer = [0,0,0,0,0,0]; // always 6 digits: [H1,H2,M1,M2,S1,S2]
let cursorPos = 0;             // active digit index 0–5
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

function bufferToSeconds() {
  const [h1,h2,m1,m2,s1,s2] = digitBuffer;
  const h = h1*10 + h2;
  const m = Math.min(m1*10 + m2, 59);
  const s = Math.min(s1*10 + s2, 59);
  return h*3600 + m*60 + s;
}

function secondsToBuffer(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [Math.floor(h/10), h%10, Math.floor(m/10), m%10, Math.floor(s/10), s%10];
}

function updateTimerDisplay() {
  const el = document.getElementById('timer-display');
  const isEditing = appState === 'editing';
  const d = isEditing ? digitBuffer : secondsToBuffer(remainingSeconds);
  const c = cursorPos;
  const mk = (i) => `<span class="d${isEditing && c===i?' cur':''}" data-i="${i}">${d[i]}</span>`;
  el.innerHTML = mk(0)+mk(1)+'<span class="sep">:</span>'+mk(2)+mk(3)+'<span class="sep">:</span>'+mk(4)+mk(5);
  if (appState === 'running' || appState === 'paused') {
    document.title = `${secondsToHMS(remainingSeconds)} — Pomupomu`;
  }
  if (appState === 'ready' || appState === 'running' || appState === 'paused') {
    const end = new Date(Date.now() + remainingSeconds * 1000);
    const timeStr = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    document.getElementById('end-time-text').textContent = `Ends at ${timeStr}`;
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

  const showEndTime = newState === 'ready' || newState === 'running' || newState === 'paused';
  document.getElementById('end-time-hint').classList.toggle('hidden', !showEndTime);

  // Pause overlay
  document.getElementById('pause-overlay').classList.toggle('visible', newState === 'paused');

  // Start / Pause / Resume button
  const btn = document.getElementById('timer-btn');
  const showBtn = newState === 'ready' || newState === 'done' || newState === 'running' || newState === 'paused';
  btn.classList.toggle('visible', showBtn);
  if (newState === 'ready' || newState === 'done') btn.textContent = 'Start';
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

function enterEditMode(prefill = false, initialChar = null, startPos = 0) {
  cancelEditTarget = (appState === 'done' || appState === 'ready') ? appState : 'idle';
  digitBuffer = (prefill && lastSetSeconds > 0) ? secondsToBuffer(lastSetSeconds) : [0,0,0,0,0,0];
  cursorPos = startPos;
  if (initialChar !== null) {
    digitBuffer[cursorPos] = parseInt(initialChar);
    if (cursorPos < 5) cursorPos++;
  }
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
  digitBuffer = [0,0,0,0,0,0];
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
  recordSession(); // capture before mode flips
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
function setCursorPos(i) {
  cursorPos = i;
  updateTimerDisplay();
}

function onTimerClick(e) {
  if (alarmActive) { stopAlarm(); return; }

  // Resolve which digit was clicked (works in any state since spans are always rendered)
  const rawI = e && e.target.getAttribute('data-i');
  const clickedDigit = rawI !== null && rawI !== undefined ? parseInt(rawI) : 0;

  if (appState === 'editing') { setCursorPos(clickedDigit); return; }
  if (appState === 'running') { clearInterval(timerInterval); setState('paused'); return; }
  if (appState === 'paused')  { setState('running'); startCountdown(); return; }
  if (appState === 'ready')   { enterEditMode(true,  null, clickedDigit); return; }
  if (appState === 'idle')    { enterEditMode(false, null, clickedDigit); return; }
  if (appState === 'done')    { enterEditMode(true,  null, clickedDigit); }
}

function onTimerBtnClick() {
  if (appState === 'ready' || appState === 'done') { setState('running'); startCountdown(); return; }
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
      digitBuffer[cursorPos] = parseInt(e.key);
      if (cursorPos < 5) cursorPos++;
      updateTimerDisplay();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      digitBuffer[cursorPos] = 0;
      if (cursorPos > 0) cursorPos--;
      updateTimerDisplay();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (cursorPos > 0) { cursorPos--; updateTimerDisplay(); }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (cursorPos < 5) { cursorPos++; updateTimerDisplay(); }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); confirmEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
    // All other keys (letters, symbols) are silently ignored

  } else if (appState === 'ready') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault(); setState('running'); startCountdown();
    } else if (e.key === 'Escape') {
      remainingSeconds = 0; lastSetSeconds = 0; setState('idle'); updateTimerDisplay();
    } else if (e.key >= '0' && e.key <= '9') {
      enterEditMode(false, e.key);
    }

  } else if (appState === 'idle' || appState === 'done') {
    if (e.key >= '0' && e.key <= '9') {
      enterEditMode(false, e.key);
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
      enterEditMode(false, e.key);
    }
  }
});

// ─── Quick time buttons ───────────────────────────────────────────────────
function addMinutes(mins) {
  if (appState === 'alarm' || appState === 'confirm-reset') return;
  const add = mins * 60;

  if (appState === 'editing') {
    remainingSeconds = bufferToSeconds() + add;
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

// ─── Stats ────────────────────────────────────────────────────────────────
function recordSession() {
  if (currentMode !== 'pomodoro') return;
  const sessions = JSON.parse(localStorage.getItem('pmp_sessions') || '[]');
  sessions.unshift({ ts: Date.now(), duration: lastSetSeconds });
  localStorage.setItem('pmp_sessions', JSON.stringify(sessions));
}

function toggleStats() {
  const panel = document.getElementById('stats-panel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  if (opening) renderStats();
}

function renderStats() {
  const sessions = JSON.parse(localStorage.getItem('pmp_sessions') || '[]');
  renderStreak(sessions);
  renderTotalFocus(sessions);
  renderConsistencyGrid(sessions);
  renderWeeklySnapshot(sessions);
  renderRecentSessions(sessions);
}

function renderStreak(sessions) {
  const el = document.getElementById('stat-streak');
  if (!sessions.length) { el.textContent = '0'; return; }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const daySet = new Set(sessions.map(s => {
    const d = new Date(s.ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }));

  let streak = 0;
  const check = new Date(today);
  if (!daySet.has(check.getTime())) {
    check.setDate(check.getDate() - 1);
    if (!daySet.has(check.getTime())) { el.textContent = '0'; return; }
  }
  while (daySet.has(check.getTime())) {
    streak++;
    check.setDate(check.getDate() - 1);
  }
  el.textContent = streak;
}

function renderTotalFocus(sessions) {
  const el = document.getElementById('stat-total');
  const totalSecs = sessions.reduce((sum, s) => sum + s.duration, 0);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  el.textContent = h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderConsistencyGrid(sessions) {
  const grid = document.getElementById('consistency-grid');
  grid.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayMinutes = {};
  sessions.forEach(s => {
    const d = new Date(s.ts);
    d.setHours(0, 0, 0, 0);
    dayMinutes[d.getTime()] = (dayMinutes[d.getTime()] || 0) + Math.floor(s.duration / 60);
  });

  // Find most recent Monday
  const dow = today.getDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const thisMon = new Date(today);
  thisMon.setDate(today.getDate() - daysToMon);

  const startDate = new Date(thisMon);
  startDate.setDate(thisMon.getDate() - 15 * 7); // 16 weeks total

  const cap = 120;
  const WEEKS = 16;
  const DAYS = 7;

  const cellsEl = document.createElement('div');
  cellsEl.className = 'grid-cells';

  const monthMap = {};

  for (let week = 0; week < WEEKS; week++) {
    for (let day = 0; day < DAYS; day++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + week * 7 + day);

      const key = date.getTime();
      const mins = dayMinutes[key] || 0;
      const opacity = mins > 0 ? Math.max(0.12, Math.min(1, mins / cap)) : 0.06;

      const cell = document.createElement('span');
      cell.className = 'grid-cell';
      cell.style.opacity = opacity;
      cell.style.gridRow = day + 1;
      cell.style.gridColumn = week + 1;
      cell.title = `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${mins}m`;
      cellsEl.appendChild(cell);

      if (day === 0) {
        const mk = `${date.getFullYear()}-${date.getMonth()}`;
        if (!monthMap[mk]) monthMap[mk] = { week, name: date.toLocaleDateString([], { month: 'short' }) };
      }
    }
  }

  const monthsEl = document.createElement('div');
  monthsEl.className = 'grid-months';
  Object.values(monthMap).forEach(({ week, name }) => {
    const label = document.createElement('span');
    label.className = 'grid-month-label';
    label.textContent = name;
    label.style.gridColumn = week + 1;
    monthsEl.appendChild(label);
  });

  grid.appendChild(cellsEl);
  grid.appendChild(monthsEl);
}

function renderWeeklySnapshot(sessions) {
  const container = document.getElementById('weekly-chart');
  container.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const monday = new Date(today);
  monday.setDate(today.getDate() - daysToMon);

  const dayMinutes = {};
  sessions.forEach(s => {
    const d = new Date(s.ts);
    d.setHours(0, 0, 0, 0);
    dayMinutes[d.getTime()] = (dayMinutes[d.getTime()] || 0) + Math.floor(s.duration / 60);
  });

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const values = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    values.push(dayMinutes[d.getTime()] || 0);
  }

  const maxVal = Math.max(...values, 1);

  dayNames.forEach((name, i) => {
    const col = document.createElement('div');
    col.className = 'week-col';

    const val = document.createElement('div');
    val.className = 'week-val';
    val.textContent = values[i] > 0 ? `${values[i]}m` : '';

    const barWrap = document.createElement('div');
    barWrap.className = 'week-bar-wrap';

    const bar = document.createElement('div');
    bar.className = 'week-bar';
    bar.style.height = values[i] > 0 ? `${Math.max(4, (values[i] / maxVal) * 100)}%` : '0%';

    const label = document.createElement('div');
    label.className = 'week-label';
    label.textContent = name;

    barWrap.appendChild(bar);
    col.appendChild(val);
    col.appendChild(barWrap);
    col.appendChild(label);
    container.appendChild(col);
  });
}

function renderRecentSessions(sessions) {
  const list = document.getElementById('recent-sessions');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const recent = sessions.slice(0, 5);
  if (!recent.length) {
    list.innerHTML = '<li class="recent-empty">No sessions yet.</li>';
    return;
  }

  list.innerHTML = recent.map(s => {
    const d = new Date(s.ts);
    d.setHours(0, 0, 0, 0);
    let dateStr;
    if (d.getTime() === today.getTime()) dateStr = 'Today';
    else if (d.getTime() === yesterday.getTime()) dateStr = 'Yesterday';
    else dateStr = new Date(s.ts).toLocaleDateString([], { month: 'short', day: 'numeric' });

    const h = Math.floor(s.duration / 3600);
    const m = Math.floor((s.duration % 3600) / 60);
    const durStr = h > 0 ? `${h}h ${m}m` : `${m}m`;

    return `<li class="recent-item"><span class="recent-dur">${durStr}</span><span class="recent-date">${dateStr}</span></li>`;
  }).join('');
}

// ─── Document-level click — stop alarm from anywhere ──────────────────────
document.addEventListener('click', () => {
  if (alarmActive) stopAlarm();
});

// ─── Init ─────────────────────────────────────────────────────────────────
setState('idle');
updateTimerDisplay();
renderTasks();
