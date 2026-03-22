// ─── State ───────────────────────────────────────────────────────────────
// States: 'idle' | 'running' | 'paused' | 'confirm-reset' | 'alarm' | 'done'
//
// Colors:  running / paused / confirm-reset  → normal  (black bg, white text)
//          everything else                   → inverted (white bg, black text)

let appState = 'idle';
let preResetState = null;     // which state we paused from when asking to reset
let remainingSeconds = 0;
let lastSetSeconds = 0;        // last timer value confirmed by the user
let timerInterval = null;
let timerEndTime = null;         // absolute ms timestamp when countdown reaches zero
let endTimeTickInterval = null;
let currentMode = 'pomodoro';
let tasks = [];
let nextId = 1;

// Alarm
let alarmActive = false;
let alarmBeepInterval = null;
let audioCtx = null;
let pendingSessionDuration = 0; // set in startAlarm if pomodoro; cleared after save/skip

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

function updateTimerDisplay() {
  const el = document.getElementById('timer-display');
  el.textContent = secondsToHMS(remainingSeconds);
  if (appState === 'running' || appState === 'paused') {
    document.title = `${secondsToHMS(remainingSeconds)} — Pomupomu`;
  }
  if (appState === 'ready' || appState === 'running' || appState === 'paused') {
    const end = new Date(Date.now() + remainingSeconds * 1000);
    const timeStr = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
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

  // Timer opacity
  timerEl.style.opacity = (newState === 'paused' || newState === 'confirm-reset') ? '0.45' : '1';

  // Hints
  document.getElementById('confirm-prompt').classList.toggle('hidden', newState !== 'confirm-reset');
  document.getElementById('alarm-hint').classList.toggle('hidden',    newState !== 'alarm');

  const showEndTime = newState === 'ready' || newState === 'running' || newState === 'paused';
  document.getElementById('end-time-hint').style.visibility = showEndTime ? 'visible' : 'hidden';

  // Tick the end-time display every second in states where the countdown isn't running
  clearInterval(endTimeTickInterval);
  endTimeTickInterval = null;
  if (newState === 'ready' || newState === 'paused') {
    endTimeTickInterval = setInterval(updateTimerDisplay, 1000);
  }

  // Pause overlay
  document.getElementById('pause-overlay').classList.toggle('visible', newState === 'paused');

  // Start / Pause / Resume button
  const btn = document.getElementById('timer-btn');
  if (newState === 'running') btn.textContent = 'Pause';
  else if (newState === 'paused') btn.textContent = 'Resume';
  else btn.textContent = 'Start';

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
  timerEndTime = Date.now() + remainingSeconds * 1000;
  timerInterval = setInterval(() => {
    remainingSeconds = Math.max(0, Math.round((timerEndTime - Date.now()) / 1000));
    updateTimerDisplay();
    if (remainingSeconds <= 0) {
      clearInterval(timerInterval);
      startAlarm();
    }
  }, 500);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && appState === 'running') {
    remainingSeconds = Math.max(0, Math.round((timerEndTime - Date.now()) / 1000));
    updateTimerDisplay();
    if (remainingSeconds <= 0) {
      clearInterval(timerInterval);
      startAlarm();
    }
  }
});

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
  // Capture pomodoro session before mode flips
  if (currentMode === 'pomodoro') pendingSessionDuration = lastSetSeconds;
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
  if (pendingSessionDuration > 0) showSessionModal();
}

// ─── Click handler ────────────────────────────────────────────────────────
function onTimerClick() {
  if (alarmActive) { stopAlarm(); return; }
  if (appState === 'running') { clearInterval(timerInterval); setState('paused'); return; }
  if (appState === 'paused')  { setState('running'); startCountdown(); return; }
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
  // Let the session modal handle its own keys
  if (!document.getElementById('session-modal').classList.contains('hidden')) return;

  // Alarm takes highest priority
  if (alarmActive) {
    stopAlarm();
    e.preventDefault();
    return;
  }

  // Let the task input handle its own keys
  if (document.activeElement === document.getElementById('task-input')) return;

  if (appState === 'ready') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault(); setState('running'); startCountdown();
    }
  } else if (appState === 'running') {
    if (e.key === ' ') {
      e.preventDefault(); clearInterval(timerInterval); setState('paused');
    }
  } else if (appState === 'paused') {
    if (e.key === ' ') {
      e.preventDefault(); setState('running'); startCountdown();
    }
  }
});

