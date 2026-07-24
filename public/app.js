const localSettingsKey = 'daily-care-settings';
const cachedStateKey = 'daily-care-state';

let config = {
  timezone: 'UTC',
  resetHour: 5,
  categories: [],
  pushAvailable: false,
};
let state = { category: null, categories: [], dayKey: null, items: {}, previousDay: null };
let viewingPreviousDay = false;
let activeCategoryId = null;
let adminCategoryId = null;
let adminDraftRoutines = [];
let pushSubscription = null;
let pushServerRegistered = false;
let syncedReminderEnabled = null;
let pushSyncChain = Promise.resolve();
let pushBusy = false;
let serviceWorkerRegistration = null;
let deferredInstallPrompt = null;
let toastTimer;

const $ = (selector) => document.querySelector(selector);

function readSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(localSettingsKey));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try { localStorage.setItem(localSettingsKey, JSON.stringify(settings)); } catch {
    // Settings still work for the current session when storage is unavailable.
  }
}

function saveCachedState() {
  try { localStorage.setItem(cachedStateKey, JSON.stringify(state)); } catch {
    // The server remains the source of truth.
  }
}

function loadCachedState() {
  try {
    const cached = JSON.parse(localStorage.getItem(cachedStateKey));
    if (cached && cached.category) state = { ...state, ...cached };
  } catch {
    // A stale cache should not block the app.
  }
}

function withTimeout(promise, milliseconds, message) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

async function api(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'The Daily Care server could not be reached.');
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The Daily Care server did not respond within 15 seconds.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatTime(value) {
  if (!value || !/^\d\d:\d\d$/.test(value)) return value || 'Not set';
  const [hour, minute] = value.split(':').map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, hour, minute));
}

function formatFedTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function formatDay(value) {
  if (!value) return 'Loading your day...';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(year, month - 1, day));
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent)
    || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
}

function categories() {
  return state.categories && state.categories.length ? state.categories : config.categories;
}

function currentCategory() {
  return state.category || categories().find((category) => category.id === activeCategoryId) || categories()[0] || null;
}

function currentRoutines() {
  const category = currentCategory();
  return category ? category.routines || [] : [];
}

function getCategorySettings(category = currentCategory()) {
  const settings = readSettings();
  const saved = settings.categories && category ? settings.categories[category.id] : null;
  return saved && typeof saved === 'object' ? saved : {};
}

function getSchedule() {
  return Object.fromEntries(currentRoutines().map((routine) => [
    routine.id,
    $(`[data-reminder="${CSS.escape(routine.id)}"]`)?.value || routine.time,
  ]));
}

function putSchedule(schedule) {
  currentRoutines().forEach((routine) => {
    const input = $(`[data-reminder="${CSS.escape(routine.id)}"]`);
    if (input) input.value = schedule[routine.id] || routine.time;
  });
}

function normalizeReminderEnabled(enabled) {
  const routines = currentRoutines();
  const defaultEnabled = typeof enabled === 'boolean' ? enabled : true;
  return Object.fromEntries(routines.map((routine) => [
    routine.id,
    enabled && typeof enabled === 'object' && typeof enabled[routine.id] === 'boolean'
      ? enabled[routine.id]
      : defaultEnabled,
  ]));
}

function getReminderEnabled() {
  return Object.fromEntries(currentRoutines().map((routine) => [
    routine.id,
    $(`[data-reminder-enabled="${CSS.escape(routine.id)}"]`)?.checked !== false,
  ]));
}

function putReminderEnabled(enabled) {
  const normalized = normalizeReminderEnabled(enabled);
  currentRoutines().forEach((routine) => {
    const input = $(`[data-reminder-enabled="${CSS.escape(routine.id)}"]`);
    if (input) input.checked = normalized[routine.id];
  });
}

function getExtraReminders() {
  return $('[data-extra-reminders]')?.checked === true;
}

function putExtraReminders(value) {
  const input = $('[data-extra-reminders]');
  if (input) input.checked = Boolean(value);
}

function hasEnabledReminder(enabled = getReminderEnabled()) {
  return Object.values(enabled).some(Boolean);
}

