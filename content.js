/* hideX — content.js
 * Runs in ISOLATED world (default, enforced in manifest via "world": "ISOLATED").
 * Page scripts on x.com cannot read/write this script's variables or chrome.storage.
 * Zero network calls. Zero remote code. textContent only, never innerHTML. No eval.
 */
(() => {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    hideLikes: true,
    hideReplies: true,
    hideReposts: true, // repost + quote share one counter
    hideViews: true,   // impressions
    hideDetail: true,  // expanded-tweet stats bar
    blurUsername: true,
    blurBadge: true,
    blurAvatar: true,
    blurTime: true,
    hoverReveal: true,
    blurPx: 8
  });

  const CLASS_MAP = Object.freeze([
    ['hideLikes', 'ubx-hide-likes'],
    ['hideReplies', 'ubx-hide-replies'],
    ['hideReposts', 'ubx-hide-reposts'],
    ['hideViews', 'ubx-hide-views'],
    ['hideDetail', 'ubx-hide-detail'],
    ['blurUsername', 'ubx-blur-username'],
    ['blurBadge', 'ubx-blur-badge'],
    ['blurAvatar', 'ubx-blur-avatar'],
    ['blurTime', 'ubx-blur-time'],
    ['hoverReveal', 'ubx-hover-reveal']
  ]);

  const BOOL_KEYS = CLASS_MAP.map(([k]) => k).concat(['enabled']);

  // Notification rows are NOT articles: "Aavieeee liked your reply · 16m",
  // "Replying to @handle", Who-to-follow cells. Targeted via cell wrappers.
  const PROFILE_HREF = /^\/[A-Za-z0-9_]{1,15}\/?(?:\?.*)?$/;
  const RESERVED = new Set(['home', 'explore', 'notifications', 'messages', 'bookmarks', 'lists', 'communities', 'premium', 'verified', 'settings', 'search', 'login', 'signup', 'i', 'about', 'tos', 'privacy', 'jobs', 'download', 'compose', 'hashtag']);
  const NOTIF_HINT = /liked your|followed you|replying to|reposted|mentioned you|quoted your|subscribed|started following/i;
  const TIME_TEXT = /^[·•\-]?\s*\d+\s*[smhd]\s*$/;
  const DATE_TEXT = /^[A-Z][a-z]{2}\s+\d{1,2}$/;

  function isProfileHref(href) {
    if (!href || !PROFILE_HREF.test(href)) return false;
    const seg = href.slice(1).split('?')[0].replace(/\/$/, '').toLowerCase();
    return seg.length > 0 && !RESERVED.has(seg);
  }

  let settings = { ...DEFAULTS };

  function sanitize(stored) {
    const out = { ...DEFAULTS };
    if (!stored || typeof stored !== 'object') return out;
    for (const k of BOOL_KEYS) {
      if (typeof stored[k] === 'boolean') out[k] = stored[k];
      else if (stored[k] === 'true') out[k] = true;
      else if (stored[k] === 'false') out[k] = false;
    }
    const px = Number(stored.blurPx);
    out.blurPx = Number.isFinite(px) ? Math.min(20, Math.max(3, Math.round(px))) : DEFAULTS.blurPx;
    return out;
  }

  // 1) OPTIMISTIC: apply defaults synchronously at document_start so first paint
  // already hides — fixes the "sometimes appearing / flash" before storage loads.
  function optimisticApply() {
    const el = document.body || document.documentElement;
    if (!el) return;
    el.style.setProperty('--ubx-blur', `${DEFAULTS.blurPx}px`);
    for (const [, cls] of CLASS_MAP) el.classList.add(cls);
    // documentElement gets classes too (body may not exist yet at document_start)
    if (document.documentElement && document.documentElement !== el) {
      for (const [, cls] of CLASS_MAP) document.documentElement.classList.add(cls);
    }
  }

  function applyClasses() {
    const targets = [document.body, document.documentElement].filter(Boolean);
    for (const t of targets) {
      try {
        t.style.setProperty('--ubx-blur', `${settings.blurPx}px`);
        t.classList.toggle('ubx-disabled', !settings.enabled);
        for (const [key, cls] of CLASS_MAP) {
          t.classList.toggle(cls, !!settings.enabled && !!settings[key]);
        }
        // keep html/body in sync (CSS gates on body, html is backup)
      } catch (_) { /* never break X */ }
    }
    // clear stale JS blur first (a toggled-off setting must unblur immediately),
    // then re-sweep with current settings
    clearJsBlur();
    sweepDetail(document);
    sweepIdentity(document);
  }

  function hideOne(el) {
    if (el && el.classList && !el.classList.contains('ubx-js-hidden')) {
      el.classList.add('ubx-js-hidden');
    }
  }

  // Targeted fallback only — never full-page span sweep (perf + avoids layout thrash).
  // Covers detail stats + any analytics links CSS may miss after X renames.
  function sweepDetail(root) {
    try {
      const scope = root && root.querySelectorAll ? root : document;
      if (!settings.enabled) {
        if (scope === document) {
          document.querySelectorAll('.ubx-js-hidden').forEach((el) => el.classList.remove('ubx-js-hidden'));
        }
        return;
      }
      if (settings.hideViews) {
        scope.querySelectorAll('article[data-testid="tweet"] a[href*="analytics"], article[data-testid="tweet"] a[href*="/views"]').forEach(hideOne);
        if (scope !== document && scope.matches && scope.matches('a[href*="analytics"]')) hideOne(scope);
      }
      if (settings.hideDetail || settings.hideLikes || settings.hideReposts) {
        const q = [];
        if (settings.hideLikes || settings.hideDetail) q.push('a[href$="/likes"]');
        if (settings.hideReposts || settings.hideDetail) q.push('a[href$="/retweets"]', 'a[href$="/quotes"]');
        if (!q.length) return;
        scope.querySelectorAll(q.join(',')).forEach((a) => {
          const href = a.getAttribute ? (a.getAttribute('href') || '') : '';
          const txt = a.textContent || '';
          if (/\/status\//.test(href) || /like|repost|quote|bookmark/i.test(txt)) hideOne(a);
        });
      }
    } catch (_) { /* never break X */ }
  }

  // Identity sweep for NON-article rows: notification cells ("X liked your
  // reply · 16m"), "Replying to @handle" links, Who-to-follow (UserCell).
  // Only blurs profile links OUTSIDE tweet body text — mentions/hashtags/URLs
  // inside [data-testid="tweetText"] are never touched.
  function sweepIdentity(root) {
    try {
      const scope = root && root.querySelectorAll ? root : document;
      if (!settings.enabled) {
        if (scope === document) clearJsBlur();
        return;
      }
      const cells = [];
      const pushCells = (el) => {
        if (el.matches && el.matches('div[data-testid="cellInnerDiv"], div[data-testid="UserCell"]')) cells.push(el);
        el.querySelectorAll('div[data-testid="cellInnerDiv"], div[data-testid="UserCell"]').forEach((c) => cells.push(c));
      };
      if (scope === document) pushCells(document);
      else if (scope.nodeType === 1) pushCells(scope);
      else return;
      for (const cell of cells) {
        if (settings.blurAvatar) {
          cell.querySelectorAll('img[src*="profile_images"], img[src*="pbs.twimg.com/profile"]').forEach((img) => img.classList.add('ubx-js-blur-a'));
        }
        if (settings.blurUsername) {
          cell.querySelectorAll('a[href^="/"]').forEach((a) => {
            if (a.closest('[data-testid="tweetText"]')) return;
            if (isProfileHref(a.getAttribute ? a.getAttribute('href') : null)) a.classList.add('ubx-js-blur-u');
          });
        }
        if (settings.blurBadge) {
          cell.querySelectorAll('svg[aria-label*="Verified"], svg[aria-label*="Premium"], [data-testid*="verifi"]').forEach((s) => {
            if (s.closest && s.closest('[data-testid="tweetText"]')) return;
            s.classList.add('ubx-js-blur-b');
          });
        }
        if (settings.blurTime) {
          cell.querySelectorAll('time').forEach((t) => t.classList.add('ubx-js-blur-t'));
          // notification rows render "· 16m" as plain text (no <time>) — only scan
          // cells that look like notifications to avoid touching tweet content
          if (NOTIF_HINT.test(cell.textContent || '')) {
            cell.querySelectorAll('span').forEach((sp) => {
              if (sp.closest('[data-testid="tweetText"]')) return;
              const t = (sp.textContent || '').trim();
              if (t.length > 12) return;
              if (TIME_TEXT.test(t) || DATE_TEXT.test(t)) sp.classList.add('ubx-js-blur-t');
            });
          }
        }
      }
    } catch (_) { /* never break X */ }
  }

  function clearJsBlur() {
    try {
      document.querySelectorAll('.ubx-js-blur-u, .ubx-js-blur-t, .ubx-js-blur-a, .ubx-js-blur-b').forEach((el) => {
        el.classList.remove('ubx-js-blur-u', 'ubx-js-blur-t', 'ubx-js-blur-a', 'ubx-js-blur-b');
      });
    } catch (_) { /* never break X */ }
  }

  async function load() {
    let stored = null;
    try {
      stored = await chrome.storage.sync.get(DEFAULTS);
    } catch (_) {
      try {
        stored = await chrome.storage.local.get(DEFAULTS);
      } catch (_) { stored = null; }
    }
    settings = sanitize({ ...DEFAULTS, ...(stored || {}) });
    applyClasses();
  }

  // Guard: if page (or another extension) strips our body classes, re-apply.
  // This also defeats naive "unhide via devtools class removal" without touching page JS.
  function guardBodyClasses() {
    if (!document.body) return;
    let raf = false;
    const reapply = () => {
      if (raf) return;
      raf = true;
      requestAnimationFrame(() => {
        raf = false;
        const b = document.body;
        if (!b || !settings.enabled) return;
        let missing = false;
        for (const [key, cls] of CLASS_MAP) {
          if (settings[key] && !b.classList.contains(cls)) { missing = true; break; }
        }
        if (missing) applyClasses();
      });
    };
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'class') { reapply(); return; }
        if (m.type === 'childList' && m.addedNodes && m.addedNodes.length) {
          // only sweep added subtrees (fast), not whole document
          for (const n of m.addedNodes) {
            if (n && n.nodeType === 1) { sweepDetail(n); sweepIdentity(n); }
          }
        }
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  function hookSpaNav() {
    try {
      const origPush = history.pushState;
      history.pushState = function (...args) {
        const r = origPush.apply(this, args);
        setTimeout(applyClasses, 250);
        return r;
      };
      const origReplace = history.replaceState;
      history.replaceState = function (...args) {
        const r = origReplace.apply(this, args);
        setTimeout(applyClasses, 250);
        return r;
      };
    } catch (_) { /* page locked history — ignore */ }
    window.addEventListener('popstate', () => setTimeout(applyClasses, 250), { passive: true });
  }

  // ---- boot ----
  optimisticApply(); // sync, before storage — kills first-paint flash

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' && area !== 'local') return;
      const patch = {};
      for (const k of Object.keys(DEFAULTS)) {
        if (Object.prototype.hasOwnProperty.call(changes, k)) patch[k] = changes[k].newValue;
      }
      if (Object.keys(patch).length) {
        settings = sanitize({ ...settings, ...patch });
        applyClasses();
      }
    });
  } catch (_) { /* storage events unavailable — popup writes still apply on reload */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { load(); guardBodyClasses(); hookSpaNav(); }, { once: true });
  } else {
    load(); guardBodyClasses(); hookSpaNav();
  }
  // body may appear after document_start — ensure classes land on it
  const bodyTimer = setInterval(() => {
    if (document.body) { applyClasses(); guardBodyClasses(); clearInterval(bodyTimer); }
  }, 300);
  setTimeout(() => clearInterval(bodyTimer), 5000);
})();
