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
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse('2026-11-14T10:00:00Z') });
  const make = (name, identifier, classes = '') => ({
    name, identifier, classes, hidden: false,
    hide() { this.hidden = true; }, show() { this.hidden = false; },
  });
  modules = [
    make('page0', 'm0'),
    make('MMM-MedaljKollen', 'stats', 'medalStats'),
    make('MMM-MedaljKollen', 'comp', 'medalCompetitions'),
    make('extra', 'm3'),
    make('page3', 'm4'),
    make('clock', 'clock'),
    make('MMM-page-indicator', 'indicator'),
  ];
  const matches = (module, classes) => classes.includes(module.name) || module.classes.split(' ').some(c => classes.includes(c));
  global.MM = {
    getModules: () => ({
      enumerate: callback => modules.forEach(callback),
      withClass: classes => ({ enumerate: callback => modules.filter(module => matches(module, classes)).forEach(callback) }),
      exceptWithClass: classes => ({ enumerate: callback => modules.filter(module => !matches(module, classes)).forEach(callback) }),
    }),
  };
  notifications = [];
  instance = Object.create(definition);
  instance.identifier = 'pages';
  instance.config = {
    ...structuredClone(definition.defaults),
    // Page 2 holds only the competitions instance; page 1 shares the class name of the other instance.
    modules: [['page0', 'medalStats'], ['page3'], ['medalCompetitions'], ['medalCompetitions', 'extra']],
    fixed: ['clock', 'MMM-page-indicator'],
    timings: { default: 20000, 2: 45000 },
  };
  instance.sendNotification = (name, payload) => notifications.push({ name, payload });
  instance.start();
  instance.notificationReceived('DOM_OBJECTS_CREATED');
});

afterEach(() => {
  instance.clearTimers();
  clearTimeout(instance.scheduleTimer);
  clearTimeout(instance.pageAnimationTimer);
});

const last = name => notifications.filter(notification => notification.name === name).at(-1)?.payload;
const report = (identifier, available) => {
  const sender = modules.find(module => module.identifier === identifier);
  instance.notificationReceived('PAGE_CONTENT_AVAILABLE', { available }, sender);
};

test('modules that never report keep every page active', () => {
  assert.deepEqual(instance.activePageIndices, [0, 1, 2, 3]);
  assert.equal(instance.unavailableModules.size, 0);
});

test('a page is skipped only when all of its modules report no content', () => {
  report('comp', false);
  assert.deepEqual(instance.activePageIndices, [0, 1, 3]);
  assert.equal(last('MAX_PAGES_CHANGED'), 3);
  // The other MMM-MedaljKollen instance (class medalStats) is unaffected.
  assert.ok(instance.config.modules.some(page => page.includes('medalStats')));
});

test('content returning restores the page and its original timing', () => {
  report('comp', false);
  // Visible index 2 is now configured page 3, which has no own timing.
  assert.equal(Object.hasOwn(instance.config.timings, 2), false);
  report('comp', true);
  assert.deepEqual(instance.activePageIndices, [0, 1, 2, 3]);
  assert.equal(instance.config.timings[2], 45000);
  assert.equal(last('MAX_PAGES_CHANGED'), 4);
});

test('repeated identical reports do not rebuild or renotify', () => {
  report('comp', false);
  const count = notifications.length;
  report('comp', false);
  assert.equal(notifications.length, count);
});

test('the current page leaves when it becomes empty, then rotation continues', () => {
  instance.notificationReceived('PAGE_SELECT', 2);
  assert.equal(instance.curPage, 2);
  report('comp', false);
  assert.equal(instance.curPage, 0);
  assert.equal(last('NEW_PAGE'), 0);
  instance.notificationReceived('PAGE_INCREMENT');
  instance.notificationReceived('PAGE_INCREMENT');
  assert.equal(instance.activePageIndices[instance.curPage], 3);
});

test('a page with an available module next to an empty one stays active', () => {
  report('comp', false);
  assert.ok(instance.activePageIndices.includes(3));
  report('m3', false);
  assert.deepEqual(instance.activePageIndices, [0, 1]);
});

test('malformed reports are ignored', () => {
  instance.notificationReceived('PAGE_CONTENT_AVAILABLE', { available: 'no' }, modules[2]);
  instance.notificationReceived('PAGE_CONTENT_AVAILABLE', { available: false });
  instance.notificationReceived('PAGE_CONTENT_AVAILABLE', null, modules[2]);
  assert.deepEqual(instance.activePageIndices, [0, 1, 2, 3]);
});

test('content availability combines with date schedules', () => {
  instance.config = { ...instance.config, modules: instance.allPages, timings: { default: 20000, 2: 45000 },
    scheduleTimeZone: 'Europe/Stockholm', pageSchedules: { 1: { until: '2026-11-01' } } };
  instance.start();
  instance.notificationReceived('DOM_OBJECTS_CREATED');
  assert.deepEqual(instance.activePageIndices, [0, 2, 3]);
  report('comp', false);
  assert.deepEqual(instance.activePageIndices, [0, 3]);
});
