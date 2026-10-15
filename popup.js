/* hideX popup — no network, storage only, textContent only (no innerHTML). */
const DEFAULTS = Object.freeze({
  enabled: true,
  hideLikes: true,
  hideReplies: true,
  hideReposts: true,
  hideViews: true,
  hideDetail: true,
  blurUsername: true,
  blurBadge: true,
  blurAvatar: true,
  blurTime: true,
  hoverReveal: true,
  blurPx: 8
});

const IDS = Object.keys(DEFAULTS);
const statusEl = document.getElementById('status');
const blurValEl = document.getElementById('blurVal');
let saveTimer;

function coerceBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function clampPx(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.blurPx;
  return Math.min(20, Math.max(3, Math.round(n)));
}

async function getStore() {
  try {
    return await chrome.storage.sync.get(DEFAULTS);
  } catch {
    return await chrome.storage.local.get(DEFAULTS);
  }
}

async function setStore(patch) {
  try {
    await chrome.storage.sync.set(patch);
  } catch {
    await chrome.storage.local.set(patch);
  }
}

function flash(msg) {
  statusEl.textContent = msg;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { statusEl.textContent = ''; }, 1200);
}

async function init() {
  const raw = await getStore();
  const vals = {};
  for (const k of IDS) {
    if (k === 'blurPx') vals[k] = clampPx(raw[k]);
    else vals[k] = coerceBool(raw[k], DEFAULTS[k]);
  }
  for (const id of IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') {
      el.checked = vals[id];
      el.addEventListener('change', async () => {
        await setStore({ [id]: !!el.checked });
        flash('Saved');
      });
    } else if (el.type === 'range') {
      el.value = String(vals[id]);
      blurValEl.textContent = `${vals[id]}px`;
      el.addEventListener('input', async () => {
        const px = clampPx(el.value);
        blurValEl.textContent = `${px}px`;
        await setStore({ [id]: px });
      });
    }
  }
}

init();
