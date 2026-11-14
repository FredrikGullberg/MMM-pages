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
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse('2026-11-14T10:00:00Z') });
  const modules = ['page0', 'page1', 'page2', 'admin', 'MMM-page-indicator'].map(name => ({
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
  global.document = { addEventListener: (type, handler) => listeners.push({ type, handler }) };
  notifications = [];
  instance = Object.create(definition);
  instance.identifier = 'pages';
  instance.config = {
    ...structuredClone(definition.defaults),
    modules: [['page0'], ['page1'], ['page2']],
    hiddenPages: { admin: ['admin'] },
    timings: { default: 20000 },
    homePage: 1,
  };
  instance.sendNotification = (name, payload) => notifications.push({ name, payload });
});

afterEach(() => {
  instance.clearTimers();
  clearTimeout(instance.pageAnimationTimer);
  delete global.document;
});

function start(config = {}) {
  Object.assign(instance.config, config);
  instance.start();
  instance.notificationReceived('DOM_OBJECTS_CREATED');
}

function press(key, extra = {}) {
  const event = { key, defaultPrevented: false, repeat: false, target: { tagName: 'BODY' }, ...extra,
    preventDefault() { this.defaultPrevented = true; } };
  listeners.forEach(listener => listener.handler(event));
  return event;
}

test('keyboard navigation is off by default', () => {
  start();
  assert.equal(listeners.length, 0);
});

test('arrow keys move through pages, wrap around and notify other modules', () => {
  start({ keyboardNavigation: true, homePage: 0 });
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].type, 'keydown');
  const event = press('ArrowRight');
  assert.equal(event.defaultPrevented, true);
  assert.equal(instance.curPage, 1);
  assert.ok(notifications.some(n => n.name === 'PAGE_INCREMENT'));
  assert.equal(notifications.filter(n => n.name === 'NEW_PAGE').at(-1).payload, 1);
  press('ArrowLeft');
  press('ArrowLeft');
  assert.equal(instance.curPage, 2);
});

test('Home returns to the home page', () => {
  start({ keyboardNavigation: true });
  press('ArrowRight');
  assert.equal(instance.curPage, 2);
  press('Home');
  assert.equal(instance.curPage, 1);
});

test('typing, modifiers, held keys and unrelated keys are ignored', () => {
  start({ keyboardNavigation: true, homePage: 0 });
  press('ArrowRight', { target: { tagName: 'INPUT' } });
  press('ArrowRight', { target: { isContentEditable: true } });
  press('ArrowRight', { ctrlKey: true });
  press('ArrowRight', { repeat: true });
  press('ArrowRight', { defaultPrevented: true });
  const other = press('Enter');
  assert.equal(other.defaultPrevented, false);
  assert.equal(instance.curPage, 0);
});

test('an arrow key leaves a hidden page instead of changing page', () => {
  start({ keyboardNavigation: true, homePage: 0 });
  instance.notificationReceived('SHOW_HIDDEN_PAGE', 'admin');
  assert.equal(instance.isOnHiddenPage, true);
  press('ArrowRight');
  assert.equal(instance.isOnHiddenPage, false);
  assert.equal(instance.curPage, 0);
});

test('custom keys replace the defaults; invalid lists fall back', () => {
  start({ keyboardNavigation: true, homePage: 0, keyboardKeys: { next: ['PageDown'], previous: 'nope' } });
  press('ArrowRight');
  assert.equal(instance.curPage, 0);
  press('PageDown');
  assert.equal(instance.curPage, 1);
  press('ArrowLeft');
  assert.equal(instance.curPage, 0);
});

test('the listener is registered only once', () => {
  start({ keyboardNavigation: true });
  instance.notificationReceived('DOM_OBJECTS_CREATED');
  assert.equal(listeners.length, 1);
});
