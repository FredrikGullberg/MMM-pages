const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');

let definition;
global.Module = { register: (name, value) => { definition = value; } };
global.Log = { log() {}, warn() {}, error() {}, debug() {} };
require('../../MMM-pages.js');

let instance;
let notifications;
let modules;

beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse('2026-10-27T10:00:00Z') });
  modules = ['page0', 'page1', 'page2', 'clock', 'MMM-page-indicator', 'admin'].map(name => ({
    name, identifier: name, hidden: false,
    hide() { this.hidden = true; }, show() { this.hidden = false; },
  }));
  global.MM = {
    getModules: () => ({
      enumerate: callback => modules.forEach(callback),
      withClass: classes => ({ enumerate: callback => modules.filter(module => classes.includes(module.name)).forEach(callback) }),
      exceptWithClass: classes => ({ enumerate: callback => modules.filter(module => !classes.includes(module.name)).forEach(callback) }),
    }),
  };
  notifications = [];
  instance = Object.create(definition);
  instance.identifier = 'pages';
  instance.config = {
    ...structuredClone(definition.defaults),
    modules: [['page0'], ['page1'], ['page2']],
    fixed: ['clock', 'MMM-page-indicator'],
    hiddenPages: { admin: ['admin'] },
    timings: { default: 20000, 0: 30000, 1: 12000, 2: 25000, admin: 1000000 },
    scheduleTimeZone: 'Europe/Stockholm',
  };
  instance.sendNotification = (name, payload) => notifications.push({ name, payload });
});

afterEach(() => {
  instance.clearTimers();
  clearTimeout(instance.scheduleTimer);
  clearTimeout(instance.pageAnimationTimer);
});

function start(pageSchedules) {
  instance.config.pageSchedules = pageSchedules;
  instance.start();
  instance.notificationReceived('DOM_OBJECTS_CREATED');
}

function last(name) {
  return notifications.filter(notification => notification.name === name).at(-1)?.payload;
}

test('no schedules preserve all pages, timings, home and public indices', () => {
  const original = structuredClone(instance.config);
  start({});
  assert.deepEqual(instance.config.modules, original.modules);
  assert.deepEqual(instance.config.timings, original.timings);
  instance.notificationReceived('PAGE_SELECT', 2);
  assert.equal(last('NEW_PAGE'), 2);
  assert.equal(instance.scheduleTimer, undefined);
});

test('from is inclusive and until is exclusive at Swedish midnight', () => {
  start({ 1: { from: '2026-11-07', until: '2026-11-09' } });
  assert.deepEqual(instance.activePageIndices, [0, 2]);
  instance.refreshScheduledPages(new Date('2026-11-06T22:59:59.999Z'));
  assert.deepEqual(instance.activePageIndices, [0, 2]);
  instance.refreshScheduledPages(new Date('2026-11-06T23:00:00Z'));
  assert.deepEqual(instance.activePageIndices, [0, 1, 2]);
  instance.refreshScheduledPages(new Date('2026-11-08T22:59:59.999Z'));
  assert.deepEqual(instance.activePageIndices, [0, 1, 2]);
  instance.refreshScheduledPages(new Date('2026-11-08T23:00:00Z'));
  assert.deepEqual(instance.activePageIndices, [0, 2]);
});

test('open-ended windows support only from or only until', () => {
  start({ 0: { until: '2026-10-27' }, 1: { from: '2026-10-28' } });
  assert.deepEqual(instance.activePageIndices, [2]);
  instance.refreshScheduledPages(new Date('2026-10-28T10:00:00Z'));
  assert.deepEqual(instance.activePageIndices, [1, 2]);
});