function saveCurrentCategorySettings() {
  const category = currentCategory();
  if (!category) return;
  const settings = readSettings();
  settings.activeCategoryId = category.id;
  settings.categories = settings.categories && typeof settings.categories === 'object' ? settings.categories : {};
  settings.categories[category.id] = {
    schedule: getSchedule(),
    enabled: getReminderEnabled(),
    extraReminders: getExtraReminders(),
  };
  saveSettings(settings);
}

function applyCurrentCategorySettings() {
  const category = currentCategory();
  if (!category) return;
  const saved = getCategorySettings(category);
  const defaults = Object.fromEntries(category.routines.map((routine) => [routine.id, routine.time]));
  putSchedule({ ...defaults, ...(saved.schedule || {}) });
  putReminderEnabled(saved.enabled);
  putExtraReminders(saved.extraReminders);
}

function renderCategoryNav() {
  const list = categories();
  const category = currentCategory();
  if (!category) {
    $('#category-title').textContent = 'Daily Care';
    $('#category-position').textContent = 'Loading your routines';
    return;
  }
  const index = Math.max(0, list.findIndex((candidate) => candidate.id === category.id));
  $('#category-title').textContent = category.name;
  $('#category-position').textContent = list.length > 1 ? `${index + 1} of ${list.length} · Swipe to switch` : 'Your daily routine';
  $('#previous-category-button').disabled = list.length < 2;
  $('#next-category-button').disabled = list.length < 2;
  document.title = `${category.name} · Daily Care`;
}

function makeRoutineCard(routine, index, displayedItems) {
  const completedAt = displayedItems[routine.id] && displayedItems[routine.id].completedAt;
  const button = document.createElement('button');
  button.className = 'meal-card';
  button.dataset.routine = routine.id;
  button.type = 'button';
  button.disabled = viewingPreviousDay;
  button.setAttribute('aria-pressed', String(Boolean(completedAt)));
  const icon = document.createElement('span');
  icon.className = `routine-icon routine-icon-${routine.icon || ['sunrise', 'spark', 'moon', 'drop'][index % 4]}`;
  icon.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span');
  copy.className = 'meal-copy';
  const name = document.createElement('strong');
  name.textContent = routine.name;
  const detail = document.createElement('small');
  detail.textContent = completedAt
    ? `Completed at ${formatFedTime(completedAt)}`
    : viewingPreviousDay ? 'Not completed' : `${formatTime(routine.time)}${routine.note ? ` · ${routine.note}` : ''}`;
  copy.append(name, detail);
  const check = document.createElement('span');
  check.className = 'meal-check';
  check.setAttribute('aria-hidden', 'true');
  button.append(icon, copy, check);
  button.classList.toggle('is-done', Boolean(completedAt));
  button.classList.toggle('is-history', viewingPreviousDay);
  return button;
}

function renderReminderList() {
  const list = $('#reminder-list');
  list.replaceChildren();
  currentRoutines().forEach((routine) => {
    const row = document.createElement('div');
    row.className = 'reminder-row';
    const name = document.createElement('label');
    name.className = 'reminder-name';
    const strong = document.createElement('strong');
    strong.textContent = routine.name;
    const small = document.createElement('small');
    small.textContent = 'Reminder time';
    name.append(strong, small);
    const switchLabel = document.createElement('label');
    switchLabel.className = 'reminder-switch';
    const enabled = document.createElement('input');
    enabled.className = 'reminder-enabled';
    enabled.dataset.reminderEnabled = routine.id;
    enabled.type = 'checkbox';
    enabled.checked = true;
    enabled.setAttribute('aria-label', `${routine.name} reminders`);
    const switchTrack = document.createElement('span');
    switchTrack.className = 'switch';
    switchTrack.setAttribute('aria-hidden', 'true');
    switchLabel.append(enabled, switchTrack);
    const time = document.createElement('input');
    time.className = 'reminder-time';
    time.dataset.reminder = routine.id;
    time.type = 'time';
    time.value = routine.time;
    time.setAttribute('aria-label', `${routine.name} reminder time`);
    row.append(name, switchLabel, time);
    list.append(row);
  });
  const extraRow = document.createElement('div');
  extraRow.className = 'reminder-row reminder-row-full';
  extraRow.innerHTML = '<label class="reminder-name" for="extra-reminders"><strong>Extra reminders</strong><small>Nudge every 10 minutes until completed</small></label><label class="reminder-switch"><input id="extra-reminders" data-extra-reminders type="checkbox" aria-label="Extra reminders"><span class="switch" aria-hidden="true"></span></label>';
  list.append(extraRow);
}

