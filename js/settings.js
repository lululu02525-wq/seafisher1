/* ================================================================
   settings.js
   Admin / Settings panel, localStorage persistence, and the
   Bot API "Test Connection" (getMe) feature for Gold Miner.

   Depends on: window.AppLog (errorHandler.js)
   Exposes:    window.GM.settings
   ================================================================ */
(function (global) {
  'use strict';

  var log = global.AppLog || {
    info: function () {}, success: function () {},
    warn: function () {}, error: function () {}
  };

  /* ----------------------------------------------------------------
     Constants & Defaults
  ---------------------------------------------------------------- */
  var STORAGE_KEY = 'gm_settings_v1';
  var BEST_KEY    = 'gm_best_score';

  var DEFAULTS = {
    botToken:    '',
    botUsername: '',
    webAppUrl:   '',
    adminId:     '',
    startTime:   60,      // seconds
    scoreMult:   1.0,     // target-score multiplier
    difficulty:  'normal',// easy | normal | hard
    sound:       true
  };

  // Clamp ranges shared with game.js
  var BOUNDS = {
    startTime: { min: 20, max: 120 },
    scoreMult: { min: 0.5, max: 3.0 }
  };

  /* ----------------------------------------------------------------
     Internal State
  ---------------------------------------------------------------- */
  var state = {
    config: cloneDefaults(),
    tokenVisible: false,
    dom: {}
  };

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  /* ----------------------------------------------------------------
     Persistence
  ---------------------------------------------------------------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        log.info('No saved settings found. Using defaults.');
        return cloneDefaults();
      }
      var parsed = JSON.parse(raw);
      var merged = cloneDefaults();
      for (var k in DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(parsed, k)) {
          merged[k] = parsed[k];
        }
      }
      log.info('Settings loaded from localStorage.');
      return sanitize(merged);
    } catch (e) {
      log.error('Failed to load settings: ' + e.message, e.stack);
      return cloneDefaults();
    }
  }

  function save() {
    try {
      sanitize(state.config);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
      log.success('Settings saved.');
      return true;
    } catch (e) {
      log.error('Failed to save settings: ' + e.message, e.stack);
      return false;
    }
  }

  function sanitize(cfg) {
    cfg.startTime = clamp(toNumber(cfg.startTime, DEFAULTS.startTime),
                          BOUNDS.startTime.min, BOUNDS.startTime.max);
    cfg.scoreMult = clamp(toNumber(cfg.scoreMult, DEFAULTS.scoreMult),
                          BOUNDS.scoreMult.min, BOUNDS.scoreMult.max);
    if (['easy', 'normal', 'hard'].indexOf(cfg.difficulty) === -1) {
      cfg.difficulty = DEFAULTS.difficulty;
    }
    cfg.sound = !!cfg.sound;
    cfg.botToken    = String(cfg.botToken || '').trim();
    cfg.botUsername = String(cfg.botUsername || '').trim().replace(/^@/, '');
    cfg.webAppUrl   = String(cfg.webAppUrl || '').trim();
    cfg.adminId     = String(cfg.adminId || '').trim();
    return cfg;
  }

  /* ----------------------------------------------------------------
     Best Score helpers (shared with game.js)
  ---------------------------------------------------------------- */
  function getBest() {
    var v = parseInt(localStorage.getItem(BEST_KEY), 10);
    return isNaN(v) ? 0 : v;
  }

  function setBest(score) {
    try {
      var best = getBest();
      if (score > best) {
        localStorage.setItem(BEST_KEY, String(score));
        log.info('New best score stored: ' + score);
        return true;
      }
    } catch (e) {
      log.warn('Could not persist best score: ' + e.message);
    }
    return false;
  }

  function clearBest() {
    try {
      localStorage.removeItem(BEST_KEY);
      log.success('Best score cleared.');
    } catch (e) {
      log.error('Failed to clear best score: ' + e.message);
    }
  }

  /* ----------------------------------------------------------------
     Small utilities
  ---------------------------------------------------------------- */
  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function toNumber(v, fallback) {
    var n = parseFloat(v);
    return isNaN(n) ? fallback : n;
  }

  function maskToken(token) {
    if (!token) return '(empty)';
    if (token.length <= 8) return 'â€¢â€¢â€¢â€¢';
    return token.slice(0, 4) + 'â€¢â€¢â€¢â€¢â€¢â€¢' + token.slice(-4);
  }

  /* ----------------------------------------------------------------
     DOM wiring
  ---------------------------------------------------------------- */
  function cacheDom() {
    var d = state.dom;
    d.overlay      = document.getElementById('overlaySettings');
    d.btnOpen      = document.getElementById('btnSettings');

    d.botToken     = document.getElementById('setBotToken');
    d.btnToggle    = document.getElementById('btnToggleToken');
    d.botUsername  = document.getElementById('setBotUsername');
    d.webAppUrl    = document.getElementById('setWebAppUrl');
    d.adminId      = document.getElementById('setAdminId');

    d.btnTest      = document.getElementById('btnTestConn');

    d.cfgTime      = document.getElementById('cfgTime');
    d.cfgTimeVal   = document.getElementById('cfgTimeVal');
    d.cfgMult      = document.getElementById('cfgMult');
    d.cfgMultVal   = document.getElementById('cfgMultVal');
    d.cfgDiff      = document.getElementById('cfgDifficulty');
    d.cfgSound     = document.getElementById('cfgSound');

    d.btnReset     = document.getElementById('btnResetSettings');
    d.btnClearBest = document.getElementById('btnClearBest');
    d.btnSave      = document.getElementById('btnSaveSettings');

    // Optional close button if present in markup
    d.btnClose     = document.getElementById('btnCloseSettings');
  }

  function bindEvents() {
    var d = state.dom;

    if (d.btnOpen)  d.btnOpen.addEventListener('click', open);
    if (d.btnClose) d.btnClose.addEventListener('click', close);

    if (d.btnToggle) {
      d.btnToggle.addEventListener('click', function () {
        state.tokenVisible = !state.tokenVisible;
        d.botToken.type = state.tokenVisible ? 'text' : 'password';
        d.btnToggle.textContent = state.tokenVisible ? 'Hide' : 'Show';
      });
    }

    if (d.cfgTime) {
      d.cfgTime.addEventListener('input', function () {
        d.cfgTimeVal.textContent = d.cfgTime.value + 's';
      });
    }

    if (d.cfgMult) {
      d.cfgMult.addEventListener('input', function () {
        d.cfgMultVal.textContent = parseFloat(d.cfgMult.value).toFixed(1) + 'Ã—';
      });
    }

    if (d.btnTest)      d.btnTest.addEventListener('click', testConnection);
    if (d.btnSave)      d.btnSave.addEventListener('click', onSave);
    if (d.btnReset)     d.btnReset.addEventListener('click', onReset);
    if (d.btnClearBest) d.btnClearBest.addEventListener('click', onClearBest);

    // Close overlay when tapping the dimmed backdrop
    if (d.overlay) {
      d.overlay.addEventListener('click', function (e) {
        if (e.target === d.overlay) close();
      });
    }
  }

  /* Push state.config -> form fields */
  function renderForm() {
    var d = state.dom, c = state.config;
    if (d.botToken)    { d.botToken.value = c.botToken; d.botToken.type = 'password'; }
    if (d.btnToggle)   { state.tokenVisible = false; d.btnToggle.textContent = 'Show'; }
    if (d.botUsername) d.botUsername.value = c.botUsername;
    if (d.webAppUrl)   d.webAppUrl.value   = c.webAppUrl;
    if (d.adminId)     d.adminId.value     = c.adminId;

    if (d.cfgTime)   { d.cfgTime.value = c.startTime; d.cfgTimeVal.textContent = c.startTime + 's'; }
    if (d.cfgMult)   { d.cfgMult.value = c.scoreMult; d.cfgMultVal.textContent = c.scoreMult.toFixed(1) + 'Ã—'; }
    if (d.cfgDiff)   d.cfgDiff.value = c.difficulty;
    if (d.cfgSound)  d.cfgSound.checked = c.sound;
  }

  /* Read form fields -> state.config */
  function readForm() {
    var d = state.dom, c = state.config;
    if (d.botToken)    c.botToken    = d.botToken.value;
    if (d.botUsername) c.botUsername = d.botUsername.value;
    if (d.webAppUrl)   c.webAppUrl   = d.webAppUrl.value;
    if (d.adminId)     c.adminId     = d.adminId.value;

    if (d.cfgTime)  c.startTime  = parseInt(d.cfgTime.value, 10);
    if (d.cfgMult)  c.scoreMult  = parseFloat(d.cfgMult.value);
    if (d.cfgDiff)  c.difficulty = d.cfgDiff.value;
    if (d.cfgSound) c.sound      = d.cfgSound.checked;

    sanitize(c);
  }

  /* ----------------------------------------------------------------
     Open / Close
  ---------------------------------------------------------------- */
  function open() {
    renderForm();
    if (state.dom.overlay) state.dom.overlay.classList.add('overlay--visible');
    if (global.GM && global.GM.game && typeof global.GM.game.pause === 'function') {
      global.GM.game.pause();
    }
    log.info('Settings panel opened.');
  }

  function close() {
    if (state.dom.overlay) state.dom.overlay.classList.remove('overlay--visible');
  }

  /* ----------------------------------------------------------------
     Save / Reset / Clear
  ---------------------------------------------------------------- */
  function onSave() {
    readForm();
    if (save()) {
      renderForm();
      log.success('Settings applied. Token: ' + maskToken(state.config.botToken));
      broadcastChange();
      close();
    }
  }

  function onReset() {
    if (!confirm('Reset ALL settings to defaults? This cannot be undone.')) return;
    state.config = cloneDefaults();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    renderForm();
    log.warn('All settings reset to defaults.');
    broadcastChange();
  }

  function onClearBest() {
    if (!confirm('Clear stored best score?')) return;
    clearBest();
  }

  function broadcastChange() {
    if (global.GM && global.GM.game && typeof global.GM.game.onSettingsChanged === 'function') {
      try {
        global.GM.game.onSettingsChanged(getConfig());
      } catch (e) {
        log.error('Game failed to apply new settings: ' + e.message, e.stack);
      }
    }
  }

  /* ----------------------------------------------------------------
     Test Connection (Bot API getMe)
     NOTE: Calling the Bot API directly from the client exposes the
     token. This is acceptable for local testing only. In production
     route token usage through a backend (see bot/ examples).
  ---------------------------------------------------------------- */
  function testConnection() {
    readForm();
    var token = state.config.botToken;

    if (!token) {
      log.warn('Cannot test: Bot Token is empty.');
      return;
    }
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
      log.warn('Bot Token format looks invalid (expected <id>:<hash>).');
    }

    var btn = state.dom.btnTest;
    var prevText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Testingâ€¦'; }

    var url = 'https://api.telegram.org/bot' + encodeURIComponent(token) + '/getMe';

    fetch(url, { method: 'GET', cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok && data.result) {
          var u = data.result.username ? '@' + data.result.username : '(no username)';
          log.success('Connection OK â€” bot: ' + (data.result.first_name || '') + ' ' + u);
          // Auto-fill username if the field was empty
          if (!state.config.botUsername && data.result.username) {
            state.config.botUsername = data.result.username;
            if (state.dom.botUsername) state.dom.botUsername.value = data.result.username;
          }
        } else {
          var desc = data && data.description ? data.description : 'Unknown error';
          log.error('Bot API rejected token: ' + desc, JSON.stringify(data));
        }
      })
      .catch(function (err) {
        log.error('Network error during getMe: ' + err.message, err.stack);
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = prevText || 'Test Connection'; }
      });
  }

  /* ----------------------------------------------------------------
     Public accessor for game.js
  ---------------------------------------------------------------- */
  function getConfig() {
    // Return a defensive copy so callers can't mutate internal state
    return JSON.parse(JSON.stringify(state.config));
  }

  /* ----------------------------------------------------------------
     Bootstrap
  ---------------------------------------------------------------- */
  function init() {
    cacheDom();
    state.config = load(); if(!$c || !$c.difficulty){ state.config = DEFAULTS; }
    bindEvents();
    renderForm();
    log.info('Settings module initialized. Difficulty: ' + state.config.difficulty);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Export to GM namespace */
  global.GM = global.GM || {};
  global.GM.settings = {
    get:        getConfig,
    open:       open,
    close:      close,
    save:       save,
    getBest:    getBest,
    setBest:    setBest,
    clearBest:  clearBest,
    DEFAULTS:   DEFAULTS,
    BOUNDS:     BOUNDS
  };

})(window);