test('navigation, indicator clicks and queries use compact active indices', () => {
  start({ 1: { from: '2026-11-07' } });
  assert.equal(last('MAX_PAGES_CHANGED'), 2);
  instance.notificationReceived('PAGE_INCREMENT');
  assert.deepEqual(instance.config.modules[instance.curPage], ['page2']);
  assert.equal(last('NEW_PAGE'), 1);
  instance.notificationReceived('QUERY_PAGE_NUMBER');
  assert.equal(last('PAGE_NUMBER_IS'), 1);
  instance.notificationReceived('PAGE_INCREMENT');
  assert.equal(instance.curPage, 0);
  instance.notificationReceived('PAGE_DECREMENT');
  assert.equal(instance.curPage, 1);
  instance.notificationReceived('PAGE_SELECT', 0);
  assert.deepEqual(instance.config.modules[instance.curPage], ['page0']);
  instance.notificationReceived('PAGE_SELECT', 2);
  assert.equal(instance.curPage, 0);
  const api = last('REGISTER_API');
  assert.equal(api.actions.page1.payload, 1);
  assert.equal(api.actions.page2, undefined);
});

test('timings and home page follow original configured pages after filtering', () => {
  instance.config.homePage = 2;
  start({ 0: { until: '2026-10-27' } });
  assert.equal(instance.config.homePage, 1);
  assert.equal(instance.curPage, 1);
  assert.equal(instance.config.timings[0], 12000);
  assert.equal(instance.config.timings[1], 25000);
  assert.equal(instance.config.timings.admin, 1000000);
  instance.notificationReceived('PAGE_SELECT', 0);
  instance.notificationReceived('HOME_PAGE');
  assert.deepEqual(instance.config.modules[instance.curPage], ['page2']);
});

test('a missing home page falls back to the first active page', () => {
  start({ 0: { from: '2026-11-07' } });
  assert.equal(instance.curPage, 0);
  assert.deepEqual(instance.config.modules[0], ['page1']);
});

test('current content stays selected when a preceding page disappears', () => {
  start({ 0: { until: '2026-10-28' } });
  instance.notificationReceived('PAGE_SELECT', 2);
  instance.refreshScheduledPages(new Date('2026-10-28T10:00:00Z'));
  assert.equal(instance.curPage, 1);
  assert.deepEqual(instance.config.modules[instance.curPage], ['page2']);
  assert.equal(last('MAX_PAGES_CHANGED'), 2);
  assert.equal(last('NEW_PAGE'), 1);
});

test('current expired page is removed live at midnight, even with rotation paused', (t) => {
  t.mock.timers.setTime(Date.parse('2026-11-08T22:59:59Z'));
  start({ 2: { until: '2026-11-09' } });
  instance.notificationReceived('PAGE_SELECT', 2);
  instance.notificationReceived('PAUSE_ROTATION');
  t.mock.timers.tick(500);
  assert.equal(modules.find(module => module.name === 'page2').hidden, false);
  t.mock.timers.tick(1010);
  assert.deepEqual(instance.activePageIndices, [0, 1]);
  assert.equal(modules.find(module => module.name === 'page2').hidden, true);
  assert.equal(instance.rotationPaused, true);
  assert.equal(last('MAX_PAGES_CHANGED'), 2);
  assert.equal(last('NEW_PAGE'), 0);
});

test('all inactive pages show only fixed content and resume when a future window starts', (t) => {
  t.mock.timers.setTime(Date.parse('2026-11-06T22:59:59Z'));
  start({ 0: { from: '2026-11-07' }, 1: { from: '2026-11-07' }, 2: { from: '2026-11-07' } });
  t.mock.timers.tick(500);
  assert.deepEqual(instance.config.modules, []);
  assert.equal(last('MAX_PAGES_CHANGED'), 0);
  assert.equal(last('NEW_PAGE'), -1);
  assert.equal(modules.find(module => module.name === 'clock').hidden, false);
  assert.equal(modules.find(module => module.name === 'MMM-page-indicator').hidden, true);
  instance.notificationReceived('PAGE_INCREMENT');
  instance.notificationReceived('HOME_PAGE');
  assert.equal(Number.isNaN(instance.curPage), false);
  t.mock.timers.tick(1510);
  assert.deepEqual(instance.activePageIndices, [0, 1, 2]);
  assert.equal(last('MAX_PAGES_CHANGED'), 3);
  t.mock.timers.tick(500);
  assert.equal(modules.find(module => module.name === 'MMM-page-indicator').hidden, false);
  assert.equal(modules.find(module => module.name === 'page0').hidden, false);
  t.mock.timers.tick(30000);
  assert.equal(instance.curPage, 1);
});