function render() {
  renderCategoryNav();
  const category = currentCategory();
  if (!category) return;
  if (viewingPreviousDay && !state.previousDay) viewingPreviousDay = false;
  const routines = category.routines || [];
  const displayedItems = viewingPreviousDay ? (state.previousDay?.items || {}) : (state.items || {});
  const complete = routines.filter((routine) => displayedItems[routine.id] && displayedItems[routine.id].completedAt).length;
  const missing = routines.length - complete;
  const percent = routines.length ? `${Math.round((complete / routines.length) * 100)}%` : '0%';
  const nextRoutine = routines.find((routine) => !displayedItems[routine.id] || !displayedItems[routine.id].completedAt);
  $('#day-title').textContent = formatDay(viewingPreviousDay ? state.previousDay?.dayKey : state.dayKey);
  $('#day-kicker').textContent = viewingPreviousDay ? "YESTERDAY'S HISTORY" : "TODAY'S CHECK-IN";
  $('#day-detail').textContent = viewingPreviousDay
    ? 'This routine history is read-only.'
    : `Routine items reset every day at ${formatTime(`${String(config.resetHour).padStart(2, '0')}:00`)}.`;
  $('#progress-number').textContent = complete;
  $('#progress-total').textContent = routines.length;
  $('#progress-label').textContent = `${complete} of ${routines.length} routine item${complete === 1 ? '' : 's'} completed`;
  $('#progress-bar').style.width = percent;
  $('#next-routine').textContent = viewingPreviousDay
    ? missing === 0 ? 'Everything was covered' : `${missing} item${missing === 1 ? '' : 's'} not completed`
    : nextRoutine ? `Next: ${nextRoutine.name}` : 'All routines covered';
  $('#encouragement-text').textContent = viewingPreviousDay
    ? complete === routines.length ? 'Everything was completed that day.' : `${complete} of ${routines.length} routine items were completed that day.`
    : complete === routines.length ? 'All done. You showed up for yourself.' : complete === 0 ? 'A little consistency goes a long way.' : `${missing} routine item${missing === 1 ? '' : 's'} left for today.`;
  $('#day-card').classList.toggle('is-history', viewingPreviousDay);
  $('#day-card').setAttribute('aria-label', viewingPreviousDay ? 'Previous routine day history' : 'Current routine day');
  $('#day-view-label').textContent = viewingPreviousDay ? 'Yesterday' : 'Today';
  $('#day-swipe-hint').textContent = viewingPreviousDay ? 'Swipe left to return to today' : state.previousDay ? 'Swipe right for yesterday' : 'History starts after the next reset';
  $('#previous-day-button').disabled = viewingPreviousDay || !state.previousDay;
  $('#current-day-button').disabled = !viewingPreviousDay;
  $('#routine-title').textContent = viewingPreviousDay ? "Yesterday's routine" : 'Today';
  $('#meal-action-note').textContent = viewingPreviousDay ? 'Read only' : 'Tap to complete';
  $('#tap-hint').textContent = viewingPreviousDay ? 'Swipe the day card left to return to today.' : 'Tap a completed item again if you need to undo it.';
  $('#routine-list').replaceChildren(...routines.map((routine, index) => makeRoutineCard(routine, index, displayedItems)));
  renderReminderList();
  applyCurrentCategorySettings();
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

async function refreshState(showError = true) {
  try {
    const category = currentCategory();
    if (!category) return;
    state = await api(`/api/state?category=${encodeURIComponent(category.id)}`);
    activeCategoryId = state.category.id;
    saveCachedState();
    render();
  } catch {
    if (showError) showToast('Showing the last saved check-in.');
  }
}

async function loadCategory(categoryId, showError = true) {
  try {
    const fallback = config.categories[0];
    const requestedId = categoryId || fallback?.id;
    if (!requestedId) return;
    state = await api(`/api/state?category=${encodeURIComponent(requestedId)}`);
    activeCategoryId = state.category.id;
    saveSettings({ ...readSettings(), activeCategoryId });
    saveCachedState();
    render();
    renderAdminEditor();
    if (pushSubscription) {
      pushServerRegistered = false;
      syncPushSettings().then(() => { pushServerRegistered = true; updatePushUi(''); }).catch(() => {});
    }
  } catch (error) {
    if (showError) showToast(error.message);
  }
}

async function switchCategory(offset) {
  const list = categories();
  if (list.length < 2) return;
  const currentIndex = Math.max(0, list.findIndex((category) => category.id === currentCategory()?.id));
  const nextIndex = (currentIndex + offset + list.length) % list.length;
  adminCategoryId = list[nextIndex].id;
  await loadCategory(list[nextIndex].id);
}

async function toggleRoutine(button) {
  if (viewingPreviousDay || button.disabled) return;
  const routineId = button.dataset.routine;
  const category = currentCategory();
  button.classList.add('is-pending');
  try {
    state = await api(`/api/routines/${encodeURIComponent(routineId)}?category=${encodeURIComponent(category.id)}`, { method: 'POST' });
    saveCachedState();
    render();
    const routine = category.routines.find((candidate) => candidate.id === routineId);
    const completed = state.items[routineId] && state.items[routineId].completedAt;
    showToast(completed ? `${routine.name} completed.` : `${routine.name} marked open again.`);
  } catch {
    showToast('Could not save that check-in. Try again.');
  } finally {
    button.classList.remove('is-pending');
  }
}

function base64ToBytes(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const rawData = window.atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...rawData].map((character) => character.charCodeAt(0)));
}

