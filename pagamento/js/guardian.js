/**
 * =====================================================================
 *  GUARDIAN.JS — Anti-Bot Runtime + DevTools Detection v6.0
 *  Sistema multicamada de detecção de bots no client-side.
 *  Obfuscado e auto-protetor.
 *
 *  Detecta:
 *  - Headless Chrome / Puppeteer / Playwright
 *  - Selenium WebDriver
 *  - DevTools aberto (F12)
 *  - Comportamento não-humano (sem mouse movement, sem scroll)
 *  - Canvas fingerprint de ambientes virtualizados
 *  - Automação de formulários (preenchimento instantâneo)
 *  - Referrer de plataformas de auditoria de anúncios
 * =====================================================================
 */

;(function(w, d, n) {
  'use strict';

  // ── Namespace ofuscado ────────────────────────────────────────────
  var _g = {};
  var _s = w['_$gd'] = w['_$gd'] || {};

  // ── Scores ────────────────────────────────────────────────────────
  // Score 0 = robô certo | 100 = humano certo | threshold: 35
  var _score    = 50;
  var _signals  = {};
  var _locked   = false;
  var _pageId   = d.currentScript ? d.currentScript.src.split('?')[1] || 'default' : 'default';

  // ── Adicionar/remover pontos ──────────────────────────────────────
  function _add(key, pts, note) {
    _signals[key] = { pts: pts, note: note };
    _score = Math.min(100, Math.max(0, _score + pts));
  }

  // ─────────────────────────────────────────────────────────────────
  //  1. DETECÇÃO DE WEBDRIVER / SELENIUM
  // ─────────────────────────────────────────────────────────────────
  (function detectWebDriver() {
    try {
      // navigator.webdriver é true quando controlado por automação
      if (n.webdriver === true) { _add('webdriver', -50, 'webdriver=true'); return; }

      // Propriedades injetadas por Selenium/ChromeDriver
      var seleniumProps = [
        '__webdriver_evaluate','__selenium_evaluate','__webdriver_script_function',
        '__webdriver_script_func','__webdriver_script_fn','__fxdriver_evaluate',
        '__driver_unwrapped','__webdriver_unwrapped','__driver_evaluate',
        '__selenium_unwrapped','__fxdriver_unwrapped','_Selenium_IDE_Recorder',
        '_selenium','callSelenium','_WEBDRIVER_ELEM_CACHE','ChromeDriverw',
        'domAutomation','domAutomationController','__nightmare','nightmare',
      ];
      for (var i = 0; i < seleniumProps.length; i++) {
        if (seleniumProps[i] in w) { _add('selenium_prop', -40, seleniumProps[i]); return; }
      }

      // Chrome devtools protocol: cdc_ prefixed properties
      var keys = Object.keys(d);
      for (var k = 0; k < keys.length; k++) {
        if (/^cdc_/.test(keys[k])) { _add('cdc_prop', -45, keys[k]); return; }
      }

      _add('no_webdriver', +15, 'clean');
    } catch(e) {}
  }());

  // ─────────────────────────────────────────────────────────────────
  //  2. DETECÇÃO DE HEADLESS CHROME / PUPPETEER
  // ─────────────────────────────────────────────────────────────────
  (function detectHeadless() {
    try {
      // Chrome headless antigo não tem plugins
      var plugins = n.plugins;
      if (!plugins || plugins.length === 0) {
        _add('no_plugins', -20, 'no plugins');
      } else {
        _add('has_plugins', +10, plugins.length + ' plugins');
      }

      // User agent inconsistency
      var ua = n.userAgent || '';
      if (/HeadlessChrome/.test(ua)) { _add('headless_ua', -50, 'headless ua'); return; }

      // Permissions API: headless falha de forma diferente
      if (n.permissions) {
        n.permissions.query({ name: 'notifications' }).then(function(perm) {
          if (perm.state === 'denied' && n.userAgent.indexOf('Chrome') !== -1) {
            // Notificações negadas + Chrome = suspeito em headless
            _add('perm_denied', -10, 'notifications denied');
          }
        }).catch(function() {});
      }

      // Chrome tem window.chrome definido; headless às vezes não
      if (/Chrome/.test(ua) && !w.chrome) {
        _add('no_chrome_obj', -25, 'chrome ua but no chrome obj');
      }

      // Detectar via outerWidth/outerHeight (headless usa 0)
      if (w.outerWidth === 0 && w.outerHeight === 0) {
        _add('zero_outer', -20, 'outerWidth=0');
      }
    } catch(e) {}
  }());

  // ─────────────────────────────────────────────────────────────────
  //  3. CANVAS FINGERPRINT (detectar ambientes virtuais)
  // ─────────────────────────────────────────────────────────────────
  (function detectCanvas() {
    try {
      var canvas  = d.createElement('canvas');
      var ctx     = canvas.getContext('2d');
      if (!ctx) { _add('no_canvas', -15, 'no canvas ctx'); return; }

      canvas.width  = 200;
      canvas.height = 50;

      ctx.textBaseline = 'top';
      ctx.font         = '14px Arial';
      ctx.fillStyle    = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle    = '#069';
      ctx.fillText('MP Checkout', 2, 15);
      ctx.fillStyle    = 'rgba(102,204,0,0.7)';
      ctx.fillText('MP Checkout', 4, 17);

      var dataURL = canvas.toDataURL();

      // Ambientes headless retornam canvas em branco ou com hash consistente
      if (!dataURL || dataURL === 'data:,') {
        _add('empty_canvas', -30, 'blank canvas');
        return;
      }

      // Hash simples do canvas
      var hash = 0;
      for (var i = 0; i < dataURL.length; i++) {
        hash = ((hash << 5) - hash) + dataURL.charCodeAt(i);
        hash |= 0;
      }
      _s.canvasHash = hash;
      _add('canvas_ok', +10, 'hash=' + Math.abs(hash).toString(16));
    } catch(e) {}
  }());

  // ─────────────────────────────────────────────────────────────────
  //  4. COMPORTAMENTO HUMANO — Mouse, Touch, Teclado
  // ─────────────────────────────────────────────────────────────────
  var _behavior = {
    mouseEvents:   0,
    touchEvents:   0,
    keyEvents:     0,
    scrollEvents:  0,
    clickEvents:   0,
    firstMouse:    0,
    mousePath:     [],
    fieldFocusTimes: {},
    fieldTimings:    {},
    pasteEvents:   [],
  };

  (function bindBehavior() {
    // Mouse movement — bots geralmente não movem o mouse
    d.addEventListener('mousemove', function(e) {
      if (_behavior.firstMouse === 0) _behavior.firstMouse = Date.now();
      _behavior.mouseEvents++;
      if (_behavior.mousePath.length < 20) {
        _behavior.mousePath.push({ x: e.clientX, y: e.clientY, t: Date.now() });
      }
    }, { passive: true });

    // Touch events (mobile)
    d.addEventListener('touchstart', function() {
      _behavior.touchEvents++;
    }, { passive: true });

    // Teclado
    d.addEventListener('keydown', function() {
      _behavior.keyEvents++;
    }, { passive: true });

    // Scroll
    d.addEventListener('scroll', function() {
      _behavior.scrollEvents++;
    }, { passive: true });

    // Cliques
    d.addEventListener('click', function() {
      _behavior.clickEvents++;
    }, { passive: true });

    // Foco em campos — medir tempo de preenchimento
    d.addEventListener('focusin', function(e) {
      if (e.target && e.target.id) {
        _behavior.fieldFocusTimes[e.target.id] = Date.now();
      }
    }, { passive: true });

    d.addEventListener('focusout', function(e) {
      if (e.target && e.target.id && _behavior.fieldFocusTimes[e.target.id]) {
        var t = Date.now() - _behavior.fieldFocusTimes[e.target.id];
        _behavior.fieldTimings[e.target.id] = t;
        delete _behavior.fieldFocusTimes[e.target.id];
      }
    }, { passive: true });

    // Detectar paste em campos de cartão (suspeito em bots)
    d.addEventListener('paste', function(e) {
      var id = (e.target && e.target.id) ? e.target.id : 'unknown';
      _behavior.pasteEvents.push({ field: id, t: Date.now() });
    }, { passive: true });
  }());

  // ─────────────────────────────────────────────────────────────────
  //  5. DETECÇÃO DE DEVTOOLS (F12)
  // ─────────────────────────────────────────────────────────────────
  var _devtools = { open: false, threshold: 160 };

  (function detectDevTools() {
    // Método 1: diferença de tamanho de janela
    function checkSize() {
      var widthDiff  = w.outerWidth  - w.innerWidth;
      var heightDiff = w.outerHeight - w.innerHeight;
      var wasOpen = _devtools.open;
      _devtools.open = widthDiff > _devtools.threshold || heightDiff > _devtools.threshold;
      if (_devtools.open && !wasOpen) {
        _add('devtools_opened', -35, 'devtools detected via size');
        _s.devtoolsDetected = true;
      }
    }
    setInterval(checkSize, 1000);

    // Método 2: console.log com getter (acessa quando DevTools está aberto)
    try {
      var _dt = new Image();
      Object.defineProperty(_dt, 'id', {
        get: function() {
          _devtools.open = true;
          _add('devtools_console', -35, 'console getter triggered');
        }
      });
      console.log(_dt); // Silencioso
      console.clear && console.clear();
    } catch(e) {}

    // Método 3: Function.prototype.toString trap
    try {
      var _orig = Function.prototype.toString;
      Function.prototype.toString = function() {
        if (this === Function.prototype.toString) return 'function toString() { [native code] }';
        return _orig.call(this);
      };
    } catch(e) {}
  }());

  // ─────────────────────────────────────────────────────────────────
  //  6. ANÁLISE DE REFERRER (plataformas de anúncio suspeitas)
  // ─────────────────────────────────────────────────────────────────
  (function checkReferrer() {
    var ref = d.referrer || '';
    var suspiciousRefs = [
      'adbeat.com', 'moat.com', 'doubleverify.com', 'integralads.com',
      'pixalate.com', 'geoedge.com', 'adscanner.io', 'adclarity.com',
      'brandwatch.com', 'similarweb.com', 'semrush.com', 'ahrefs.com',
    ];
    for (var i = 0; i < suspiciousRefs.length; i++) {
      if (ref.indexOf(suspiciousRefs[i]) !== -1) {
        _add('bad_referrer', -40, ref);
        return;
      }
    }
  }());

  // ─────────────────────────────────────────────────────────────────
  //  7. OBFUSCAÇÃO DE STRINGS CRÍTICAS (rot-runtime)
  // ─────────────────────────────────────────────────────────────────
  // Strings sensíveis são armazenadas rotacionadas e decodificadas em runtime
  var _R = (function() {
    var _k = 13; // ROT13 key
    return {
      d: function(s) {
        return s.replace(/[a-zA-Z]/g, function(c) {
          return String.fromCharCode(
            (c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + _k) ? c : c - 26
          );
        });
      }
    };
  }());

  // ─────────────────────────────────────────────────────────────────
  //  8. API PÚBLICA — getScore()
  // ─────────────────────────────────────────────────────────────────
  function computeFinalScore(pageName) {
    var page = pageName || 'unknown';
    var now  = Date.now();

    // Avaliar comportamento acumulado
    var hasInteraction = _behavior.mouseEvents > 3 || _behavior.touchEvents > 0;
    var hasKeyboard    = _behavior.keyEvents > 2;
    var timeOnPage     = now - (w._pageStartTime || now);

    if (hasInteraction) _add('mouse_ok',   +20, _behavior.mouseEvents + ' moves');
    else                _add('no_mouse',   -20, 'no mouse/touch');

    if (hasKeyboard)    _add('keyboard_ok', +10, _behavior.keyEvents + ' keys');

    if (timeOnPage > 5000) _add('time_ok',  +10, timeOnPage + 'ms');
    else                   _add('too_fast', -15, 'too fast: ' + timeOnPage + 'ms');

    // Verificar se houve preenchimento instantâneo (bots)
    var fieldIds = Object.keys(_behavior.fieldTimings);
    var tooFast  = 0;
    for (var i = 0; i < fieldIds.length; i++) {
      if (_behavior.fieldTimings[fieldIds[i]] < 800) tooFast++;
    }
    if (tooFast >= 3) _add('instant_fill', -25, tooFast + ' fields filled instantly');

    // Verificar mouse path (movimento humano é irregular)
    if (_behavior.mousePath.length >= 5) {
      var diffs = 0;
      for (var j = 1; j < _behavior.mousePath.length; j++) {
        var dx = _behavior.mousePath[j].x - _behavior.mousePath[j-1].x;
        var dy = _behavior.mousePath[j].y - _behavior.mousePath[j-1].y;
        if (Math.abs(dx) > 0 || Math.abs(dy) > 0) diffs++;
      }
      if (diffs > 3) _add('natural_mouse', +10, 'varied path');
    }

    // Touch = definitivamente mobile = humano
    if (_behavior.touchEvents > 0) _add('touch_bonus', +15, 'touch detected');

    var finalScore = Math.min(100, Math.max(0, _score));
    var isHuman    = finalScore >= 35;

    return {
      score:      finalScore,
      human:      isHuman,
      page:       page,
      signals:    _signals,
      devtools:   _devtools.open,
      canvasHash: _s.canvasHash || 0,
      details: {
        mouseEvents:  _behavior.mouseEvents,
        touchEvents:  _behavior.touchEvents,
        keyEvents:    _behavior.keyEvents,
        timeOnPage:   timeOnPage,
        fieldTimings: _behavior.fieldTimings,
        pasteEvents:  _behavior.pasteEvents.length,
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────
  //  9. PROTEÇÃO DE CÓDIGO FONTE (DevTools deterrence)
  // ─────────────────────────────────────────────────────────────────
  (function sourceProtection() {
    // Bloquear botão direito (dificulta "Inspecionar Elemento")
    d.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      return false;
    });

    // Bloquear atalhos comuns de DevTools
    d.addEventListener('keydown', function(e) {
      // F12
      if (e.keyCode === 123) { e.preventDefault(); return false; }
      // Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C / Ctrl+U (view-source)
      if (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67)) {
        e.preventDefault(); return false;
      }
      if (e.ctrlKey && e.keyCode === 85) { e.preventDefault(); return false; }
      // Ctrl+S (salvar página)
      if (e.ctrlKey && e.keyCode === 83) { e.preventDefault(); return false; }
    });

    // Mensagem no console para desencorajar inspeção
    if (w.console) {
      var style1 = 'color:#009ee3;font-size:24px;font-weight:bold;';
      var style2 = 'color:#333;font-size:14px;';
      console.log('%c⚠ Mercado Pago Security', style1);
      console.log('%cEste é um ambiente monitorado. Qualquer tentativa de manipulação é registrada.', style2);
      console.log('%cTransação ID: ' + Math.random().toString(36).substring(2,12).toUpperCase(), style2);
    }
  }());

  // ─────────────────────────────────────────────────────────────────
  //  10. EXPOSIÇÃO PÚBLICA
  // ─────────────────────────────────────────────────────────────────
  w._pageStartTime = Date.now();

  // Expor via namespace seguro (chave aleatória por sessão)
  var _ns = '_' + Math.random().toString(36).slice(2, 8);
  w[_ns] = {
    score:      function(page) { return computeFinalScore(page); },
    behavior:   function()     { return _behavior; },
    devtools:   function()     { return _devtools.open; },
  };

  // Bridge para o SDK existente
  if (w._SDK && w._SDK.antiBot) {
    var _origGetScore = w._SDK.antiBot.getScore;
    w._SDK.antiBot.getScore = function(page) {
      var guardianScore = computeFinalScore(page);
      // Merge com score do SDK original
      try {
        var sdkScore = _origGetScore ? _origGetScore.call(w._SDK.antiBot, page) : { score: 50, human: true };
        return {
          score:   Math.min(guardianScore.score, sdkScore.score || 100),
          human:   guardianScore.human && (sdkScore.human !== false),
          details: guardianScore.details,
          signals: guardianScore.signals,
        };
      } catch(e) {
        return guardianScore;
      }
    };
  }

  // Também expor no namespace padrão para o cartao1.php acessar
  w.__guardian = { getScore: computeFinalScore };

}(window, document, navigator));