test('changing windows does not interrupt a hidden page or its timeout', (t) => {
  start({ 0: { until: '2026-10-28' } });
  instance.notificationReceived('SHOW_HIDDEN_PAGE', 'admin');
  t.mock.timers.tick(500);
  const timer = instance.hiddenPageTimer;
  assert.equal(modules.find(module => module.name === 'admin').hidden, false);
  instance.refreshScheduledPages(new Date('2026-10-28T10:00:00Z'));
  assert.equal(instance.hiddenPageTimer, timer);
  assert.equal(modules.find(module => module.name === 'admin').hidden, false);
});

test('schedule keys remain original indices through several membership changes', () => {
  start({ 0: { until: '2026-10-28' }, 2: { from: '2026-10-29', until: '2026-11-09' } });
  assert.deepEqual(instance.activePageIndices, [0, 1]);
  instance.refreshScheduledPages(new Date('2026-10-28T10:00:00Z'));
  assert.deepEqual(instance.activePageIndices, [1]);
  instance.refreshScheduledPages(new Date('2026-10-29T10:00:00Z'));
  assert.deepEqual(instance.activePageIndices, [1, 2]);
  assert.equal(instance.config.timings[1], 25000);
  instance.refreshScheduledPages(new Date('2026-11-09T10:00:00Z'));
  assert.deepEqual(instance.activePageIndices, [1]);
});

test('Stockholm dates use summer time before the autumn clock change', () => {
  start({ 1: { from: '2026-10-25', until: '2026-10-26' } });
  instance.refreshScheduledPages(new Date('2026-10-24T21:59:59Z'));
  assert.deepEqual(instance.activePageIndices, [0, 2]);
  instance.refreshScheduledPages(new Date('2026-10-24T22:00:00Z'));
  assert.deepEqual(instance.activePageIndices, [0, 1, 2]);
  instance.refreshScheduledPages(new Date('2026-10-25T23:00:00Z'));
  assert.deepEqual(instance.activePageIndices, [0, 2]);
});

for (const rule of [{ from: '2026-02-30' }, { until: 'oops' }, { from: '2026-11-09', until: '2026-11-07' }, { until: '2026-11-07', typo: true }, null, []]) {
  test(`invalid window stays hidden: ${JSON.stringify(rule)}`, () => {
    start({ 1: rule });
    assert.deepEqual(instance.activePageIndices, [0, 2]);
  });
}

test('invalid timezone hides scheduled pages but keeps unscheduled pages', () => {
  instance.config.scheduleTimeZone = 'invalid';
  start({ 1: { from: '2026-01-01' } });
  assert.deepEqual(instance.activePageIndices, [0, 2]);
});

test('schedule check does not repeatedly redraw pages or reset their timers', () => {
  start({ 1: { until: '2026-11-09' } });
  notifications = [];
  const timer = instance.delayTimer;
  instance.refreshScheduledPages();
  assert.deepEqual(notifications, []);
  assert.equal(instance.delayTimer, timer);
});

test('a page expiring during its fade cannot reappear from a stale animation callback', (t) => {
  start({ 2: { until: '2026-11-09' } });
  instance.notificationReceived('PAGE_SELECT', 2);
  instance.refreshScheduledPages(new Date('2026-11-09T10:00:00Z'));
  t.mock.timers.tick(500);
  assert.equal(modules.find(module => module.name === 'page2').hidden, true);
});