function canUsePush() {
  return config.pushAvailable && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

function pushPayload() {
  return {
    subscription: pushSubscription.toJSON(),
    categoryId: currentCategory().id,
    schedule: getSchedule(),
    enabled: getReminderEnabled(),
    extraReminders: getExtraReminders(),
  };
}

function syncPushSettings() {
  const payload = pushPayload();
  const sync = pushSyncChain.catch(() => {}).then(() => api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(payload) }));
  pushSyncChain = sync;
  return sync;
}

function updatePushUi(message = '') {
  const status = $('#push-status');
  const button = $('#notifications-button');
  const feedback = $('#push-feedback');
  const registered = config.pushAvailable && Boolean(pushSubscription) && pushServerRegistered;
  const enabled = registered && hasEnabledReminder(syncedReminderEnabled || getReminderEnabled());
  status.textContent = enabled ? 'On' : 'Off';
  status.classList.toggle('is-on', enabled);
  if (!config.pushAvailable) button.textContent = 'Push not configured on server';
  else if (registered && enabled) button.textContent = 'Notifications are on';
  else if (registered) button.textContent = 'Notifications are ready';
  else button.textContent = 'Turn on notifications';
  button.disabled = pushBusy || registered || !config.pushAvailable;
  feedback.textContent = message;
}

async function savePushSettings() {
  saveCurrentCategorySettings();
  const enabled = getReminderEnabled();
  if (!pushSubscription) {
    updatePushUi(hasEnabledReminder(enabled) ? 'Turn on notifications to receive reminders.' : 'Reminders are off on this app.');
    return;
  }
  try {
    await syncPushSettings();
    pushServerRegistered = true;
    syncedReminderEnabled = enabled;
    updatePushUi(hasEnabledReminder(enabled) ? 'Reminder settings saved for this category.' : 'Reminders paused for this category.');
  } catch (error) {
    updatePushUi(error.message);
  }
}

async function enablePush() {
  if (pushBusy) return;
  if (!config.pushAvailable) return updatePushUi('The server has no VAPID keys. Configure them, then restart the Daily Care server.');
  if (!canUsePush()) return updatePushUi('This browser cannot receive push notifications. On iPhone, add Daily Care to the Home Screen first.');
  pushBusy = true;
  updatePushUi('Requesting notification permission...');
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser/site settings.');
    const registration = serviceWorkerRegistration || await withTimeout(navigator.serviceWorker.ready, 10_000, 'The service worker did not become ready. Reload the app and try again.');
    serviceWorkerRegistration = registration;
    pushSubscription = await withTimeout(registration.pushManager.getSubscription(), 5_000, 'Chrome could not read its existing push subscription.');
    if (!pushSubscription) {
      const applicationServerKey = base64ToBytes(config.vapidPublicKey);
      if (applicationServerKey.byteLength !== 65) throw new Error('The server returned an invalid VAPID public key.');
      pushSubscription = await withTimeout(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }), 20_000, 'Chrome could not connect to its push service within 20 seconds.');
    }
    saveCurrentCategorySettings();
    updatePushUi('Saving this device on Daily Care...');
    await syncPushSettings();
    pushServerRegistered = true;
    syncedReminderEnabled = getReminderEnabled();
    updatePushUi(hasEnabledReminder(syncedReminderEnabled) ? 'Device registered. Reminders are on.' : 'Device registered. Choose an item to enable reminders.');
  } catch (error) {
    const detail = error && error.name ? `${error.name}: ${error.message}` : error.message || 'Could not register for push.';
    updatePushUi(`Registration failed: ${detail}`);
  } finally {
    pushBusy = false;
    updatePushUi($('#push-feedback').textContent);
  }
}

