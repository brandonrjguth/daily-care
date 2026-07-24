const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const webpush = require('web-push');

const PORT = Number(process.env.PORT || 3005);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const RESET_HOUR = Number(process.env.RESET_HOUR || 5);
const DEFAULT_SCHEDULE = {
  morning: process.env.DEFAULT_MORNING_TIME || '08:00',
  midday: process.env.DEFAULT_MIDDAY_TIME || '13:00',
  evening: process.env.DEFAULT_EVENING_TIME || '21:00',
};
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:dailycare@localhost';

if (!Number.isInteger(RESET_HOUR) || RESET_HOUR < 0 || RESET_HOUR > 23) {
  throw new Error('RESET_HOUR must be an integer from 0 through 23.');
}

let timezone = process.env.APP_TIMEZONE || 'UTC';
try {
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
} catch {
  timezone = 'UTC';
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const DEFAULT_CATEGORIES = [
  {
    id: 'creatine-reminder',
    name: 'Creatine Reminder',
    routines: [
      { id: 'morning', name: 'Morning', time: '08:00', note: 'Start with breakfast', icon: 'sunrise' },
      { id: 'midday', name: 'Midday', time: '13:00', note: 'Keep your routine going', icon: 'spark' },
      { id: 'evening', name: 'Night', time: '21:00', note: 'Wind down before bed', icon: 'moon' },
    ],
  },
  {
    id: 'medication-reminder',
    name: 'Medication Reminder',
    routines: [
      { id: 'morning', name: 'Morning dose', time: '08:00', note: 'Take with water', icon: 'sunrise' },
      { id: 'before-bed', name: 'Before bed', time: '21:30', note: 'Close out the day', icon: 'moon' },
    ],
  },
];

let store = null;
let writeChain = Promise.resolve();

function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'routine';
}

function validTime(value, fallback = '09:00') {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function cleanName(value, fallback) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  return name || fallback;
}

function cleanNote(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
}

function cleanIcon(value, fallback = 'spark') {
  return ['sunrise', 'spark', 'moon', 'drop'].includes(value) ? value : fallback;
}

function cleanRoutine(raw, index, usedIds = new Set()) {
  const name = cleanName(raw && raw.name, `Routine ${index + 1}`);
  const requestedId = typeof (raw && raw.id) === 'string' ? slugify(raw.id) : slugify(name);
  let id = requestedId || `routine-${index + 1}`;
  let suffix = 2;
  while (usedIds.has(id)) id = `${requestedId}-${suffix++}`;
  usedIds.add(id);
  return {
    id,
    name,
    time: validTime(raw && raw.time, Object.values(DEFAULT_SCHEDULE)[index] || '09:00'),
    note: cleanNote(raw && raw.note),
    icon: cleanIcon(raw && raw.icon, ['sunrise', 'spark', 'moon', 'drop'][index % 4]),
  };
}

function cleanRoutinesWithUniqueIds(rawRoutines) {
  const source = Array.isArray(rawRoutines) ? rawRoutines.slice(0, 20) : [];
  const usedIds = new Set();
  return source.map((routine, index) => cleanRoutine(routine, index, usedIds));
}

function emptyItems(routines) {
  return Object.fromEntries(routines.map((routine) => [routine.id, { completedAt: null }]));
}

function normalizeItems(rawItems, routines) {
  const items = emptyItems(routines);
  for (const routine of routines) {
    const completedAt = rawItems && rawItems[routine.id] && rawItems[routine.id].completedAt;
    items[routine.id].completedAt = typeof completedAt === 'string' ? completedAt : null;
  }
  return items;
}

function normalizeCategory(raw, fallback) {
  const routines = cleanRoutinesWithUniqueIds(raw && raw.routines && raw.routines.length ? raw.routines : fallback.routines);
  const id = slugify((raw && raw.id) || fallback.id);
  const recurrence = cleanRecurrence(raw && raw.recurrence, fallback.recurrence);
  return {
    id,
    name: cleanName(raw && raw.name, fallback.name),
    routines,
    recurrence,
    weekday: cleanWeekday(raw && raw.weekday, fallback.weekday),
    dayKey: typeof (raw && raw.dayKey) === 'string' ? raw.dayKey : null,
    items: normalizeItems(raw && raw.items, routines),
    previousDay: raw && raw.previousDay && typeof raw.previousDay.dayKey === 'string'
      ? {
        dayKey: raw.previousDay.dayKey,
        items: normalizeItems(raw.previousDay.items, routines),
      }
      : null,
  };
}

