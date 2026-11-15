const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');

let definition;
global.Module = { register: (name, value) => { definition = value; } };
global.Log = { log() {}, warn() {}, error() {}, debug() {} };
require('../../MMM-pages.js');

let instance;
let notifications;
let listeners;

beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse('2026-11-15T08:00:00Z') });
  const modules = ['page0', 'page1', 'page2', 'MMM-page-indicator'].map(name => ({
    name, identifier: name, classes: '', hidden: false,
    hide() { this.hidden = true; }, show() { this.hidden = false; },
  }));
  global.MM = {
    getModules: () => ({
      enumerate: callback => modules.forEach(callback),
      withClass: classes => ({ enumerate: callback => modules.filter(module => classes.includes(module.name)).forEach(callback) }),
      exceptWithClass: classes => ({ enumerate: callback => modules.filter(module => !classes.includes(module.name)).forEach(callback) }),
    }),
  };
  listeners = [];
  global.document = { addEventListener: (type, handler) => listeners.push(handler) };
  notifications = [];
  instance = Object.create(definition);
  instance.identifier = 'pages';
  instance.config = {
    ...structuredClone(definition.defaults),
    modules: [['page0'], ['page1'], ['page2']],
    fixed: ['MMM-page-indicator'],
    timings: { default: 20000, 1: 45000 },
    rotationDelay: 10000,
    keyboardNavigation: true,
  };
  instance.sendNotification = (name, payload) => notifications.push({ name, payload });
});

afterEach(() => {
  instance.clearTimers();
  clearTimeout(instance.pageAnimationTimer);
  clearTimeout(instance.keyboardPauseTimer);
  delete global.document;
});

function start(config = {}) {
  Object.assign(instance.config, config);
  instance.start();
  instance.notificationReceived('DOM_OBJECTS_CREATED');
}

const timings = () => notifications.filter(n => n.name === 'PAGE_TIMING').map(n => n.payload);
const lastTiming = () => timings().at(-1);
const press = key => listeners.forEach(handler => handler({ key, target: { tagName: 'BODY' }, preventDefault() {} }));

test('the first page announces its full rotation time', () => {
  start();
  assert.deepEqual(lastTiming(), { page: 0, duration: 20000, remaining: 20000, paused: false });
});

test('every page change announces the new page before NEW_PAGE, with its own timing', (t) => {
  start();
  t.mock.timers.tick(0);
  notifications = [];
  t.mock.timers.tick(20000);
  const names = notifications.map(n => n.name);
  assert.ok(names.indexOf('PAGE_TIMING') < names.indexOf('NEW_PAGE'));
  assert.deepEqual(lastTiming(), { page: 1, duration: 45000, remaining: 45000, paused: false });
  instance.notificationReceived('PAGE_INCREMENT');
  assert.equal(lastTiming().page, 2);
  assert.equal(lastTiming().duration, 20000);
});

test('pause announces no automatic change; resume includes the rotation delay', () => {
  start();
  instance.notificationReceived('PAUSE_ROTATION');
  assert.deepEqual(lastTiming(), { page: 0, duration: 0, remaining: 0, paused: true });
  instance.notificationReceived('RESUME_ROTATION');
  assert.deepEqual(lastTiming(), { page: 0, duration: 30000, remaining: 30000, paused: false });
});

test('space toggles pause and tells other modules', () => {
  start();
  press(' ');
  assert.equal(instance.rotationPaused, true);
  assert.ok(notifications.some(n => n.name === 'PAUSE_ROTATION'));
  assert.equal(lastTiming().paused, true);
  press(' ');
  assert.equal(instance.rotationPaused, false);
  assert.ok(notifications.some(n => n.name === 'RESUME_ROTATION'));
  assert.equal(lastTiming().paused, false);
});

test('arrows during a pause change page but keep it paused', (t) => {
  start();
  press(' ');
  press('ArrowRight');
  assert.equal(instance.curPage, 1);
  assert.deepEqual(lastTiming(), { page: 1, duration: 0, remaining: 0, paused: true });
  t.mock.timers.tick(120000);
  assert.equal(instance.curPage, 1);
});

test('a keyboard pause resumes by itself; key presses postpone it', (t) => {
  start({ keyboardPauseTimeout: 60000 });
  press(' ');
  t.mock.timers.tick(50000);
  press('ArrowRight');
  t.mock.timers.tick(50000);
  assert.equal(instance.rotationPaused, true);
  t.mock.timers.tick(10000);
  assert.equal(instance.rotationPaused, false);
  assert.ok(notifications.filter(n => n.name === 'RESUME_ROTATION').length === 1);
});

test('keyboardPauseTimeout 0 keeps the pause until space is pressed again', (t) => {
  start({ keyboardPauseTimeout: 0 });
  press(' ');
  t.mock.timers.tick(24 * 3600 * 1000);
  assert.equal(instance.rotationPaused, true);
});

test('a pause from another module is not ended by the keyboard timeout', (t) => {
  start({ keyboardPauseTimeout: 1000 });
  instance.notificationReceived('PAUSE_ROTATION');
  t.mock.timers.tick(5000);
  assert.equal(instance.rotationPaused, true);
});

test('QUERY_PAGE_TIMING re-sends what is left of the current page', (t) => {
  start();
  t.mock.timers.tick(5000);
  instance.notificationReceived('QUERY_PAGE_TIMING');
  assert.deepEqual(lastTiming(), { page: 0, duration: 20000, remaining: 15000, paused: false });
});

test('no active pages announce no rotation', () => {
  start({ pageSchedules: { 0: { until: '2000-01-01' }, 1: { until: '2000-01-01' }, 2: { until: '2000-01-01' } } });
  assert.deepEqual(lastTiming(), { page: -1, duration: 0, remaining: 0, paused: false });
});