function setupInstallPrompt() {
  const button = $('#install-button');
  const feedback = $('#install-feedback');
  const installBlock = $('#install-block');
  const installDivider = $('#install-divider');
  const isIos = isIosDevice();
  const isAndroid = /android/i.test(window.navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const hideInstallArea = () => { installBlock.hidden = true; installDivider.hidden = true; };
  if (isStandalone) return hideInstallArea();
  button.hidden = false;
  if (isIos) {
    feedback.textContent = 'On iPhone: tap Share, then Add to Home Screen. Notifications work after you open the installed app.';
    feedback.hidden = false;
  }
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; button.hidden = false; });
  window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; hideInstallArea(); });
  if ('getInstalledRelatedApps' in navigator) navigator.getInstalledRelatedApps().then((apps) => { if (apps.some((app) => app.platform === 'webapp')) hideInstallArea(); }).catch(() => {});
  button.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (choice.outcome === 'accepted') button.hidden = true;
      return;
    }
    feedback.textContent = isIos ? 'On iPhone: tap Share, then Add to Home Screen.' : isAndroid ? "Open Chrome's three-dot menu and choose Install app or Add to home screen." : 'Open your browser menu and choose Install app or Add to home screen.';
    feedback.hidden = false;
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return updatePushUi('This browser does not support service workers.');
  try {
    await withTimeout(navigator.serviceWorker.register('/sw.js?v=1', { updateViaCache: 'none' }), 10_000, 'Service worker registration timed out.');
    serviceWorkerRegistration = await withTimeout(navigator.serviceWorker.ready, 10_000, 'Service worker activation timed out.');
    if ('PushManager' in window) pushSubscription = await withTimeout(serviceWorkerRegistration.pushManager.getSubscription(), 5_000, 'Could not check the device push subscription.');
    applyCurrentCategorySettings();
    if (pushSubscription && config.pushAvailable) {
      const enabled = getReminderEnabled();
      await syncPushSettings();
      pushServerRegistered = true;
      syncedReminderEnabled = enabled;
    }
    updatePushUi('');
  } catch (error) {
    updatePushUi(`Service worker error: ${error.message}`);
  }
}

function setDayView(previous) {
  if (previous && !state.previousDay) {
    showToast('Previous-day history will appear after the next daily reset.');
    return;
  }
  if (viewingPreviousDay === previous) return;
  viewingPreviousDay = previous;
  render();
}

function setupDaySwipe() {
  const card = $('#day-card');
  let startX = null;
  let startY = null;
  card.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
  }, { passive: true });
  card.addEventListener('touchend', (event) => {
    if (startX === null || !event.changedTouches.length) return;
    const deltaX = event.changedTouches[0].clientX - startX;
    const deltaY = event.changedTouches[0].clientY - startY;
    startX = null;
    startY = null;
    if (Math.abs(deltaX) < 45 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
    setDayView(deltaX > 0);
  }, { passive: true });
  card.addEventListener('keydown', (event) => { if (event.key === 'ArrowLeft') setDayView(true); if (event.key === 'ArrowRight') setDayView(false); });
  $('#previous-day-button').addEventListener('click', () => setDayView(true));
  $('#current-day-button').addEventListener('click', () => setDayView(false));
}

