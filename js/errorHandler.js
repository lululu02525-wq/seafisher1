/* =================================================================
   errorHandler.js  —  Global Error Capture & Debug Console
   Gold Miner Telegram Mini App
   -----------------------------------------------------------------
   Loaded FIRST so that any runtime error (even in later scripts)
   is captured, logged, and surfaced via toast + on-screen console.
   ================================================================= */

(function (global) {
  'use strict';

  /* ----------------------------------------------------------------
     Configuration
  ---------------------------------------------------------------- */
  var CONFIG = {
    MAX_LOGS: 200,          // ring-buffer cap to avoid memory bloat
    MAX_TOASTS: 4,          // simultaneous on-screen toasts
    TOAST_TTL: 4000,        // ms before a toast auto-dismisses
    DEDUP_WINDOW: 1500,     // ms — suppress identical repeated errors
    STORAGE_KEY: 'gm_error_log'
  };

  /* ----------------------------------------------------------------
     Internal State
  ---------------------------------------------------------------- */
  var state = {
    logs: [],               // { id, level, time, msg, detail }
    unread: 0,
    lastSig: '',            // signature of last error (dedup)
    lastSigTime: 0,
    ready: false,           // DOM hooks resolved?
    queue: []               // toasts queued before DOM ready
  };

  /* DOM references (resolved on init) */
  var dom = {
    toastStack: null,
    logPanel: null,
    logBody: null,
    logToggle: null,
    logBadge: null
  };

  /* ----------------------------------------------------------------
     Utilities
  ---------------------------------------------------------------- */
  function now() {
    return Date.now();
  }

  function timeLabel(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function uid() {
    return 'e' + now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function safeStringify(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (value instanceof Error) {
      return value.name + ': ' + value.message +
             (value.stack ? '\n' + value.stack : '');
    }
    try {
      var seen = [];
      return JSON.stringify(value, function (k, v) {
        if (typeof v === 'object' && v !== null) {
          if (seen.indexOf(v) !== -1) return '[Circular]';
          seen.push(v);
        }
        return v;
      }, 2);
    } catch (e) {
      try { return String(value); } catch (e2) { return '[Unserializable]'; }
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ----------------------------------------------------------------
     Persistence (best-effort; never throws)
  ---------------------------------------------------------------- */
  function persist() {
    try {
      var slim = state.logs.slice(-50).map(function (l) {
        return { level: l.level, time: l.time, msg: l.msg };
      });
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(slim));
    } catch (e) { /* storage full or unavailable — ignore */ }
  }

  function restore() {
    try {
      var raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach(function (l) {
          state.logs.push({
            id: uid(),
            level: l.level || 'info',
            time: l.time || now(),
            msg: l.msg || '',
            detail: ''
          });
        });
      }
    } catch (e) { /* corrupt — ignore */ }
  }

  /* ----------------------------------------------------------------
     Core Logging
  ---------------------------------------------------------------- */
  function record(level, msg, detail) {
    var entry = {
      id: uid(),
      level: level,
      time: now(),
      msg: msg,
      detail: detail || ''
    };

    state.logs.push(entry);
    if (state.logs.length > CONFIG.MAX_LOGS) {
      state.logs.splice(0, state.logs.length - CONFIG.MAX_LOGS);
    }

    if (level === 'error' || level === 'warning') {
      state.unread++;
      updateBadge();
    }

    renderEntry(entry);
    persist();
    return entry;
  }

  function isDuplicate(signature) {
    var t = now();
    if (signature === state.lastSig &&
        (t - state.lastSigTime) < CONFIG.DEDUP_WINDOW) {
      return true;
    }
    state.lastSig = signature;
    state.lastSigTime = t;
    return false;
  }

  /* ----------------------------------------------------------------
     Public API: log levels
  ---------------------------------------------------------------- */
  function logInfo(msg, detail) {
    return capture('info', msg, detail, false);
  }
  function logSuccess(msg, detail) {
    return capture('success', msg, detail, true);
  }
  function logWarning(msg, detail) {
    return capture('warning', msg, detail, true);
  }
  function logError(msg, detail) {
    return capture('error', msg, detail, true);
  }

  function capture(level, msg, detail, toast) {
    var text = (typeof msg === 'string') ? msg : safeStringify(msg);
    var det = detail ? safeStringify(detail) : '';

    // Dedup only for noisy levels
    if (level === 'error' || level === 'warning') {
      if (isDuplicate(level + '|' + text)) return null;
    }

    var entry = record(level, text, det);

    if (toast) showToast(level, text);

    // Mirror to native console without re-triggering our hooks
    mirrorConsole(level, text, det);

    return entry;
  }

  /* ----------------------------------------------------------------
     Toasts
  ---------------------------------------------------------------- */
  function showToast(level, text) {
    if (!state.ready) {
      state.queue.push({ level: level, text: text });
      return;
    }
    if (!dom.toastStack) return;

    // Enforce max simultaneous toasts
    while (dom.toastStack.children.length >= CONFIG.MAX_TOASTS) {
      dom.toastStack.removeChild(dom.toastStack.firstChild);
    }

    var el = document.createElement('div');
    el.className = 'toast toast--' + level;
    el.textContent = text.length > 120 ? text.slice(0, 117) + '…' : text;

    dom.toastStack.appendChild(el);

    var ttl = (level === 'error') ? CONFIG.TOAST_TTL + 2000 : CONFIG.TOAST_TTL;
    var timer = setTimeout(function () { dismissToast(el); }, ttl);

    el.addEventListener('click', function () {
      clearTimeout(timer);
      dismissToast(el);
    });
  }

  function dismissToast(el) {
    if (!el || !el.parentNode) return;
    el.style.transition = 'opacity 0.2s, transform 0.2s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(30px)';
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  }

  function flushQueue() {
    var q = state.queue.splice(0, state.queue.length);
    q.forEach(function (t) { showToast(t.level, t.text); });
  }

  /* ----------------------------------------------------------------
     Console Panel Rendering
  ---------------------------------------------------------------- */
  var LEVEL_CLASS = {
    error:   'log-entry--err',
    warning: 'log-entry--wrn',
    success: 'log-entry--ok',
    info:    ''
  };

  function renderEntry(entry) {
    if (!dom.logBody) return;

    var div = document.createElement('div');
    div.className = 'log-entry ' + (LEVEL_CLASS[entry.level] || '');

    var html = '<span>' + timeLabel(entry.time) + '</span>' +
               escapeHtml(entry.msg);
    if (entry.detail) {
      html += '\n' + escapeHtml(entry.detail);
    }
    div.innerHTML = html;
    div.style.whiteSpace = 'pre-wrap';

    dom.logBody.appendChild(div);
    dom.logBody.scrollTop = dom.logBody.scrollHeight;
  }

  function renderAll() {
    if (!dom.logBody) return;
    dom.logBody.innerHTML = '';
    state.logs.forEach(renderEntry);
  }

  function updateBadge() {
    if (!dom.logBadge) return;
    if (state.unread > 0) {
      dom.logBadge.textContent = state.unread > 99 ? '99+' : String(state.unread);
      dom.logBadge.style.display = '';
    } else {
      dom.logBadge.style.display = 'none';
    }
  }

  /* ----------------------------------------------------------------
     Panel Open / Close / Clear / Export
  ---------------------------------------------------------------- */
  function openPanel() {
    if (!dom.logPanel) return;
    dom.logPanel.classList.add('log-panel--visible');
    state.unread = 0;
    updateBadge();
    renderAll();
  }

  function closePanel() {
    if (!dom.logPanel) return;
    dom.logPanel.classList.remove('log-panel--visible');
  }

  function togglePanel() {
    if (!dom.logPanel) return;
    if (dom.logPanel.classList.contains('log-panel--visible')) {
      closePanel();
    } else {
      openPanel();
    }
  }

  function clearLogs() {
    state.logs = [];
    state.unread = 0;
    state.lastSig = '';
    updateBadge();
    if (dom.logBody) dom.logBody.innerHTML = '';
    try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (e) {}
    logInfo('Log cleared.');
  }

  function exportLogs() {
    var lines = state.logs.map(function (l) {
      var base = '[' + timeLabel(l.time) + '] [' +
                 l.level.toUpperCase() + '] ' + l.msg;
      return l.detail ? base + '\n    ' + l.detail.replace(/\n/g, '\n    ') : base;
    });
    var text = lines.join('\n');

    // Prefer clipboard; fall back to Telegram alert / console
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        logSuccess('Logs copied to clipboard.');
      }).catch(function () {
        fallbackExport(text);
      });
    } else {
      fallbackExport(text);
    }
  }

  function fallbackExport(text) {
    try {
      if (global.Telegram && global.Telegram.WebApp &&
          global.Telegram.WebApp.showPopup) {
        global.Telegram.WebApp.showPopup({
          title: 'Error Log',
          message: text.slice(0, 4000),
          buttons: [{
	            type: 'close' }]
        });
      } else {
        alert('Check native browser console for log dump.');
        console.log('--- LOG DUMP ---\n' + text);
      }
    } catch (e) {}
  }

  /* ----------------------------------------------------------------
     Global Hooks & Event Listeners
  ---------------------------------------------------------------- */
  function mirrorConsole(level, msg, detail) {
    var fn = (level === 'error') ? 'error' :
             (level === 'warning') ? 'warn' : 'log';
    if (console && typeof console[fn] === 'function') {
      var marker = '[GoldMiner]';
      if (detail) {
        console[fn](marker, msg, detail);
      } else {
        console[fn](marker, msg);
      }
    }
  }

  function init() {
    dom.toastStack = document.getElementById('toast-stack');
    dom.logPanel   = document.getElementById('log-panel');
    dom.logBody    = document.getElementById('log-body');
    dom.logToggle  = document.getElementById('log-toggle');
    dom.logBadge   = document.getElementById('log-badge');

    if (dom.logToggle) {
      dom.logToggle.addEventListener('click', togglePanel);
    }

    var btnClose = document.getElementById('log-close');
    if (btnClose) btnClose.addEventListener('click', closePanel);

    var btnClear = document.getElementById('log-clear');
    if (btnClear) btnClear.addEventListener('click', clearLogs);

    var btnExport = document.getElementById('log-export');
    if (btnExport) btnExport.addEventListener('click', exportLogs);

    state.ready = true;
    flushQueue();
    updateBadge();
    logInfo('GoldMiner ErrorHandler initialized.');
  }

  /* Listen for window errors */
  global.addEventListener('error', function (ev) {
    var msg = ev.error ? (ev.error.message || ev.error) : ev.message;
    var stack = ev.error && ev.error.stack ? ev.error.stack : '';
    logError('Runtime Error: ' + msg, stack);
  });

  /* Listen for unhandled promise rejections */
  global.addEventListener('unhandledrejection', function (ev) {
    var reason = ev.reason;
    var msg = (reason instanceof Error) ? reason.message : safeStringify(reason);
    var stack = (reason instanceof Error && reason.stack) ? reason.stack : '';
    logError('Async Rejection: ' + msg, stack);
  });

  /* ----------------------------------------------------------------
     Initialization Entry Point
  ---------------------------------------------------------------- */
  restore();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Export API to global scope */
  global.AppLog = {
    info: logInfo,
    success: logSuccess,
    warn: logWarning,
    error: logError,
    toggle: togglePanel,
    clear: clearLogs
  };

})(window);
