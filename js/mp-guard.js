/* ============================================================
   MP-Guard v2.0 — Anti-bot / Anti-lead-falso / Anti-cloaker
   Injete este script no <head> do index.html
   ============================================================ */
(function () {
  'use strict';

  /* ── 1. Headless / bot fingerprinting ────────────────────── */
  var _botSig = {
    webdriver:  !!navigator.webdriver,
    phantom:    !!(window.callPhantom || window._phantom),
    headless:   /HeadlessChrome|PhantomJS/.test(navigator.userAgent),
    pythonCurl: /python-requests|python\/|curl\/|wget\/|libwww/i.test(navigator.userAgent),
    noPlugins:  navigator.plugins.length === 0 && !/Android|iPhone|iPad/.test(navigator.userAgent),
    selenium:   !!(document.documentElement &&
                   (document.documentElement.__selenium_unwrapped ||
                    document.documentElement.__webdriver_script_fn ||
                    document.documentElement.__driver_evaluate))
  };

  var _botScore = 0;
  for (var k in _botSig) { if (_botSig[k]) _botScore++; }

  /* ── 2. Entropy (interação humana) ───────────────────────── */
  var _ent = { m: 0, t: 0, k: 0, s: 0 };

  ['mousemove', 'mousedown'].forEach(function (e) {
    document.addEventListener(e, function () { _ent.m++; }, { passive: true });
  });
  ['touchstart', 'touchmove'].forEach(function (e) {
    document.addEventListener(e, function () { _ent.t++; }, { passive: true });
  });
  document.addEventListener('keydown', function () { _ent.k++; }, { passive: true });
  window.addEventListener('scroll',    function () { _ent.s++; }, { passive: true });

  /* ── 3. Session token ────────────────────────────────────── */
  var _st = sessionStorage.getItem('_mpx');
  if (!_st) {
    _st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('_mpx', _st);
  }

  /* ── 4. API pública ──────────────────────────────────────── */
  window._MPGuard = {
    isBot:     function () { return _botScore >= 2; },
    hasHuman:  function () { return _ent.m > 3 || _ent.t > 1 || _ent.k > 0; },
    score:     _botScore,
    signals:   _botSig,
    token:     _st,
    entropy:   _ent
  };

  /* ── 5. DOM ready — proteções ────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {

    /* Bot flagrante: esconder conteúdo e exibir página limpa */
    if (_botScore >= 3) {
      document.querySelectorAll('body > *:not(script)').forEach(function (el) {
        el.style.display = 'none';
      });
      var decoy = document.createElement('div');
      decoy.style.cssText = 'display:flex;justify-content:center;align-items:center;height:100vh;background:#fff;';
      decoy.innerHTML = '<img src="https://http2.mlstatic.com/frontend-assets/ml-web-navigation/ui-navigation/6.6.92/mercadolibre/logo__large_plus@2x.png" style="max-width:200px;" alt="Mercado Livre">';
      document.body.appendChild(decoy);
      return;
    }

    /* Rate-limit em links para o checkout (30s entre cliques) */
    var RL_KEY = '_mp_rl_idx';
    document.querySelectorAll('a[href*="pagamento"], a[href*="comprar"], a[href*="checkout"]')
      .forEach(function (a) {
        a.addEventListener('click', function (ev) {
          var last = parseInt(localStorage.getItem(RL_KEY) || '0', 10);
          if (Date.now() - last < 30000 && last > 0) {
            ev.preventDefault();
            return;
          }
          localStorage.setItem(RL_KEY, Date.now().toString());
        });
      });
  });

}());