function normalizeCategories(rawCategories) {
  const source = Array.isArray(rawCategories) && rawCategories.length ? rawCategories : DEFAULT_CATEGORIES;
  const usedIds = new Set();
  return source.slice(0, 30).map((raw, index) => {
    const fallback = DEFAULT_CATEGORIES[index] || {
      id: `category-${index + 1}`,
      name: `Routine ${index + 1}`,
      routines: [{ id: 'routine-1', name: 'First routine', time: '09:00', note: '', icon: 'spark' }],
      recurrence: 'daily',
      weekday: 1,
    };
    const category = normalizeCategory(raw, fallback);
    let id = category.id;
    let suffix = 2;
    while (usedIds.has(id)) id = `${category.id}-${suffix++}`;
    category.id = id;
    usedIds.add(id);
    return category;
  });
}

function cleanEnabled(enabled, routines) {
  const defaultEnabled = typeof enabled === 'boolean' ? enabled : true;
  return Object.fromEntries(routines.map((routine) => [
    routine.id,
    enabled && typeof enabled === 'object' && typeof enabled[routine.id] === 'boolean'
      ? enabled[routine.id]
      : defaultEnabled,
  ]));
}

function cleanSchedule(schedule, routines) {
  return Object.fromEntries(routines.map((routine, index) => [
    routine.id,
    validTime(schedule && schedule[routine.id], routine.time || Object.values(DEFAULT_SCHEDULE)[index] || '09:00'),
  ]));
}

function cleanExtraReminders(value) {
  return value === true;
}

function cleanRecurrence(value, fallback = 'daily') {
  if (value === 'weekly' || value === 'daily') return value;
  return fallback === 'weekly' ? 'weekly' : 'daily';
}

function cleanWeekday(value, fallback = 1) {
  if (value === null || value === undefined || value === '') return cleanWeekdayFallback(fallback);
  const weekday = Number(value);
  return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
    ? weekday : cleanWeekdayFallback(fallback);
}

function cleanWeekdayFallback(value) {
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 1;
}

function cleanLastRemindedEntry(value) {
  if (typeof value === 'string') return { day: value, at: null, firstAt: null };
  if (value && typeof value === 'object') {
    const day = typeof value.day === 'string' ? value.day : null;
    const at = typeof value.at === 'string' ? value.at : null;
    const firstAt = typeof value.firstAt === 'string' ? value.firstAt : null;
    if (day || at || firstAt) return { day, at, firstAt };
  }
  return null;
}

function cleanLastReminded(value, routines) {
  const result = {};
  if (value && typeof value === 'object') {
    for (const routine of routines) {
      const cleaned = cleanLastRemindedEntry(value[routine.id]);
      if (cleaned) result[routine.id] = cleaned;
    }
  }
  return result;
}

function normalizeSubscription(raw, categories) {
  if (!raw || !raw.subscription || typeof raw.subscription.endpoint !== 'string') return null;
  const rawCategories = raw.categories && typeof raw.categories === 'object' ? raw.categories : {};
  const categorySettings = {};
  for (const category of categories) {
    const saved = rawCategories[category.id] || (raw.categoryId === category.id ? raw : null) || {};
    categorySettings[category.id] = {
      schedule: cleanSchedule(saved.schedule, category.routines),
      enabled: cleanEnabled(saved.enabled, category.routines),
      extraReminders: cleanExtraReminders(saved.extraReminders),
      lastReminded: cleanLastReminded(saved.lastReminded, category.routines),
    };
  }
  return { subscription: raw.subscription, categories: categorySettings };
}

function normalizeStore(raw) {
  const categories = normalizeCategories(raw && raw.categories);
  const subscriptions = Array.isArray(raw && raw.subscriptions)
    ? raw.subscriptions.map((entry) => normalizeSubscription(entry, categories)).filter(Boolean)
    : [];
  return { categories, subscriptions };
}

async function loadStore() {
  try {
    const raw = JSON.parse(await fs.readFile(STORE_PATH, 'utf8'));
    store = normalizeStore(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read saved state:', error.message);
    store = normalizeStore({});
  }
  await ensureCurrentDay();
}

function persist() {
  const snapshot = JSON.stringify(store, null, 2);
  const write = writeChain.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temporaryPath = `${STORE_PATH}.tmp`;
    await fs.writeFile(temporaryPath, snapshot, 'utf8');
    await fs.rename(temporaryPath, STORE_PATH);
  });
  writeChain = write.catch(() => {});
  return write;
}

function zonedNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute) };
}

function operationalDayKey(moment = zonedNow()) {
  const date = new Date(Date.UTC(moment.year, moment.month - 1, moment.day));
  if (moment.hour < RESET_HOUR) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function operationalMinute(hour, minute) {
  return (hour * 60 + minute - RESET_HOUR * 60 + 1440) % 1440;
}

function previousDayKey(dayKey) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function weeklyOccurrenceKey(dayKey, weekday) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  const daysSinceOccurrence = (date.getUTCDay() - cleanWeekday(weekday) + 7) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceOccurrence);
  return date.toISOString().slice(0, 10);
}

function categoryCycleKey(category, now = new Date()) {
  const operationalKey = operationalDayKey(zonedNow(now));
  return category.recurrence === 'weekly'
    ? weeklyOccurrenceKey(operationalKey, category.weekday)
    : operationalKey;
}

function previousWeeklyOccurrenceKey(cycleKey) {
  const date = new Date(`${cycleKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString().slice(0, 10);
}

function previousCycleKey(category, cycleKey) {
  return category.recurrence === 'weekly' ? previousWeeklyOccurrenceKey(cycleKey) : previousDayKey(cycleKey);
}

async function ensureCurrentDay(now = new Date()) {
  let changed = false;
  for (const category of store.categories) {
    const dayKey = categoryCycleKey(category, now);
    if (category.dayKey === dayKey) continue;
    category.previousDay = category.dayKey === previousCycleKey(category, dayKey)
      ? { dayKey: category.dayKey, items: normalizeItems(category.items, category.routines) }
      : null;
    category.dayKey = dayKey;
    category.items = emptyItems(category.routines);
    changed = true;
  }
  if (changed) await persist();
}

function categorySummary(category) {
  return {
    id: category.id,
    name: category.name,
    routines: category.routines,
    recurrence: category.recurrence,
    weekday: category.weekday,
  };
}

function publicState(category) {
  return {
    category: categorySummary(category),
    categories: store.categories.map(categorySummary),
    dayKey: category.dayKey,
    items: category.items,
    previousDay: category.previousDay,
    timezone,
    resetHour: RESET_HOUR,
    serverNow: new Date().toISOString(),
  };
}

function getCategory(id) {
  return store.categories.find((category) => category.id === id) || store.categories[0];
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, status, body, contentType) {
  response.writeHead(status, {
    'Content-Type': contentType, 'Cache-Control': contentType.includes('text/html') ? 'no-cache' : 'public, max-age=3600', 'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Request body must be valid JSON')); }
    });
    request.on('error', reject);
  });
}

function subscriptionIndex(endpoint) {
  return store.subscriptions.findIndex((entry) => entry.subscription.endpoint === endpoint);
}

function categoryFromRequest(url) {
  return getCategory(url.searchParams.get('category'));
}

function updateCategoryFromInput(category, body) {
  const name = cleanName(body && body.name, 'Untitled routine');
  const routines = cleanRoutinesWithUniqueIds(body && body.routines);
  if (!routines.length) throw new Error('Add at least one routine item.');
  const oldItems = category.items;
  const oldPrevious = category.previousDay;
  const recurrence = cleanRecurrence(body && body.recurrence, category.recurrence);
  const weekday = cleanWeekday(body && body.weekday, category.weekday);
  const cycleChanged = recurrence !== category.recurrence || (recurrence === 'weekly' && weekday !== category.weekday);
  category.name = name;
  category.routines = routines;
  category.recurrence = recurrence;
  category.weekday = weekday;
  category.items = normalizeItems(oldItems, routines);
  category.dayKey = cycleChanged ? null : category.dayKey;
  category.previousDay = !cycleChanged && oldPrevious
    ? { dayKey: oldPrevious.dayKey, items: normalizeItems(oldPrevious.items, routines) }
    : null;
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(response, 200, {
      timezone,
      resetHour: RESET_HOUR,
      pushAvailable: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
      vapidPublicKey: VAPID_PUBLIC_KEY || null,
      categories: store.categories.map(categorySummary),
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    await ensureCurrentDay();
    return sendJson(response, 200, publicState(categoryFromRequest(url)));
  }

  const routineMatch = url.pathname.match(/^\/api\/routines\/([^/]+)$/);
  if (request.method === 'POST' && routineMatch) {
    await ensureCurrentDay();
    const category = categoryFromRequest(url);
    const routineId = decodeURIComponent(routineMatch[1]);
    const routine = category.routines.find((candidate) => candidate.id === routineId);
    if (!routine) return sendJson(response, 404, { error: 'Routine not found.' });
    category.items[routine.id].completedAt = category.items[routine.id].completedAt ? null : new Date().toISOString();
    await persist();
    return sendJson(response, 200, publicState(category));
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/categories') {
    const body = await readJson(request);
    const name = cleanName(body.name, 'Untitled routine');
    const baseId = slugify(body.id || name);
    let id = baseId;
    let suffix = 2;
    while (store.categories.some((category) => category.id === id)) id = `${baseId}-${suffix++}`;
    const routines = cleanRoutinesWithUniqueIds(body.routines);
    if (!routines.length) return sendJson(response, 400, { error: 'Add at least one routine item.' });
    const category = {
      id,
      name,
      routines,
      recurrence: cleanRecurrence(body.recurrence),
      weekday: cleanWeekday(body.weekday),
      dayKey: null,
      items: emptyItems(routines),
      previousDay: null,
    };
    category.dayKey = categoryCycleKey(category);
    store.categories.push(category);
    await persist();
    return sendJson(response, 201, { category: categorySummary(category), categories: store.categories.map(categorySummary) });
  }

  const adminMatch = url.pathname.match(/^\/api\/admin\/categories\/([^/]+)$/);
  if (adminMatch && request.method === 'PUT') {
    const category = store.categories.find((candidate) => candidate.id === decodeURIComponent(adminMatch[1]));
    if (!category) return sendJson(response, 404, { error: 'Category not found.' });
    const body = await readJson(request);
    try { updateCategoryFromInput(category, body); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    await ensureCurrentDay();
    await persist();
    return sendJson(response, 200, { category: categorySummary(category), categories: store.categories.map(categorySummary) });
  }

  if (adminMatch && request.method === 'DELETE') {
    if (store.categories.length <= 1) return sendJson(response, 400, { error: 'Keep at least one category.' });
    const index = store.categories.findIndex((candidate) => candidate.id === decodeURIComponent(adminMatch[1]));
    if (index === -1) return sendJson(response, 404, { error: 'Category not found.' });
    store.categories.splice(index, 1);
    for (const entry of store.subscriptions) delete entry.categories[decodeURIComponent(adminMatch[1])];
    await persist();
    return sendJson(response, 200, { categories: store.categories.map(categorySummary) });
  }

  if (request.method === 'POST' && url.pathname === '/api/push/subscribe') {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return sendJson(response, 503, { error: 'Push reminders are not configured on the server.' });
    const body = await readJson(request);
    const category = getCategory(body.categoryId);
    const subscription = body.subscription;
    if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.keys || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string') {
      return sendJson(response, 400, { error: 'A valid push subscription is required.' });
    }
    const index = subscriptionIndex(subscription.endpoint);
    const entry = index === -1 ? { subscription, categories: {} } : store.subscriptions[index];
    entry.subscription = subscription;
    const old = entry.categories[category.id] || {};
    entry.categories[category.id] = {
      schedule: cleanSchedule(body.schedule, category.routines),
      enabled: cleanEnabled(body.enabled, category.routines),
      extraReminders: cleanExtraReminders(body.extraReminders),
      lastReminded: cleanLastReminded(old.lastReminded, category.routines),
    };
    if (index === -1) store.subscriptions.push(entry);
    await persist();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'DELETE' && url.pathname === '/api/push/subscribe') {
    const body = await readJson(request);
    if (typeof body.endpoint === 'string') {
      store.subscriptions = store.subscriptions.filter((entry) => entry.subscription.endpoint !== body.endpoint);
      await persist();
    }
    return sendJson(response, 200, { ok: true });
  }

  sendJson(response, 404, { error: 'Not found' });
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8', '.html': 'text/html; charset=utf-8',
};

async function serveFile(request, response, filePath, extension) {
  let stat;
  try { stat = await fs.stat(filePath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
  if (stat.isDirectory()) return null;
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    response.end();
    return true;
  }
  const body = await fs.readFile(filePath);
  response.writeHead(200, { 'Content-Type': MIME_TYPES[extension] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, 'Content-Length': Buffer.byteLength(body) });
  response.end(request.method === 'HEAD' ? undefined : body);
  return true;
}

async function serveStatic(request, response, pathname) {
  let relativePath;
  try { relativePath = decodeURIComponent(pathname); } catch { return sendText(response, 400, 'Bad request', 'text/plain; charset=utf-8'); }
  if (relativePath === '/') relativePath = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${relativePath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendText(response, 404, 'Not found', 'text/plain; charset=utf-8');
  const extension = path.extname(filePath);
  const served = await serveFile(request, response, filePath, extension);
  if (served) return;
  if (!extension) {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (await serveFile(request, response, indexPath, '.html')) return;
  }
  sendText(response, 404, 'Not found', 'text/plain; charset=utf-8');
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return sendText(response, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    await serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
  }
}

const NUDGE_INTERVAL_MS = 10 * 60 * 1000;

function reminderPayload(category, routine) {
  return {
    title: `${category.name}: ${routine.name}`,
    body: routine.note || `Your ${routine.name.toLowerCase()} routine is still waiting.`,
    categoryId: category.id,
    routineId: routine.id,
    url: `/?category=${encodeURIComponent(category.id)}`,
  };
}

function nudgePayload(category, routine, elapsedMinutes) {
  return {
    ...reminderPayload(category, routine),
    body: `${routine.name} has been open for ${elapsedMinutes} minute${elapsedMinutes === 1 ? '' : 's'}.`,
    nudge: true,
  };
}

async function deliver(entry, payload, label) {
  try {
    await webpush.sendNotification(entry.subscription, JSON.stringify(payload));
    return 'sent';
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      store.subscriptions = store.subscriptions.filter((candidate) => candidate !== entry);
      return 'gone';
    }
    console.error(`Could not send ${label}:`, error.message);
    return 'failed';
  }
}

async function sendDueReminders() {
  if (!store || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const now = new Date();
  await ensureCurrentDay(now);
  const current = zonedNow(now);
  const operationalKey = operationalDayKey(current);
  const currentMinutes = operationalMinute(current.hour, current.minute);
  let changed = false;

  outer: for (const entry of [...store.subscriptions]) {
    for (const category of store.categories) {
      const settings = entry.categories[category.id];
      if (!settings) continue;
      for (const routine of category.routines) {
        if (!settings.enabled[routine.id] || category.items[routine.id].completedAt) continue;
        const [hours, minutes] = (settings.schedule[routine.id] || routine.time).split(':').map(Number);
        if (currentMinutes < operationalMinute(hours, minutes)) continue;
        const record = settings.lastReminded[routine.id] || null;
        const remindedThisCycle = record && record.day === category.dayKey;
        if (!remindedThisCycle) {
          if (category.recurrence === 'weekly' && operationalKey !== category.dayKey) continue;
          const status = await deliver(entry, reminderPayload(category, routine), `${category.name} ${routine.name} reminder`);
          if (status === 'sent') {
            const stamp = now.toISOString();
            settings.lastReminded[routine.id] = { day: category.dayKey, at: stamp, firstAt: stamp };
            changed = true;
          } else if (status === 'gone') {
            changed = true;
            continue outer;
          }
          continue;
        }
        if (settings.extraReminders && remindedThisCycle && record && record.firstAt) {
          const lastAt = record.at ? new Date(record.at) : null;
          if (!lastAt || now - lastAt >= NUDGE_INTERVAL_MS) {
            const firstAt = new Date(record.firstAt);
            const elapsedMinutes = Math.max(1, Math.round((now - firstAt) / 60000));
            const status = await deliver(entry, nudgePayload(category, routine, elapsedMinutes), `${category.name} ${routine.name} nudge`);
            if (status === 'sent') {
              record.at = now.toISOString();
              changed = true;
            } else if (status === 'gone') {
              changed = true;
              continue outer;
            }
          }
        }
      }
    }
  }
  if (changed) await persist();
}

async function start() {
  await loadStore();
  const server = http.createServer(handleRequest);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Daily Care listening on http://127.0.0.1:${PORT}`);
    console.log(`Operational timezone: ${timezone}; routines reset at ${RESET_HOUR}:00`);
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) console.warn('Push reminders are disabled because VAPID keys are not configured.');
  });
  setInterval(() => sendDueReminders().catch((error) => console.error('Reminder scheduler error:', error)), 60_000);
  setTimeout(() => sendDueReminders().catch((error) => console.error('Reminder scheduler error:', error)), 5_000);
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Could not start Daily Care:', error);
    process.exit(1);
  });
}

module.exports = {
  categoryCycleKey,
  cleanEnabled,
  cleanExtraReminders,
  cleanLastReminded,
  cleanRecurrence,
  cleanWeekday,
  operationalDayKey,
  operationalMinute,
  previousWeeklyOccurrenceKey,
  weeklyOccurrenceKey,
};