// ─── Quick time buttons ───────────────────────────────────────────────────
function addMinutes(mins) {
  if (appState === 'alarm' || appState === 'confirm-reset') return;
  const add = mins * 60;

  if (appState === 'idle') {
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
function saveTasks() {
  localStorage.setItem('pmp_tasks', JSON.stringify({ tasks, nextId }));
}

function loadTasks() {
  const stored = JSON.parse(localStorage.getItem('pmp_tasks') || 'null');
  if (stored) {
    tasks = stored.tasks || [];
    nextId = stored.nextId || (tasks.length ? Math.max(...tasks.map(t => t.id)) + 1 : 1);
  }
}

function handleTaskInput(e) {
  if (e.key === 'Enter') addTask();
}

function addTask() {
  const input = document.getElementById('task-input');
  const text = input.value.trim();
  if (!text) return;
  tasks.push({ id: nextId++, text, done: false });
  saveTasks();
  input.value = '';
  renderTasks();
}

function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  if (task) { task.done = !task.done; saveTasks(); renderTasks(); }
}

function deleteTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  saveTasks();
  renderTasks();
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clearDone() {
  tasks = tasks.filter(t => !t.done);
  saveTasks();
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
    saveTasks();
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

// ─── Session modal ────────────────────────────────────────────────────────
function handleSessionTitleKey(e) {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('session-desc-input').focus(); }
  if (e.key === 'Escape') { e.preventDefault(); skipSessionModal(); }
}

function handleSessionDescKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveSessionModal(); }
  if (e.key === 'Escape') { e.preventDefault(); skipSessionModal(); }
}

function showSessionModal() {
  const modal = document.getElementById('session-modal');
  modal.classList.remove('hidden');
  const titleInput = document.getElementById('session-title-input');
  titleInput.value = '';
  document.getElementById('session-desc-input').value = '';
  titleInput.focus();
}

function hideSessionModal() {
  document.getElementById('session-modal').classList.add('hidden');
  pendingSessionDuration = 0;
}

function saveSessionModal() {
  const title = document.getElementById('session-title-input').value.trim();
  const desc = document.getElementById('session-desc-input').value.trim();
  recordSession(title, desc);
  hideSessionModal();
}

function skipSessionModal() {
  recordSession('', '');
  hideSessionModal();
}

function recordSession(title, desc) {
  if (!pendingSessionDuration) return;
  const sessions = JSON.parse(localStorage.getItem('pmp_sessions') || '[]');
  sessions.unshift({ ts: Date.now(), duration: pendingSessionDuration, title, description: desc });
  localStorage.setItem('pmp_sessions', JSON.stringify(sessions));
}