function setupCategorySwipe() {
  const bar = $('#category-bar');
  let startX = null;
  let startY = null;
  bar.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
  }, { passive: true });
  bar.addEventListener('touchend', (event) => {
    if (startX === null || !event.changedTouches.length) return;
    const deltaX = event.changedTouches[0].clientX - startX;
    const deltaY = event.changedTouches[0].clientY - startY;
    startX = null;
    startY = null;
    if (Math.abs(deltaX) < 45 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
    switchCategory(deltaX < 0 ? 1 : -1);
  }, { passive: true });
  bar.addEventListener('keydown', (event) => { if (event.key === 'ArrowLeft') switchCategory(-1); if (event.key === 'ArrowRight') switchCategory(1); });
  $('#previous-category-button').addEventListener('click', () => switchCategory(-1));
  $('#next-category-button').addEventListener('click', () => switchCategory(1));
}

function setExpandable(toggle, content, shell = $('.app-shell')) {
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!expanded));
  content.hidden = expanded;
  if (toggle.id === 'settings-toggle') document.documentElement.classList.toggle('settings-open', !expanded);
  if (expanded) shell.scrollTop = 0;
}

function renderAdminEditor() {
  const select = $('#admin-category-select');
  const list = categories();
  select.replaceChildren();
  list.forEach((category) => {
    const option = document.createElement('option');
    option.value = category.id;
    option.textContent = category.name;
    select.append(option);
  });
  const category = list.find((candidate) => candidate.id === adminCategoryId) || currentCategory();
  if (!adminCategoryId && category) adminCategoryId = category.id;
  if (adminCategoryId && list.some((candidate) => candidate.id === adminCategoryId)) select.value = adminCategoryId;
  if (category && adminCategoryId === category.id) {
    $('#admin-category-name').value = category.name;
    adminDraftRoutines = category.routines.map((routine) => ({ ...routine }));
  }
  $('#delete-category-button').disabled = list.length <= 1 || !adminCategoryId;
  renderAdminRoutineRows();
}

function renderAdminRoutineRows() {
  const list = $('#admin-routine-list');
  list.replaceChildren();
  adminDraftRoutines.forEach((routine, index) => {
    const row = document.createElement('div');
    row.className = 'admin-routine-row';
    row.dataset.index = index;
    const name = document.createElement('input');
    name.className = 'admin-input admin-routine-name';
    name.dataset.field = 'name';
    name.type = 'text';
    name.maxLength = 80;
    name.value = routine.name || '';
    name.placeholder = 'Morning';
    const time = document.createElement('input');
    time.className = 'admin-input admin-routine-time';
    time.dataset.field = 'time';
    time.type = 'time';
    time.value = routine.time || '09:00';
    const note = document.createElement('input');
    note.className = 'admin-input admin-routine-note';
    note.dataset.field = 'note';
    note.type = 'text';
    note.maxLength = 120;
    note.value = routine.note || '';
    note.placeholder = 'Optional note';
    const remove = document.createElement('button');
    remove.className = 'remove-routine-button';
    remove.type = 'button';
    remove.dataset.removeRoutine = index;
    remove.setAttribute('aria-label', `Remove ${routine.name || 'routine item'}`);
    remove.textContent = '×';
    row.append(name, time, note, remove);
    list.append(row);
  });
}

function startNewCategory() {
  adminCategoryId = null;
  adminDraftRoutines = [{ id: `new-${Date.now()}`, name: 'Morning', time: '08:00', note: '', icon: 'sunrise' }];
  $('#admin-category-name').value = '';
  $('#admin-category-select').value = '';
  $('#delete-category-button').disabled = true;
  renderAdminRoutineRows();
  const toggle = $('#admin-toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') setExpandable(toggle, $('#admin-content'));
  $('#admin-category-name').focus();
}

async function saveCategory() {
  const name = $('#admin-category-name').value.trim();
  const routines = adminDraftRoutines.map((routine) => ({ ...routine, name: String(routine.name || '').trim(), note: String(routine.note || '').trim() }));
  if (!name) return $('#admin-feedback').textContent = 'Give this category a name first.';
  if (routines.some((routine) => !routine.name || !routine.time)) return $('#admin-feedback').textContent = 'Every routine item needs a name and time.';
  $('#save-category-button').disabled = true;
  $('#admin-feedback').textContent = 'Saving category...';
  try {
    const endpoint = adminCategoryId ? `/api/admin/categories/${encodeURIComponent(adminCategoryId)}` : '/api/admin/categories';
    const result = await api(endpoint, { method: adminCategoryId ? 'PUT' : 'POST', body: JSON.stringify({ name, routines }) });
    config.categories = result.categories;
    state.categories = result.categories;
    const savedId = result.category?.id || adminCategoryId;
    adminCategoryId = savedId;
    activeCategoryId = savedId;
    await loadCategory(savedId, false);
    $('#admin-feedback').textContent = 'Category saved.';
    showToast(`${name} is ready to use.`);
  } catch (error) {
    $('#admin-feedback').textContent = error.message;
  } finally {
    $('#save-category-button').disabled = false;
  }
}

