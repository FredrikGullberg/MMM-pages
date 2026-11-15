Module.register('MMM-pages', {

  /**
   * By default, we have don't pseudo-paginate any modules. We also exclude
   * the page indicator by default, in case people actually want to use the
   * sister module. We also don't rotate out modules by default.
   */
  defaults: {
    modules: [],
    fixed: ['MMM-page-indicator'],
    hiddenPages: {},
    pageSchedules: {},
    scheduleTimeZone: undefined,
    animationTime: 1000,
    rotationTime: 0, // Deprecated
    timings: { default: 0 },
    rotationHomePage: 0,
    rotationHomePageHidden: 30000,
    rotationDelay: 10000,
    homePage: 0,
    useLockString: true,
    keyboardNavigation: false,
    keyboardKeys: {
      next: ['ArrowRight'],
      previous: ['ArrowLeft'],
      home: ['Home'],
      pause: [' '],
    },
    keyboardPauseTimeout: 600000,
  },

  /**
   * Modulo that also works with negative numbers.
   * @param {number} x The dividend
   * @param {number} n The divisor
   * @returns {number} The result of x mod n
   */
  mod(x, n) {
    return ((x % n) + n) % n;
  },

  /**
   * Clears all active timers.
   */
  clearTimers() {
    // This timer is the auto rotate function.
    clearInterval(this.timer);
    // This is delay timer after manually updating.
    clearTimeout(this.delayTimer);
    // This is the hidden page timer.
    clearTimeout(this.hiddenPageTimer);
  },

  /**
   * Pseudo-constructor for our module. Makes sure that values aren't negative,
   * and sets the default current page to 0.
   */
  start() {
    this.validateConfig();

    // Clamp homePage value to [0, num pages).
    if (this.config.homePage >= this.config.modules.length || this.config.homePage < 0) {
      this.config.homePage = 0;
    }
    this.curPage = this.config.homePage;
    this.rotationPaused = false;
    this.isOnHiddenPage = false;

    if (!this.config.timings || typeof this.config.timings !== 'object' || Array.isArray(this.config.timings)) {
      Log.warn('[MMM-pages] The config option "timings" is missing or invalid. Please provide an object with page numbers as keys and rotation times in milliseconds as values.');
      this.config.timings = { default: 0 };
    }

    // Compatibility
    if (this.config.rotationTime) {
      Log.warn('[MMM-pages] The config option "rotationTime" is deprecated. Please use "timings" instead.');
      this.config.timings.default = this.config.rotationTime;
    }

    // Disable rotation if an invalid input is given
    this.config.timings.default = Math.max(this.config.timings.default, 0);
    this.config.rotationDelay = Math.max(this.config.rotationDelay, 0);
    this.config.rotationHomePage = Math.max(this.config.rotationHomePage, 0);
    this.config.rotationHomePageHidden = Math.max(this.config.rotationHomePageHidden, 0);

    if (!this.config.useLockString) {
      Log.log('[MMM-pages] User opted to not use lock strings!');
    }

    this.hiddenPageTimer = null;
    this.permanentlyHiddenModules = new Set();
    // Module identifiers that reported "no content" via PAGE_CONTENT_AVAILABLE.
    this.unavailableModules = new Set();
    this.domReady = false;
    this.allPages = this.config.modules.slice();
    this.allTimings = { ...this.config.timings };
    this.configuredHomePage = this.config.homePage;
    this.activePageIndices = this.allPages.map((page, index) => index);
    this.preparePageSchedules();
    this.refreshScheduledPages();
  },

  /**
   * Validates the shape of the `modules`, `fixed`, and `hiddenPages` config
   * options, logging an error and resetting to a safe default for any that
   * are malformed. Also logs a debug hint when no pages are configured at
   * all, since that would otherwise fail silently. This runs before any
   * other config-dependent logic in `start()`, so a broken config never
   * crashes the module later on.
   */
  validateConfig() {
    if (!Array.isArray(this.config.modules) || !this.config.modules.every(page => this.isStringArray(page))) {
      Log.error('[MMM-pages] Invalid "modules" configuration. Expected an array of string arrays.');
      this.config.modules = [];
    }

    if (this.config.modules.length === 0) {
      Log.debug('[MMM-pages] No pages are configured; no page-specific modules will be shown.');
    }

    if (this.config.fixed !== undefined && !this.isStringArray(this.config.fixed)) {
      Log.error('[MMM-pages] Invalid "fixed" configuration. Expected an array of module names.');
      this.config.fixed = [];
    }

    const { hiddenPages } = this.config;
    const isPlainObject = typeof hiddenPages === 'object' && hiddenPages !== null && !Array.isArray(hiddenPages);
    if (hiddenPages !== undefined
      && (!isPlainObject || !Object.values(hiddenPages).every(page => this.isStringArray(page)))) {
      Log.error('[MMM-pages] Invalid "hiddenPages" configuration. Expected an object of string arrays.');
      this.config.hiddenPages = {};
    }
  },

  /**
   * Validate date windows once, retaining configured page numbers as stable keys.
   * An invalid window disables its page rather than displaying expired content.
   */
  preparePageSchedules() {
    this.pageScheduleRules = new Map();
    const schedules = this.config.pageSchedules ?? {};
    if (typeof schedules !== 'object' || schedules === null || Array.isArray(schedules)) {
      Log.error('[MMM-pages] Invalid "pageSchedules". Expected an object keyed by configured page index.');
      return;
    }
    try {
      this.scheduleDateFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.config.scheduleTimeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
    } catch {
      this.scheduleDateFormatter = null;
      Log.error('[MMM-pages] Invalid "scheduleTimeZone". Scheduled pages will remain hidden.');
    }
    const validDate = value => typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}$/u.test(value)
      && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    for (const [key, rule] of Object.entries(schedules)) {
      const page = Number(key);
      if (!/^(0|[1-9]\d*)$/u.test(key) || page >= this.allPages.length) {
        Log.warn(`[MMM-pages] Ignoring schedule for unknown page "${key}".`);
        continue;
      }
      const valid = rule !== null && typeof rule === 'object' && !Array.isArray(rule)
        && Object.keys(rule).every(field => field === 'from' || field === 'until')
        && (rule.from === undefined || validDate(rule.from))
        && (rule.until === undefined || validDate(rule.until))
        && (rule.from === undefined || rule.until === undefined || rule.from < rule.until);
      this.pageScheduleRules.set(page, valid ? rule : null);
      if (!valid) Log.error(`[MMM-pages] Invalid schedule for page ${page}; this page will remain hidden.`);
    }
  },

  /**
   * Rebuild the visible page list while preserving each page's original timing.
   * Public page notifications use compact visible indices for the stock indicator.
   * @param {Date} [now] Current instant, injectable for boundary tests.
   */
  refreshScheduledPages(now = new Date()) {
    const allActive = (this.activePageIndices?.length ?? 0) === (this.allPages?.length ?? 0);
    if (!this.pageScheduleRules?.size && !this.unavailableModules?.size && allActive) return;
    let today;
    if (this.scheduleDateFormatter) {
      const parts = this.scheduleDateFormatter.formatToParts(now);
      const part = type => parts.find(value => value.type === type).value;
      today = `${part('year')}-${part('month')}-${part('day')}`;
    }
    const active = this.allPages.map((page, index) => index).filter((index) => {
      if (!this.pageHasContent(index)) return false;
      if (!this.pageScheduleRules.has(index)) return true;
      const rule = this.pageScheduleRules.get(index);
      return Boolean(rule && today && (!rule.from || today >= rule.from) && (!rule.until || today < rule.until));
    });
    if (active.join(',') === this.activePageIndices.join(',')) return;
    const previousPage = this.activePageIndices[this.curPage];
    const previousCount = this.activePageIndices.length;
    this.activePageIndices = active;
    this.config.modules = active.map(index => this.allPages[index]);
    this.config.timings = Object.fromEntries(Object.entries(this.allTimings).filter(([key]) => !/^\d+$/u.test(key)));
    active.forEach((original, visible) => {
      if (Object.hasOwn(this.allTimings, original)) this.config.timings[visible] = this.allTimings[original];
    });
    this.config.homePage = Math.max(0, active.indexOf(this.configuredHomePage));
    this.curPage = active.includes(previousPage) ? active.indexOf(previousPage) : this.config.homePage;
    if (this.domReady) {
      this.sendNotification('MAX_PAGES_CHANGED', active.length);
      this.sendNotification('NEW_PAGE', active.length ? this.curPage : -1);
      this.registerApiActions();
      if (!this.isOnHiddenPage) {
        if (previousPage !== active[this.curPage] || previousCount === 0) this.animatePageChange();
        if (!this.rotationPaused) this.resetTimerWithDelay(0);
      }
    }
  },

  /**
   * A page lacks content only when every module on it has reported
   * `PAGE_CONTENT_AVAILABLE` with `available: false`. Modules that never send
   * the notification count as available, so existing setups are unaffected.
   * @param {number} index Original configured page index.
   * @returns {boolean} False if the page should be skipped.
   */
  pageHasContent(index) {
    if (!this.unavailableModules?.size || typeof MM === 'undefined') return true;
    let matched = 0;
    let available = false;
    MM.getModules().withClass(this.allPages[index]).enumerate((module) => {
      matched += 1;
      if (!this.unavailableModules.has(module.identifier)) available = true;
    });
    return matched === 0 || available;
  },

  /**
   * Record a module's content state and rebuild the active pages if it changed.
   * @param {{available: boolean}} payload Content state from the sending module.
   * @param {object} sender The MagicMirror module instance that sent it.
   */
  setContentAvailability(payload, sender) {
    if (!sender?.identifier || typeof payload?.available !== 'boolean') {
      Log.warn('[MMM-pages] Ignoring PAGE_CONTENT_AVAILABLE without a sender or boolean "available".');
      return;
    }
    const had = this.unavailableModules.has(sender.identifier);
    if (payload.available === !had) return;
    if (payload.available) this.unavailableModules.delete(sender.identifier);
    else this.unavailableModules.add(sender.identifier);
    Log.log(`[MMM-pages] ${sender.name} (${sender.identifier}) reports ${payload.available ? 'content' : 'no content'}.`);
    this.refreshScheduledPages();
  },

  /**
   * Check date windows at each minute boundary, independently of rotation/pause.
   * Keep checking when all pages are inactive so future pages can reappear.
   */
  startScheduleTimer() {
    clearTimeout(this.scheduleTimer);
    if (!this.pageScheduleRules?.size) return;
    this.scheduleTimer = setTimeout(() => {
      this.refreshScheduledPages();
      this.startScheduleTimer();
    }, 60000 - Date.now() % 60000 + 10);
  },

  /**
   * Handles incoming notifications. Responds to the following:
   *   'PAGE_SELECT' - Set the page to the specified payload page.
   *   'PAGE_CHANGED' - Deprecated alias for PAGE_SELECT.
   *   'PAGE_INCREMENT' - Move to the next page.
   *   'PAGE_DECREMENT' - Move to the previous page.
   *   'DOM_OBJECTS_CREATED' - Starts the module.
   *   'QUERY_PAGE_NUMBER' - Requests the current page number
   *   'PAUSE_ROTATION' - Stops rotation
   *   'RESUME_ROTATION' - Resumes rotation
   *   'HOME_PAGE' - Calls PAGE_SELECT with the default home page.
   *   'SHOW_HIDDEN_PAGE' - Shows the (in the payload) specified hidden
   *                        page by name
   *   'LEAVE_HIDDEN_PAGE' - Hides the currently showing hidden page and
   *                         resumes showing the last page
   *   'QUERY_PAGE_TIMING' - Re-sends PAGE_TIMING for the current page
   *   'PAGE_CONTENT_AVAILABLE' - A module reports whether it has content;
   *                              pages where no module has content are skipped
   * @param {string} notification the notification ID
   * @param {number|string|object} payload the page to change to/by
   * @param {object} [sender] the module that sent the notification
   */
  notificationReceived(notification, payload, sender) {
    if (this.domReady) this.refreshScheduledPages();
    switch (notification) {
      case 'PAGE_CHANGED':
        Log.warn('[MMM-pages] The notification "PAGE_CHANGED" is deprecated. Please use "PAGE_SELECT" instead.');
        // falls through
      case 'PAGE_SELECT':
        if (!Number.isInteger(payload) || payload < 0 || payload >= this.config.modules.length) {
          Log.warn(`[MMM-pages] Cannot select page ${payload}. Expected an integer from 0 to ${this.config.modules.length - 1}.`);
          break;
        }
        Log.log(`[MMM-pages] received a notification to change to page ${payload} of type ${typeof payload}.`);
        this.curPage = payload;
        this.updatePages();
        break;
      case 'PAGE_INCREMENT':
        Log.log('[MMM-pages] received a notification to increment pages!');
        this.changePageBy(payload, 1);
        this.updatePages();
        break;
      case 'PAGE_DECREMENT':
        Log.log('[MMM-pages] received a notification to decrement pages!');
        // We can't just pass in -payload for situations where payload is null
        // JS will coerce -payload to -0.
        this.changePageBy(payload ? -payload : payload, -1);
        this.updatePages();
        break;
      case 'DOM_OBJECTS_CREATED':
        Log.log('[MMM-pages] received that all objects are created; will now hide things!');
        // Store modules that are initially hidden (hiddenOnStartup: true)
        MM.getModules().enumerate((module) => {
          if (module.hidden) {
            this.permanentlyHiddenModules.add(module.identifier);
            Log.log(`[MMM-pages] Module ${module.name} (${module.identifier}) is initially hidden and will remain so`);
          }
        });
        this.domReady = true;
        this.refreshScheduledPages();
        this.sendNotification('MAX_PAGES_CHANGED', this.config.modules.length);
        this.sendNotification('NEW_PAGE', this.config.modules.length ? this.curPage : -1);
        this.animatePageChange();
        this.resetTimerWithDelay(0);
        this.registerApiActions();
        this.startScheduleTimer();
        this.setupKeyboardNavigation();
        break;
      case 'QUERY_PAGE_TIMING':
        if (this.lastTiming) this.emitTiming(this.lastTiming.duration ? Math.max(0, this.lastTiming.until - Date.now()) : 0, this.lastTiming.duration);
        break;
      case 'QUERY_PAGE_NUMBER':
        this.sendNotification('PAGE_NUMBER_IS', this.config.modules.length ? this.curPage : -1);
        break;
      case 'PAUSE_ROTATION':
        this.setRotation(false);
        break;
      case 'RESUME_ROTATION':
        this.setRotation(true);
        break;
      case 'HOME_PAGE':
        this.notificationReceived('PAGE_SELECT', this.config.homePage);
        break;
      case 'SHOW_HIDDEN_PAGE':
        Log.log(`[MMM-pages] received a notification to change to the hidden page "${payload}" of type "${typeof payload}".`);
        if (!(payload in this.config.hiddenPages)) {
          Log.error(`[MMM-pages] Hidden page "${payload}" does not exist!`);
          break;
        }
        this.isOnHiddenPage = true;
        this.setRotation(false);
        this.showHiddenPage(payload);
        break;
      case 'PAGE_CONTENT_AVAILABLE':
        this.setContentAvailability(payload, sender);
        break;
      case 'LEAVE_HIDDEN_PAGE':
        Log.log('[MMM-pages] received a notification to leave the current hidden page.');
        this.isOnHiddenPage = false;
        clearTimeout(this.hiddenPageTimer);
        this.animatePageChange();
        this.setRotation(true);
        break;
      default: // Do nothing
    }
  },

  /**
   * Listen for keyboard page changes when `keyboardNavigation` is enabled.
   * Registered once; invalid key lists fall back to the defaults.
   */
  setupKeyboardNavigation() {
    if (!this.config.keyboardNavigation || this.keyHandler || typeof document === 'undefined') return;
    const configured = this.config.keyboardKeys;
    const keys = {};
    for (const action of ['next', 'previous', 'home', 'pause']) {
      const value = configured?.[action];
      keys[action] = this.isStringArray(value) ? value : this.defaults.keyboardKeys[action];
    }
    this.keyboardKeys = keys;
    this.keyHandler = event => this.handleKey(event);
    document.addEventListener('keydown', this.keyHandler);
    Log.log('[MMM-pages] Keyboard navigation enabled.');
  },

  /**
   * Map a keydown event to a page change. Ignores typing in form fields,
   * modifier combinations and held-down keys.
   * @param {KeyboardEvent} event The keydown event.
   * @returns {boolean} True if the key changed (or left) a page.
   */
  handleKey(event) {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return false;
    const target = event.target;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return false;
    const action = ['next', 'previous', 'home', 'pause'].find(name => this.keyboardKeys[name].includes(event.key));
    if (!action) return false;
    event.preventDefault();
    if (action === 'pause') {
      this.toggleKeyboardPause();
      return true;
    }
    // Activity during a keyboard pause postpones the automatic resume.
    if (this.keyboardPaused) this.armKeyboardPauseTimeout();
    if (this.isOnHiddenPage) {
      this.notificationReceived('LEAVE_HIDDEN_PAGE');
      return true;
    }
    const notification = { next: 'PAGE_INCREMENT', previous: 'PAGE_DECREMENT', home: 'HOME_PAGE' }[action];
    // Same pattern as auto rotation: tell other modules, then handle it ourselves.
    this.sendNotification(notification);
    this.notificationReceived(notification);
    return true;
  },

  /**
   * Pause or resume rotation from the keyboard. A keyboard pause resumes by
   * itself after `keyboardPauseTimeout` ms without key presses (0 = never),
   * so a forgotten pause does not leave the mirror on one page.
   */
  toggleKeyboardPause() {
    if (this.rotationPaused) {
      clearTimeout(this.keyboardPauseTimer);
      this.keyboardPaused = false;
      Log.log('[MMM-pages] Rotation resumed from keyboard.');
      this.sendNotification('RESUME_ROTATION');
      this.setRotation(true);
    } else {
      this.keyboardPaused = true;
      Log.log('[MMM-pages] Rotation paused from keyboard.');
      this.sendNotification('PAUSE_ROTATION');
      this.setRotation(false);
      this.armKeyboardPauseTimeout();
    }
  },

  /**
   * (Re)start the timer that ends a keyboard pause.
   */
  armKeyboardPauseTimeout() {
    clearTimeout(this.keyboardPauseTimer);
    const timeout = Number(this.config.keyboardPauseTimeout);
    if (!(timeout > 0)) return;
    this.keyboardPauseTimer = setTimeout(() => {
      if (!this.keyboardPaused || !this.rotationPaused) return;
      this.keyboardPaused = false;
      Log.log('[MMM-pages] Keyboard pause timed out; resuming rotation.');
      this.sendNotification('RESUME_ROTATION');
      this.setRotation(true);
    }, timeout);
  },

  /**
   * Tell other modules (e.g. the page indicator) when the next automatic page
   * change happens: `{ page, duration, remaining, paused }`. `duration` is the
   * full span until that change (0 = no automatic change), `remaining` how
   * much of it is left now. Sent on every page change, pause and resume.
   * @param {number} remaining Milliseconds until the next automatic change.
   * @param {number} [duration] Full span; defaults to `remaining`.
   */
  emitTiming(remaining, duration = remaining) {
    const paused = Boolean(this.rotationPaused);
    const page = this.config?.modules?.length ? this.curPage : -1;
    this.lastTiming = { page, duration, until: Date.now() + remaining, paused };
    if (typeof this.sendNotification !== 'function') return;
    this.sendNotification('PAGE_TIMING', { page, duration, remaining, paused });
  },

  isStringArray(value) {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
  },

  /**
   * Changes the internal page number by the specified amount. If the provided
   * amount is invalid, use the fallback amount. If the fallback amount is
   * missing or invalid, do nothing.
   * @param {number} amt the amount of pages to move forward by. Accepts
   * negative numbers.
   * @param {number} fallback the fallback value to use. Accepts negative
   * numbers.
   */
  changePageBy(amt, fallback) {
    if (this.config.modules.length === 0) return;
    if (typeof amt !== 'number' && typeof fallback === 'undefined') {
      Log.warn(`[MMM-pages] ${amt} is not a number!`);
    }

    if (typeof amt === 'number' && !Number.isNaN(amt)) {
      this.curPage = this.mod(
        this.curPage + amt,
        this.config.modules.length
      );
    } else if (typeof fallback === 'number') {
      this.curPage = this.mod(
        this.curPage + fallback,
        this.config.modules.length
      );
    }
  },

  /**
   * Handles hiding the current page's elements and showing the next page's
   * elements.
   */
  updatePages() {
    // Update if there's at least one page.
    if (this.config.modules.length > 0) {
      this.animatePageChange();
      if (this.rotationPaused) {
        this.emitTiming(0);
      } else {
        this.resetTimerWithDelay(0);
      }
      this.sendNotification('NEW_PAGE', this.config.modules.length ? this.curPage : -1);
    } else if (this.allPages?.length) {
      // All configured pages are outside their date windows. Keep fixed modules.
      this.animatePageChange();
      this.clearTimers();
      this.sendNotification('NEW_PAGE', -1);
    } else {
      Log.error(`[MMM-pages] Pages are not properly defined! Expected array, got ${typeof this.config.modules}`);
    }
  },

  /**
   * Animates the page change from the previous page to the current one. This
   * assumes that there is a discrepancy between the page currently being shown
   * and the page that is meant to be shown.
   * @param {string} [targetPageName] the name of the hiddenPage we want to show.
   * Optional and only used when we want to switch to a hidden page
   */
  animatePageChange(targetPageName) {
    let lockStringObj = { lockString: this.identifier };
    if (!this.config.useLockString) {
      // Passing in an undefined object is equivalent to not passing it in at
      // all, effectively providing only one arg to the hide and show calls
      lockStringObj = undefined;
    }

    // Hides all modules not on the current page. This hides any module not
    // meant to be shown.

    let modulesToShow;
    if (typeof targetPageName === 'undefined') {
      modulesToShow = this.config.fixed.concat(this.config.modules[this.curPage] || []);
    } else {
      modulesToShow = this.config.hiddenPages[targetPageName];
    }
    const noActivePages = typeof targetPageName === 'undefined' && this.config.modules.length === 0;
    const animationTime = this.config.animationTime / 2;
    if (noActivePages) {
      // The stock indicator rejects a zero page count; hide its dots instead.
      MM.getModules().withClass('MMM-page-indicator')
        .enumerate(module => module.hide(animationTime, () => {}, lockStringObj));
    }

    MM.getModules()
      .exceptWithClass(modulesToShow)
      .enumerate(module => module.hide(animationTime, () => {}, lockStringObj));

    // Shows all modules meant to be on the current page, after a small delay.
    clearTimeout(this.pageAnimationTimer);
    this.pageAnimationTimer = setTimeout(() => {
      MM.getModules()
        .withClass(modulesToShow)
        .enumerate((module) => {
          // Respect hiddenOnStartup - don't show modules that were initially hidden
          if (!this.permanentlyHiddenModules.has(module.identifier)
            && !(noActivePages && module.name === 'MMM-page-indicator')) {
            module.show(animationTime, () => {}, lockStringObj);
          }
        });
    }, animationTime);
  },

  /**
   * Resets the page changing timer with a delay.
   * @param {number} delay the delay, in milliseconds.
   */
  resetTimerWithDelay(delay) {
    Log.debug(`[MMM-pages] resetTimerWithDelay called with delay: ${delay}ms`);
    // Always clear, otherwise a timer from the previous page keeps rotating a page without timing.
    this.clearTimers();
    if (this.config.modules.length === 0) {
      this.emitTiming(0);
      return;
    }

    let currentRotationTime = this.config.timings.default;
    if (Object.hasOwn(this.config.timings, this.curPage)) {
      currentRotationTime = this.config.timings[this.curPage];
    }

    if (currentRotationTime > 0) {
      this.emitTiming(delay + currentRotationTime);
      this.delayTimer = setTimeout(() => {
        Log.debug(`[MMM-pages] Starting auto rotation with interval: ${currentRotationTime}ms`);
        this.timer = setInterval(() => {
          // Inform other modules and page change.
          // MagicMirror automatically excludes the sender from receiving the
          // message, so we need to trigger it for ourselves.
          this.sendNotification('PAGE_INCREMENT');
          this.notificationReceived('PAGE_INCREMENT');
        }, currentRotationTime);
      }, delay);
    } else {
      // Determine which rotationHomePage setting to use based on current page type
      const rotationHomePageTimeout = this.isOnHiddenPage
        ? this.config.rotationHomePageHidden
        : this.config.rotationHomePage;

      this.emitTiming(rotationHomePageTimeout > 0 ? delay + rotationHomePageTimeout : 0);
      if (rotationHomePageTimeout > 0) {
        this.delayTimer = setTimeout(() => {
          this.timer = setInterval(() => {
            // Inform other modules and page change.
            // MagicMirror automatically excludes the sender from receiving the
            // message, so we need to trigger it for ourselves.
            this.sendNotification('PAGE_SELECT', this.config.homePage);
            this.notificationReceived('PAGE_SELECT', this.config.homePage);
          }, rotationHomePageTimeout);
        }, delay);
      }
    }
  },

  /**
   * Toggles page rotation.
   * @param {boolean} shouldRotate - True to resume rotation, false to pause it.
   */
  setRotation(shouldRotate) {
    const action = shouldRotate ? 'resume' : 'pause';
    Log.debug(`[MMM-pages] setRotation called: ${action} rotation`);
    if (shouldRotate === !this.rotationPaused) {
      Log.debug(`[MMM-pages] Rotation already ${shouldRotate ? 'running' : 'paused'}!`);
    } else {
      if (shouldRotate) {
        this.rotationPaused = false;
        this.resetTimerWithDelay(this.config.rotationDelay);
        Log.debug('[MMM-pages] Rotation resumed');
      } else {
        this.clearTimers();
        this.rotationPaused = true;
        this.emitTiming(0);
        Log.debug('[MMM-pages] Rotation paused');
      }
    }
  },

  /**
   * Register API actions for MMM-Remote-Control integration.
   * This allows controlling pages from the Remote Control UI.
   */
  registerApiActions() {
    const api = {
      module: 'MMM-pages',
      path: 'pages',
      actions: {
        next: {
          notification: 'PAGE_INCREMENT',
          prettyName: 'Next Page'
        },
        previous: {
          notification: 'PAGE_DECREMENT',
          prettyName: 'Previous Page'
        },
        home: {
          notification: 'HOME_PAGE',
          prettyName: 'Home Page'
        },
        pause: {
          notification: 'PAUSE_ROTATION',
          prettyName: 'Pause Rotation'
        },
        resume: {
          notification: 'RESUME_ROTATION',
          prettyName: 'Resume Rotation'
        },
        leave: {
          notification: 'LEAVE_HIDDEN_PAGE',
          prettyName: 'Leave Hidden Page'
        }
      }
    };

    // Add an action for each page
    for (let i = 0; i < this.config.modules.length; i++) {
      api.actions[`page${i}`] = {
        notification: 'PAGE_SELECT',
        payload: i,
        prettyName: `Page ${i}`
      };
    }

    // Add an action for each hidden page (prefixed to avoid collision with core actions)
    for (const pageName of Object.keys(this.config.hiddenPages)) {
      const key = `show${pageName.replace(/\s/gu, '').toLowerCase()}`;
      api.actions[key] = {
        notification: 'SHOW_HIDDEN_PAGE',
        payload: pageName,
        prettyName: `Show ${pageName}`
      };
    }

    this.sendNotification('REGISTER_API', api);
  },

  /**
   * Handles hidden pages.
   * @param {string} name the name of the hiddenPage we want to show
   */
  showHiddenPage(name) {
    if (name in this.config.hiddenPages) {
      this.animatePageChange(name);
      this.startHiddenPageTimer(name);
    } else {
      Log.error(`[MMM-pages] Hidden page "${name}" does not exist!`);
    }
  },

  /**
   * Starts a timer for a hidden page.
   * @param {string} pageName - The name of the hidden page for which the timer is being started.
   */
  startHiddenPageTimer(pageName) {
    clearTimeout(this.hiddenPageTimer);
    const timeout = this.config.timings[pageName];
    if (timeout && timeout > 0) {
      Log.debug(`[MMM-pages] Starting hidden page timer for "${pageName}" with timeout ${timeout}ms`);
      this.hiddenPageTimer = setTimeout(() => {
        Log.debug(`[MMM-pages] Hidden page "${pageName}" timeout reached, returning to normal rotation`);
        this.notificationReceived('LEAVE_HIDDEN_PAGE');
      }, timeout);
    } else {
      Log.debug(`[MMM-pages] No timeout configured for hidden page "${pageName}"`);
    }
  }
});