// ─── Stats ────────────────────────────────────────────────────────────────
function toggleStats() {
  const panel = document.getElementById('stats-panel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  if (opening) renderStats();
}

let loadedSessions = [];

function renderStats() {
  loadedSessions = JSON.parse(localStorage.getItem('pmp_sessions') || '[]');
  renderStreak(loadedSessions);
  renderTotalFocus(loadedSessions);
  renderConsistencyGrid(loadedSessions);
  renderWeeklySnapshot(loadedSessions);
  renderRecentSessions(loadedSessions);
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

  const dow = today.getDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const thisMon = new Date(today);
  thisMon.setDate(today.getDate() - daysToMon);

  // Compute cell size so the grid fills the full container width
  const GAP = 3;
  const DAY_LABEL_W = 28; // approx width of "Mon"/"Wed"/"Fri" label column
  const MIN_CELL = 8;
  const containerW = grid.offsetWidth;
  // Cap weeks so cells never drop below MIN_CELL (prevents overflow on narrow screens)
  const maxWeeks = Math.floor((containerW - DAY_LABEL_W) / (MIN_CELL + GAP));
  const WEEKS = Math.min(53, Math.max(12, maxWeeks)); // current week + up to 52 weeks back
  const startDate = new Date(thisMon);
  startDate.setDate(thisMon.getDate() - (WEEKS - 1) * 7);

  // total gaps = 1 (after label col) + (WEEKS-1) between week cols = WEEKS gaps
  const cellSize = Math.max(MIN_CELL, Math.floor((containerW - DAY_LABEL_W - GAP * WEEKS) / WEEKS));

  // Single grid: col 1 = day labels, cols 2…N = weeks
  //              row 1 = month labels, rows 2…8 = Mon–Sun
  const cal = document.createElement('div');
  cal.className = 'grid-calendar';
  cal.style.gridTemplateColumns = `auto repeat(${WEEKS}, ${cellSize}px)`;
  cal.style.gridTemplateRows = `14px repeat(7, ${cellSize}px)`;

  // Day labels: Mon, Wed, Fri only (rows 2, 4, 6)
  [['Mon', 2], ['Wed', 4], ['Fri', 6]].forEach(([name, row]) => {
    const el = document.createElement('span');
    el.className = 'day-label';
    el.textContent = name;
    el.style.gridRow = row;
    el.style.gridColumn = 1;
    cal.appendChild(el);
  });

  const monthSeen = new Set();

  for (let week = 0; week < WEEKS; week++) {
    for (let day = 0; day < 7; day++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + week * 7 + day);

      // Month label on the first week it appears
      if (day === 0) {
        const mk = `${date.getFullYear()}-${date.getMonth()}`;
        if (!monthSeen.has(mk)) {
          monthSeen.add(mk);
          const label = document.createElement('span');
          label.className = 'grid-month-label';
          label.textContent = date.toLocaleDateString([], { month: 'short' });
          label.style.gridRow = 1;
          label.style.gridColumn = week + 2;
          cal.appendChild(label);
        }
      }

      const mins = dayMinutes[date.getTime()] || 0;
      const level = mins === 0 ? 0 : mins <= 30 ? 1 : mins <= 60 ? 2 : mins <= 90 ? 3 : 4;

      const cell = document.createElement('span');
      cell.className = `grid-cell grid-cell-l${level}`;
      cell.style.gridRow = day + 2;
      cell.style.gridColumn = week + 2;
      cell.title = `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${mins}m`;
      cal.appendChild(cell);
    }
  }

  grid.appendChild(cal);

  // Less / More legend
  const legend = document.createElement('div');
  legend.className = 'grid-legend';
  legend.innerHTML = `<span class="grid-legend-text">Less</span>${[0,1,2,3,4].map(l =>
    `<span class="grid-cell grid-cell-l${l} grid-legend-cell"></span>`).join('')}<span class="grid-legend-text">More</span>`;
  grid.appendChild(legend);
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

  const maxVal = 960; // 16 hours in minutes

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

function buildSessionCard(s, i, subLabel) {
  const h = Math.floor(s.duration / 3600);
  const m = Math.floor((s.duration % 3600) / 60);
  const durStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
  const titleStr = s.title ? escapeHtml(s.title) : 'Untitled';
  const sub = escapeHtml(subLabel);
  return `<li class="recent-item" onclick="showSessionDetail(${i})" title="View details">
    <div class="recent-label">Focus</div>
    <div class="recent-info">
      <span class="recent-title">${titleStr}</span>
      <span class="recent-date">${sub}</span>
    </div>
    <div class="recent-dur-badge">${durStr}</div>
  </li>`;
}

function renderRecentSessions(sessions) {
  const list = document.getElementById('recent-sessions');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

  document.getElementById('see-all-btn').classList.toggle('hidden', sessions.length <= 5);

  if (!sessions.length) {
    list.innerHTML = '<li class="recent-empty">No sessions yet.</li>';
    return;
  }

  list.innerHTML = sessions.slice(0, 5).map((s, i) => {
    const d = new Date(s.ts); d.setHours(0, 0, 0, 0);
    let dateStr;
    if (d.getTime() === today.getTime()) dateStr = 'Today';
    else if (d.getTime() === yesterday.getTime()) dateStr = 'Yesterday';
    else dateStr = new Date(s.ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
    return buildSessionCard(s, i, dateStr);
  }).join('');
}

function toggleSeeAll() {
  showAllSessionsModal();
}

function showAllSessionsModal() {
  renderAllSessionsModal();
  document.getElementById('all-sessions-modal').classList.remove('hidden');
}

function hideAllSessionsModal() {
  document.getElementById('all-sessions-modal').classList.add('hidden');
}

function renderAllSessionsModal() {
  const container = document.getElementById('all-sessions-list');
  container.innerHTML = '';
  const sessions = loadedSessions;

  if (!sessions.length) {
    container.innerHTML = '<p class="recent-empty">No sessions yet.</p>';
    return;
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

  // Group sessions by calendar day (sessions are newest-first)
  const groups = [];
  const keyMap = {};
  sessions.forEach((s, i) => {
    const d = new Date(s.ts); d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    if (!keyMap[key]) {
      keyMap[key] = { date: d, entries: [] };
      groups.push(keyMap[key]);
    }
    keyMap[key].entries.push({ s, i });
  });

  groups.forEach(({ date, entries }) => {
    let label;
    if (date.getTime() === today.getTime()) label = 'Today';
    else if (date.getTime() === yesterday.getTime()) label = 'Yesterday';
    else label = date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

    const heading = document.createElement('div');
    heading.className = 'all-sessions-date-heading';
    heading.textContent = label;
    container.appendChild(heading);

    const ul = document.createElement('ul');
    ul.className = 'recent-list';
    ul.innerHTML = entries.map(({ s, i }) => {
      const timeStr = new Date(s.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return buildSessionCard(s, i, timeStr);
    }).join('');
    container.appendChild(ul);
  });
}

// ─── Session detail ───────────────────────────────────────────────────────
function showSessionDetail(i) {
  const s = loadedSessions[i];
  if (!s) return;

  const h = Math.floor(s.duration / 3600);
  const m = Math.floor((s.duration % 3600) / 60);
  const durStr = h > 0 ? `${h}h ${m}m` : `${m}m`;

  document.getElementById('detail-title').textContent = s.title || 'Untitled session';
  document.getElementById('detail-meta').textContent =
    `${durStr}  ·  ${new Date(s.ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}  ·  ${new Date(s.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  const descEl = document.getElementById('detail-desc');
  const descSection = document.getElementById('detail-desc-section');
  if (s.description) {
    descEl.textContent = s.description;
    descSection.classList.remove('hidden');
  } else {
    descSection.classList.add('hidden');
  }

  document.getElementById('session-detail-modal').classList.remove('hidden');
}

function hideSessionDetail() {
  document.getElementById('session-detail-modal').classList.add('hidden');
}

// ─── Theme ────────────────────────────────────────────────────────────────
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('pmp_theme', theme);
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
  closePicker();
}

function toggleThemePicker() {
  document.getElementById('theme-picker').classList.toggle('hidden');
}

function closePicker() {
  document.getElementById('theme-picker').classList.add('hidden');
}

function loadTheme() {
  const saved = localStorage.getItem('pmp_theme') || 'default';
  document.documentElement.dataset.theme = saved;
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === saved);
  });
}

// ─── Document-level click — stop alarm from anywhere ──────────────────────
document.addEventListener('click', (e) => {
  if (alarmActive) { stopAlarm(); return; }
  const picker = document.getElementById('theme-picker');
  const btn = document.getElementById('theme-btn');
  if (!picker.classList.contains('hidden') && !picker.contains(e.target) && !btn.contains(e.target)) {
    closePicker();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────
loadTheme();
setState('idle');
updateTimerDisplay();
loadTasks();
renderTasks();