async function deleteCategory() {
  if (!adminCategoryId || categories().length <= 1) return;
  const category = categories().find((candidate) => candidate.id === adminCategoryId);
  if (!window.confirm(`Delete ${category.name}? Its check-in history will be removed.`)) return;
  try {
    const result = await api(`/api/admin/categories/${encodeURIComponent(adminCategoryId)}`, { method: 'DELETE' });
    config.categories = result.categories;
    state.categories = result.categories;
    adminCategoryId = result.categories[0].id;
    await loadCategory(activeCategoryId === category.id ? adminCategoryId : activeCategoryId, false);
    renderAdminEditor();
    showToast(`${category.name} deleted.`);
  } catch (error) {
    $('#admin-feedback').textContent = error.message;
  }
}

function wireUi() {
  $('#routine-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-routine]');
    if (button) toggleRoutine(button);
  });
  $('#settings-toggle').addEventListener('click', () => setExpandable($('#settings-toggle'), $('#settings-content')));
  $('#admin-toggle').addEventListener('click', () => setExpandable($('#admin-toggle'), $('#admin-content')));
  $('#notifications-button').addEventListener('click', enablePush);
  $('#reminder-list').addEventListener('change', (event) => {
    if (event.target.matches('.reminder-enabled, .reminder-time, [data-extra-reminders]')) savePushSettings();
  });
  $('#admin-category-select').addEventListener('change', (event) => {
    adminCategoryId = event.target.value;
    renderAdminEditor();
  });
  $('#admin-category-name').addEventListener('input', () => { $('#admin-feedback').textContent = ''; });
  $('#admin-routine-list').addEventListener('input', (event) => {
    const row = event.target.closest('.admin-routine-row');
    if (!row || !event.target.dataset.field) return;
    adminDraftRoutines[Number(row.dataset.index)][event.target.dataset.field] = event.target.value;
  });
  $('#admin-routine-list').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-routine]');
    if (!remove) return;
    if (adminDraftRoutines.length <= 1) return $('#admin-feedback').textContent = 'Keep at least one routine item.';
    adminDraftRoutines.splice(Number(remove.dataset.removeRoutine), 1);
    renderAdminRoutineRows();
  });
  $('#new-category-button').addEventListener('click', startNewCategory);
  $('#add-routine-button').addEventListener('click', () => {
    adminDraftRoutines.push({ id: `new-${Date.now()}`, name: '', time: '09:00', note: '', icon: 'spark' });
    renderAdminRoutineRows();
    $('#admin-routine-list .admin-routine-name:last-of-type')?.focus();
  });
  $('#save-category-button').addEventListener('click', saveCategory);
  $('#delete-category-button').addEventListener('click', deleteCategory);
  setupDaySwipe();
  setupCategorySwipe();
}

async function init() {
  if (isIosDevice()) document.documentElement.classList.add('is-ios');
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
    document.documentElement.classList.add('is-standalone');
    $('.app-shell').scrollTop = 0;
  }
  loadCachedState();
  activeCategoryId = new URLSearchParams(window.location.search).get('category') || readSettings().activeCategoryId || state.category?.id;
  render();
  wireUi();
  setupInstallPrompt();
  try {
    config = await api('/api/config');
    $('#timezone-label').textContent = config.timezone;
    $('#reset-time-label').textContent = formatTime(`${String(config.resetHour).padStart(2, '0')}:00`);
    const requested = activeCategoryId && config.categories.some((category) => category.id === activeCategoryId) ? activeCategoryId : config.categories[0]?.id;
    await loadCategory(requested, false);
    renderAdminEditor();
    updatePushUi('');
  } catch {
    $('#timezone-label').textContent = 'local preview';
    render();
  }
  await registerServiceWorker();
  await refreshState(false);
  setInterval(() => refreshState(false), 60_000);
}

init();
