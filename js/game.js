/* ================================================================
   game.js
   Core Gold Miner engine: canvas render loop, swinging claw,
   grab/retract physics, level/shop flow, and Telegram sendData().

   Depends on: window.AppLog (errorHandler.js)
               window.GM.settings (settings.js)
   Exposes:    window.GM.game
   ================================================================ */
(function (global) {
  'use strict';

  var log = global.AppLog || {
    info: function () {}, success: function () {},
    warn: function () {}, error: function () {}
  };

  var Settings = (global.GM && global.GM.settings) || null;

  /* ----------------------------------------------------------------
     Telegram WebApp handle (graceful fallback when run standalone)
  ---------------------------------------------------------------- */
  var TG = (global.Telegram && global.Telegram.WebApp) ? global.Telegram.WebApp : null;

  /* ----------------------------------------------------------------
     Tuning constants
  ---------------------------------------------------------------- */
  var BASE_W = 720;          // logical design width
  var BASE_H = 1280;         // logical design height
  var FRAME_MS = 1000 / 60;  // target step

  var CLAW = {
    pivotY: 90,            // y of the rotating hook anchor (logical)
    minAngle: -Math.PI * 0.46,
    maxAngle:  Math.PI * 0.46,
    swingSpeed: 1.6,       // rad/s base
    extendSpeed: 620,      // px/s out
    baseRetract: 360,      // px/s back (modified by weight + strength)
    size: 34
  };

  var DIFFICULTY = {
    easy:   { swing: 1.25, retract: 1.25, items: 7,  rockChance: 0.20 },
    normal: { swing: 1.6,  retract: 1.0,  items: 9,  rockChance: 0.32 },
    hard:   { swing: 2.0,  retract: 0.85, items: 11, rockChance: 0.42 }
  };

  var SHOP_ITEMS = [
    { id: 'dynamite', icon: '🧨', name: 'Dynamite',
      desc: 'Blast a grabbed rock into rubble for quick points.', price: 60 },
    { id: 'strength', icon: '🧪', name: 'Strength Potion',
      desc: 'Reel heavy items in faster for one level.',        price: 80 },
    { id: 'clover',   icon: '🍀', name: 'Lucky Clover',
      desc: '+25% value on everything you grab next level.',     price: 100 }
  ];

  /* ----------------------------------------------------------------
     Item archetypes (value scales with size/weight)
  ---------------------------------------------------------------- */
  var TYPES = {
    goldSmall:  { kind: 'gold', color: '#FFD54A', r: 22, value: 50,  weight: 1.0, label: 'Gold' },
    goldBig:    { kind: 'gold', color: '#FFC107', r: 40, value: 150, weight: 2.2, label: 'Gold' },
    diamond:    { kind: 'gem',  color: '#7FE3FF', r: 20, value: 400, weight: 0.7, label: 'Diamond' },
    rockSmall:  { kind: 'rock', color: '#8d8d96', r: 26, value: 12,  weight: 2.0, label: 'Rock' },
    rockBig:    { kind: 'rock', color: '#73737d', r: 46, value: 24,  weight: 3.4, label: 'Rock' },
    bag:        { kind: 'bag',  color: '#C9A062', r: 24, value: 0,   weight: 1.2, label: 'Mystery' }
  };

  /* ----------------------------------------------------------------
     Game state
  ---------------------------------------------------------------- */
  var S = {
    cfg: null,
    canvas: null, ctx: null,
    dpr: 1,
    scale: 1, offX: 0, offY: 0,   // logical -> device mapping
    running: false, paused: false,
    raf: 0, lastTs: 0, acc: 0,

    level: 1,
    score: 0,
    sessionScore: 0,              // carries across levels for shop currency
    target: 0,
    timeLeft: 0,

    claw: {
      angle: 0, dir: 1,
      state: 'swing',             // swing | extend | retract
      len: 0,
      holding: null
    },
    items: [],
    inventory: { dynamite: 0, strength: 0, clover: 0 },
    activeBoost: { strength: false, clover: false },

    dom: {}
  };

  /* ----------------------------------------------------------------
     DOM
  ---------------------------------------------------------------- */
  function cacheDom() {
    var d = S.dom;
    d.canvas        = document.getElementById('gameCanvas');
    d.btnFire       = document.getElementById('btnFire');

    d.hudScore      = document.getElementById('hudScore');
    d.hudTarget     = document.getElementById('hudTarget');
    d.hudLevel      = document.getElementById('hudLevel');
    d.hudTime       = document.getElementById('hudTime');

    d.overlayMenu   = document.getElementById('overlayMenu');
    d.btnPlay       = document.getElementById('btnPlay');
    d.btnHowTo      = document.getElementById('btnHowTo');
    d.menuBest      = document.getElementById('menuBest');

    d.overlayHowTo  = document.getElementById('overlayHowTo');
    d.btnHowToClose = document.getElementById('btnHowToClose');

    d.overlayShop   = document.getElementById('overlayShop');
    d.shopGrid      = document.getElementById('shopGrid');
    d.shopBalance   = document.getElementById('shopBalance');
    d.btnShopGo     = document.getElementById('btnShopContinue');

    d.overlayDone   = document.getElementById('overlayLevelDone');
    d.doneText      = document.getElementById('levelDoneText');
    d.btnNext       = document.getElementById('btnNextLevel');

    d.overlayOver   = document.getElementById('overlayGameOver');
    d.overScore     = document.getElementById('gameOverScore');
    d.btnSend       = document.getElementById('btnSendScore');
    d.btnRestart    = document.getElementById('btnRestart');
  }

  /* ----------------------------------------------------------------
     Canvas sizing (responsive, DPR-aware, 60fps friendly)
  ---------------------------------------------------------------- */
  function resize() {
    var c = S.canvas;
    if (!c) return;
    var rect = c.getBoundingClientRect();
    var cssW = Math.max(1, rect.width);
    var cssH = Math.max(1, rect.height);

    S.dpr = Math.min(global.devicePixelRatio || 1, 2.5);
    c.width  = Math.round(cssW * S.dpr);
    c.height = Math.round(cssH * S.dpr);

    // Fit BASE_W x BASE_H into the canvas while preserving aspect (contain)
    var sx = cssW / BASE_W;
    var sy = cssH / BASE_H;
    S.scale = Math.min(sx, sy);
    S.offX = (cssW - BASE_W * S.scale) / 2;
    S.offY = (cssH - BASE_H * S.scale) / 2;
  }

  /* ----------------------------------------------------------------
     Level setup
  ---------------------------------------------------------------- */
  function difficulty() {
    var name = (S.cfg && S.cfg.difficulty) || 'normal';
    return DIFFICULTY[name] || DIFFICULTY.normal;
  }

  function startGame() {
    S.cfg = Settings ? Settings.get() : {
      startTime: 60, scoreMult: 1, difficulty: 'normal', sound: true
    };
    S.level = 1;
    S.score = 0;
    S.sessionScore = 0;
    S.inventory = { dynamite: 0, strength: 0, clover: 0 };
    hideAllOverlays();
    setupLevel();
    S.running = true;
    S.paused = false;
    log.success('Game started. Difficulty: ' + S.cfg.difficulty);
    loop(performance.now());
  }

  function setupLevel() {
    var diff = difficulty();
    S.timeLeft = S.cfg.startTime;
    // Target grows each level and respects the configured multiplier
    S.target = Math.round((400 + (S.level - 1) * 320) * (S.cfg.scoreMult || 1));
    S.score = S.sessionScore; // continue accumulating across the run

    S.claw.angle = 0;
    S.claw.dir = 1;
    S.claw.state = 'swing';
    S.claw.len = 0;
    S.claw.holding = null;

    S.activeBoost.strength = S.inventory.strength > 0;
    S.activeBoost.clover   = S.inventory.clover > 0;
    if (S.activeBoost.strength) { S.inventory.strength--; log.info('Strength Potion active this level.'); }
    if (S.activeBoost.clover)   { S.inventory.clover--;   log.info('Lucky Clover active this level.'); }

    generateItems(diff);
    updateHud();
    log.info('Level ' + S.level + ' — target ' + S.target);
  }

  function generateItems(diff) {
    S.items = [];
    var count = diff.items + (S.level - 1);
    var fieldTop = 360, fieldBottom = BASE_H - 60;
    var attempts = 0;

    while (S.items.length < count && attempts < count * 40) {
      attempts++;
      var t = pickType(diff);
      var def = TYPES[t];
      var x = rand(def.r + 20, BASE_W - def.r - 20);
      var y = rand(fieldTop, fieldBottom - def.r);

      if (overlaps(x, y, def.r)) continue;

      var val = def.value;
      var bagType = null;
      if (def.kind === 'bag') {
        bagType = Math.random() < 0.5 ? 'diamond' : 'rockBig';
        val = TYPES[bagType].value;
      }

      S.items.push({
        type: t, def: def, x: x, y: y, r: def.r,
        value: val, weight: def.weight,
        grabbed: false, gone: false, bagType: bagType,
        spin: Math.random() * Math.PI
      });
    }
  }

  function pickType(diff) {
    var roll = Math.random();
    if (roll < diff.rockChance) {
      return Math.random() < 0.5 ? 'rockSmall' : 'rockBig';
    }
    roll = Math.random();
    if (roll < 0.10) return 'diamond';
    if (roll < 0.22) return 'bag';
    if (roll < 0.55) return 'goldSmall';
    return 'goldBig';
  }

  function overlaps(x, y, r) {
    for (var i = 0; i < S.items.length; i++) {
      var it = S.items[i];
      var dx = it.x - x, dy = it.y - y;
      if (Math.sqrt(dx * dx + dy * dy) < it.r + r + 14) return true;
    }
    return false;
  }

  /* ----------------------------------------------------------------
     Input — unified pointer (touch + mouse)
  ---------------------------------------------------------------- */
  function bindInput() {
    var fire = function (e) {
      if (e) { e.preventDefault(); }
      fireClaw();
    };

    if (S.dom.btnFire) {
      S.dom.btnFire.addEventListener('touchstart', fire, { passive: false });
      S.dom.btnFire.addEventListener('mousedown', fire);
    }

    // Tap anywhere on the canvas also fires the claw
    if (S.canvas) {
      S.canvas.addEventListener('touchstart', fire, { passive: false });
      S.canvas.addEventListener('mousedown', fire);
    }

    // Spacebar / Enter for desktop testing
    global.addEventListener('keydown', function (e) {
      if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); fireClaw(); }
      if (e.key === 'd' || e.key === 'D') useDynamite();
    });

    global.addEventListener('resize', resize);
    if (TG) { TG.onEvent('viewportChanged', resize); }
  }

  function fireClaw() {
    if (!S.running || S.paused) return;
    if (S.claw.state === 'swing') {
      S.claw.state = 'extend';
      log.info('Claw fired.');
    } else if (S.claw.holding && S.inventory.dynamite > 0 &&
               S.claw.holding.def.kind === 'rock') {
      // While reeling a rock, a tap can trigger dynamite if owned
      useDynamite();
    }
  }

  function useDynamite() {
    if (S.inventory.dynamite <= 0) return;
    if (!S.claw.holding) { log.warn('Dynamite needs a grabbed item.'); return; }
    var h = S.claw.holding;
    S.inventory.dynamite--;
    // Convert held item into a quick small payout and retract instantly
    if (h.def.kind === 'rock') {
      h.value = 30; // rubble bonus
      log.success('Dynamite! Rock blasted for ' + h.value);
    } else {
      log.info('Dynamite used.');
    }
    S.claw.len = clawTipMin();
    finalizeGrab();
  }

  /* ----------------------------------------------------------------
     Update / Physics
  ---------------------------------------------------------------- */
  function clawTipMin() { return CLAW.size; }
  function maxLen() { return BASE_H - CLAW.pivotY - 30; }

  function update(dt) {
    if (S.paused || !S.running) return;

    // Timer
    S.timeLeft -= dt;
    if (S.timeLeft <= 0) {
      S.timeLeft = 0;
      updateHud();
      return endLevel();
    }

    var claw = S.claw;
    var diff = difficulty();

    if (claw.state === 'swing') {
      var speed = CLAW.swingSpeed * diff.swing;
      claw.angle += claw.dir * speed * dt;
      if (claw.angle > CLAW.maxAngle) { claw.angle = CLAW.maxAngle; claw.dir = -1; }
      if (claw.angle < CLAW.minAngle) { claw.angle = CLAW.minAngle; claw.dir = 1; }

    } else if (claw.state === 'extend') {
      claw.len += CLAW.extendSpeed * dt;
      var tip = clawTip();
      var hit = hitTest(tip.x, tip.y);
      if (hit) {
        hit.grabbed = true;
        claw.holding = hit;
        claw.state = 'retract';
        log.info('Grabbed ' + (hit.def.label) + ' (' + hit.value + ')');
      } else if (claw.len >= maxLen()) {
        claw.state = 'retract';
      }

    } else if (claw.state === 'retract') {
      var weight = claw.holding ? claw.holding.weight : 1.0;
      var strengthMul = S.activeBoost.strength ? 1.8 : 1.0;
      var rate = (CLAW.baseRetract * diff.retract) / weight * strengthMul;
      claw.len -= rate * dt;

      if (claw.holding) {
        var tip2 = clawTip();
        claw.holding.x = tip2.x;
        claw.holding.y = tip2.y;
      }

      if (claw.len <= clawTipMin()) {
        claw.len = 0;
        finalizeGrab();
      }
    }

    // gentle idle spin for visuals
    for (var i = 0; i < S.items.length; i++) {
      if (S.items[i].def.kind === 'gem') S.items[i].spin += dt * 1.2;
    }
  }

  function clawTip() {
    var a = S.claw.angle - Math.PI / 2; // 0 hangs straight down
    var len = Math.max(S.claw.len, clawTipMin());
    return {
      x: BASE_W / 2 + Math.cos(a) * len,
      y: CLAW.pivotY + Math.sin(a) * len
    };
  }

  function hitTest(x, y) {
    for (var i = 0; i < S.items.length; i++) {
      var it = S.items[i];
      if (it.grabbed || it.gone) continue;
      var dx = it.x - x, dy = it.y - y;
      if (dx * dx + dy * dy <= (it.r + CLAW.size * 0.4) * (it.r + CLAW.size * 0.4)) {
        return it;
      }
    }
    return null;
  }

  function finalizeGrab() {
    var h = S.claw.holding;
    if (h) {
      var gained = h.value;
      if (S.activeBoost.clover) gained = Math.round(gained * 1.25);
      S.sessionScore += gained;
      S.score = S.sessionScore;
      h.gone = true;
      // remove from field
      var idx = S.items.indexOf(h);
      if (idx >= 0) S.items.splice(idx, 1);
      log.success('+' + gained + ' (' + h.def.label + ')');
    }
    S.claw.holding = null;
    S.claw.state = 'swing';
    S.claw.len = 0;
    updateHud();

    if (S.score >= S.target) {
      endLevel();
    }
  }

  /* ----------------------------------------------------------------
     Rendering
  ---------------------------------------------------------------- */
  function render() {
    var ctx = S.ctx;
    if (!ctx) return;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, S.canvas.width, S.canvas.height);

    ctx.save();
    ctx.translate(S.offX, S.offY);
    ctx.scale(S.scale, S.scale);

    drawBackground(ctx);
    drawItems(ctx);
    drawClaw(ctx);

    ctx.restore();
  }

  function drawBackground(ctx) {
    // sky band
    var sky = ctx.createLinearGradient(0, 0, 0, 320);
    sky.addColorStop(0, '#1b2436');
    sky.addColorStop(1, '#2c3a4f');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, BASE_W, 320);

    // dirt
    var dirt = ctx.createLinearGradient(0, 320, 0, BASE_H);
    dirt.addColorStop(0, '#5a3d23');
    dirt.addColorStop(1, '#3a2614');
    ctx.fillStyle = dirt;
    ctx.fillRect(0, 320, BASE_W, BASE_H - 320);

    // surface line
    ctx.fillStyle = '#6b4a2b';
    ctx.fillRect(0, 314, BASE_W, 8);

    // pivot machine
    ctx.fillStyle = '#cfd6e4';
    ctx.fillRect(BASE_W / 2 - 46, CLAW.pivotY - 70, 92, 60);
    ctx.fillStyle = '#9aa3b5';
    ctx.fillRect(BASE_W / 2 - 10, CLAW.pivotY - 12, 20, 14);
  }

  function drawItems(ctx) {
    for (var i = 0; i < S.items.length; i++) {
      var it = S.items[i];
      if (it.gone) continue;
      ctx.save();
      ctx.translate(it.x, it.y);

      if (it.def.kind === 'gem') {
        drawGem(ctx, it);
      } else if (it.def.kind === 'rock') {
        drawRock(ctx, it);
      } else if (it.def.kind === 'bag') {
        drawBag(ctx, it);
      } else {
        drawGold(ctx, it);
      }
      ctx.restore();
    }
  }

  function drawGold(ctx, it) {
    var g = ctx.createRadialGradient(-it.r * 0.3, -it.r * 0.3, it.r * 0.2, 0, 0, it.r);
    g.addColorStop(0, '#FFF1A8');
    g.addColorStop(1, it.def.color);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, it.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 3; ctx.stroke();
  }

  function drawGem(ctx, it) {
    ctx.rotate(it.spin);
    ctx.fillStyle = it.def.color;
    ctx.beginPath();
    ctx.moveTo(0, -it.r);
    ctx.lineTo(it.r, 0);
    ctx.lineTo(0, it.r);
    ctx.lineTo(-it.r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawRock(ctx, it) {
    ctx.fillStyle = it.def.color;
    ctx.beginPath();
    var pts = 7;
    for (var k = 0; k < pts; k++) {
      var a = (k / pts) * Math.PI * 2;
      var rr = it.r * (0.82 + ((k % 2) ? 0.18 : 0));
      var px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawBag(ctx, it) {
    ctx.fillStyle = it.def.color;
    ctx.beginPath(); ctx.arc(0, 4, it.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#7a5c34';
    ctx.fillRect(-6, -it.r - 2, 12, 12);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + (it.r) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', 0, 4);
  }

  function drawClaw(ctx) {
    var tip = clawTip();
    var px = BASE_W / 2, py = CLAW.pivotY;

    // rope
    ctx.strokeStyle = '#d8b65a';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tip.x, tip.y); ctx.stroke();

    // hook
    ctx.save();
    ctx.translate(tip.x, tip.y);
    var a = S.claw.angle;
    ctx.rotate(a);
    ctx.strokeStyle = '#e9e9ef';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-CLAW.size * 0.6, 0);
    ctx.lineTo(0, CLAW.size * 0.7);
    ctx.lineTo(CLAW.size * 0.6, 0);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#cfd6e4'; ctx.fill();
    ctx.restore();
  }

  /* ----------------------------------------------------------------
     HUD
  ---------------------------------------------------------------- */
  function updateHud() {
    var d = S.dom;
    if (d.hudScore)  d.hudScore.textContent  = S.score;
    if (d.hudTarget) d.hudTarget.textContent = S.target;
    if (d.hudLevel)  d.hudLevel.textContent  = S.level;
    if (d.hudTime) {
      d.hudTime.textContent = Math.ceil(S.timeLeft) + 's';
      if (S.timeLeft <= 10) d.hudTime.classList.add('low');
      else d.hudTime.classList.remove('low');
    }
  }

  /* ----------------------------------------------------------------
     Level / Game flow
  ---------------------------------------------------------------- */
  function endLevel() {
    S.paused = true;
    if (S.score >= S.target) {
      log.success('Level ' + S.level + ' cleared! Score ' + S.score);
      showLevelDone(true);
    } else {
      log.warn('Out of time. Final score ' + S.score);
      gameOver();
    }
  }

  function showLevelDone(passed) {
    var d = S.dom;
    if (d.doneText) {
      d.doneText.textContent = 'Level ' + S.level + ' complete! Score: ' + S.score;
    }
    showOverlay(d.overlayDone);
  }

  function goShop() {
    hideOverlay(S.dom.overlayDone);
    renderShop();
    showOverlay(S.dom.overlayShop);
  }

  function nextLevel() {
    hideAllOverlays();
    S.level++;
    S.paused = false;
    setupLevel();
    S.lastTs = performance.now();
  }

  function gameOver() {
    S.running = false;
    S.paused = true;
    cancelAnimationFrame(S.raf);

    var isBest = Settings ? Settings.setBest(S.score) : false;
    if (S.dom.overScore) {
      S.dom.overScore.textContent = 'Score: ' + S.score +
        (isBest ? '  🏆 New Best!' : '');
    }
    showOverlay(S.dom.overlayOver);
    log.info('Game over at level ' + S.level + ' with ' + S.score + ' points.');
  }

  /* ----------------------------------------------------------------
     Shop
  ---------------------------------------------------------------- */
  function renderShop() {
    var grid = S.dom.shopGrid;
    if (!grid) return;
    grid.innerHTML = '';

    if (S.dom.shopBalance) {
      S.dom.shopBalance.textContent = 'Coins: ' + S.score;
    }

    SHOP_ITEMS.forEach(function (item) {
      var owned = S.inventory[item.id] || 0;
      var card = document.createElement('div');
      card.className = 'shop-item' + (owned ? ' shop-item--owned' : '');

      card.innerHTML =
        '<div class="shop-icon">' + item.icon + '</div>' +
        '<div class="shop-info">' +
          '<div class="shop-name">' + item.name +
            (owned ? ' <span class="shop-owned">×' + owned + '</span>' : '') +
          '</div>' +
          '<div class="shop-desc">' + item.desc + '</div>' +
        '</div>';

      var buy = document.createElement('button');
      buy.className = 'btn btn--accent shop-buy';
      buy.textContent = item.price + ' 🪙';
      buy.addEventListener('click', function () { buyItem(item, buy); });
      card.appendChild(buy);

      grid.appendChild(card);
    });
  }

  function buyItem(item, btn) {
    if (S.score < item.price) {
      log.warn('Not enough coins for ' + item.name + '.');
      return;
    }
    S.score -= item.price;
    S.sessionScore = S.score; // spending reduces carry-over bank
    S.inventory[item.id] = (S.inventory[item.id] || 0) + 1;
    log.success('Bought ' + item.name + '. Owned: ' + S.inventory[item.id]);
    renderShop();
  }

  /* ----------------------------------------------------------------
     Telegram sendData()
  ---------------------------------------------------------------- */
  function sendScore() {
    var payload = {
      type: 'gold_miner_score',
      score: S.score,
      level: S.level,
      difficulty: S.cfg ? S.cfg.difficulty : 'normal',
      ts: Date.now()
    };
    var json = JSON.stringify(payload);

    if (TG && typeof TG.sendData === 'function') {
      try {
        TG.sendData(json);
        log.success('Score sent to Telegram (' + S.score + ').');
        // Telegram closes the WebApp automatically after sendData
      } catch (e) {
        log.error('sendData failed: ' + e.message, e.stack);
      }
    } else {
      log.warn('Not inside Telegram — would send: ' + json);
      if (TG && TG.showPopup) {
        TG.showPopup({ title: 'Score', message: json });
      }
    }
  }

  /* ----------------------------------------------------------------
     Overlay helpers
  ---------------------------------------------------------------- */
  function showOverlay(el) { if (el) el.classList.add('overlay--visible'); }
  function hideOverlay(el) { if (el) el.classList.remove('overlay--visible'); }
  function hideAllOverlays() {
    [S.dom.overlayMenu, S.dom.overlayHowTo, S.dom.overlayShop,
     S.dom.overlayDone, S.dom.overlayOver].forEach(hideOverlay);
  }

  /* ----------------------------------------------------------------
     Main loop — fixed-step accumulator targeting 60 FPS
  ---------------------------------------------------------------- */
  function loop(ts) {
    S.raf = requestAnimationFrame(loop);
    if (!S.lastTs) S.lastTs = ts;
    var frame = ts - S.lastTs;
    S.lastTs = ts;
    if (frame > 250) frame = 250; // avoid spiral after tab pause

    if (S.running && !S.paused) {
      S.acc += frame;
      while (S.acc >= FRAME_MS) {
        update(FRAME_MS / 1000);
        S.acc -= FRAME_MS;
      }
    }
    render();
  }

  /* ----------------------------------------------------------------
     Public hooks used by settings.js
  ---------------------------------------------------------------- */
  function pause()  { S.paused = true; }
  function resume() { if (S.running) { S.paused = false; S.lastTs = performance.now(); } }
  function onSettingsChanged(cfg) {
    S.cfg = cfg;
    log.info('Game received updated settings.');
  }

  /* ----------------------------------------------------------------
     Bind overlay buttons
  ---------------------------------------------------------------- */
  function bindButtons() {
    var d = S.dom;
    if (d.btnPlay)       d.btnPlay.addEventListener('click', startGame);
    if (d.btnHowTo)      d.btnHowTo.addEventListener('click', function () { showOverlay(d.overlayHowTo); });
    if (d.btnHowToClose) d.btnHowToClose.addEventListener('click', function () { hideOverlay(d.overlayHowTo); });

    if (d.btnNext)    d.btnNext.addEventListener('click', goShop);
    if (d.btnShopGo)  d.btnShopGo.addEventListener('click', nextLevel);

    if (d.btnSend)    d.btnSend.addEventListener('click', sendScore);
    if (d.btnRestart) d.btnRestart.addEventListener('click', startGame);
  }

  /* ----------------------------------------------------------------
     Telegram bootstrap
  ---------------------------------------------------------------- */
  function initTelegram() {
    if (!TG) {
      log.warn('Telegram WebApp SDK not detected. Running standalone.');
      return;
    }
    try {
      TG.ready();
      TG.expand();
      TG.setHeaderColor && TG.setHeaderColor('secondary_bg_color');
      log.success('Telegram WebApp ready. Platform: ' + (TG.platform || '?'));
    } catch (e) {
      log.error('Telegram init error: ' + e.message, e.stack);
    }
  }

  /* ----------------------------------------------------------------
     Utilities
  ---------------------------------------------------------------- */
  function rand(min, max) { return min + Math.random() * (max - min); }

  /* ----------------------------------------------------------------
     Init
  ---------------------------------------------------------------- */
  function init() {
    cacheDom();
    S.canvas = S.dom.canvas;
    if (!S.canvas) {
      log.error('Canvas element #gameCanvas not found. Game cannot start.');
      return;
    }
    S.ctx = S.canvas.getContext('2d');

    initTelegram();
    resize();
    bindInput();
    bindButtons();

    // Show best score on the menu
    if (S.dom.menuBest && Settings) {
      S.dom.menuBest.textContent = 'Best: ' + Settings.getBest();
    }

    showOverlay(S.dom.overlayMenu);
    // idle render so the menu has a backdrop
    render();
    log.info('Game module initialized.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Export */
  global.GM = global.GM || {};
  global.GM.game = {
    start:             startGame,
    pause:             pause,
    resume:            resume,
    onSettingsChanged: onSettingsChanged,
    sendScore:         sendScore,
    getState:          function () { return { level: S.level, score: S.score, running: S.running }; }
  };

})(window);
