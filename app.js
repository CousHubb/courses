// Liste de courses : on scanne un code-barres, Open Food Facts donne le nom du produit,
// tout est gardé dans le stockage local du téléphone. La logique pure est dans logic.js.

import {
  RAYONS, RAYON_LABEL, addItem, catalogKey, cleanEntry, cleanItem, guessRayon, isCatalogKey, isNewer, norm, toInfo,
} from './logic.js';

const SOURCES = [
  { host: 'world.openfoodfacts.org', rayon: null },
  { host: 'world.openbeautyfacts.org', rayon: 'hygiene' },
  { host: 'world.openproductsfacts.org', rayon: 'maison' },
  { host: 'world.openpetfoodfacts.org', rayon: 'animaux' },
];
const FIELDS = 'product_name,product_name_fr,generic_name_fr,brands,quantity,image_front_small_url,image_small_url,categories_tags,product_type';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const POLYFILL = './vendor/barcode-detector/ponyfill.js';
const ZXING_WASM = new URL('./vendor/zxing-wasm/zxing_reader.wasm', import.meta.url).href;
const SCAN_HINT = 'Vise le code-barres';

const KEY_ITEMS = 'courses.items.v1';
const KEY_CATALOG = 'courses.catalog.v1';
const PUBLIC_REPO = 'CousHubb/courses'; // releases de l'APK

// Dans l'APK, Capacitor donne accès à Android : bouton retour, fichiers, partage, version.
const isApp = window.Capacitor?.isNativePlatform?.() ?? false;
const { App: appPlugin, Filesystem, Share } = window.Capacitor?.Plugins ?? {};

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const countEl = $('#count');
const emptyEl = $('#empty');
const addForm = $('#add-form');
const addInput = $('#add-input');
const suggestionsEl = $('#suggestions');
const scannerEl = $('#scanner');
const video = $('#video');
const statusEl = $('#scan-status');
const toastEl = $('#toast');
const itemDialog = $('#item-dialog');
const itemForm = $('#item-form');
const codeDialog = $('#code-dialog');
const menuDialog = $('#menu-dialog');
const importInput = $('#import-file');
const frequentEl = $('#frequent');
const bannerEl = $('#update-banner');
const torchBtn = $('#torch');

/* Stockage */

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Stockage plein ou bloqué : la liste reste en mémoire jusqu'à la fermeture.
  }
}

let items = load(KEY_ITEMS, []);
// Ce que l'app a appris : 'code:<ean>' ou 'nom:<nom normalisé>' → { name, rayon, ... }
let catalog = load(KEY_CATALOG, {});
let askedPersist = false;

function saveItems() {
  store(KEY_ITEMS, items);
  render();
}

function saveCatalog() {
  store(KEY_CATALOG, catalog);
  renderSuggestions();
}

// Retient ce que l'app sait d'un produit, sans perdre son nombre d'achats.
function remember(item) {
  const fields = item.code
    ? { name: item.name, brand: item.brand ?? '', quantity: item.quantity ?? '', image: item.image ?? '', rayon: item.rayon }
    : { name: item.name, rayon: item.rayon };
  const key = catalogKey(item);
  catalog[key] = { ...catalog[key], ...fields };
  saveCatalog();
}

// Compte les ajouts de chaque produit, pour proposer ensuite les articles à racheter.
function countPurchase(item) {
  const entry = catalog[catalogKey(item)];
  if (!entry) return;
  entry.count = (entry.count ?? 0) + 1;
  entry.last = Date.now();
  saveCatalog();
}

// Applique une modification de la liste et propose de l'annuler.
function change(mutate) {
  const before = structuredClone(items);
  const message = mutate();
  saveItems();
  if (!askedPersist) {
    askedPersist = true;
    navigator.storage?.persist?.().catch(() => {});
  }
  if (message) {
    toast(message, () => {
      items = before;
      saveItems();
    });
  }
}

/* Utilitaires */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* Open Food Facts */

async function fetchProduct(host, code) {
  const res = await fetch(`https://${host}/api/v2/product/${code}.json?fields=${FIELDS}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null; // 404 : produit inconnu de cette base
  const data = await res.json();
  return data.status === 1 ? data.product : null;
}

// Cherche d'abord dans Open Food Facts (le cas courant), puis dans les bases sœurs en parallèle.
async function lookup(code) {
  let reached = false;
  const attempt = async (source) => {
    try {
      const product = await fetchProduct(source.host, code);
      reached = true;
      return product ? toInfo(product, source.rayon) : null;
    } catch {
      return null;
    }
  };
  const info = (await attempt(SOURCES[0])) ?? (await Promise.all(SOURCES.slice(1).map(attempt))).find(Boolean);
  return { info, offline: !reached };
}

/* Ajouts */

function addToList(info) {
  change(() => {
    const item = addItem(items, info);
    countPurchase(item);
    return item.qty > 1 ? `${item.name} (×${item.qty})` : `Ajouté : ${item.name}`;
  });
}

// Ajoute un produit que l'app connaît déjà, avec sa photo et son rayon.
function addFromCatalog(key) {
  const { count, last, ...fields } = catalog[key];
  addToList({ ...fields, code: key.startsWith('code:') ? key.slice(5) : null });
}

async function handleCode(code) {
  if (catalog['code:' + code]) {
    addFromCatalog('code:' + code);
    return;
  }
  setStatus('Recherche du produit…');
  const { info, offline } = await lookup(code);
  if (info?.name) {
    remember({ ...info, code });
    addToList({ ...info, code });
  } else {
    const res = await openItemDialog({
      title: 'Produit inconnu',
      hint: offline
        ? `Pas de connexion pour identifier le code ${code}. Donne-lui un nom.`
        : `Le code ${code} n'est pas dans Open Food Facts. Donne-lui un nom : il sera reconnu la prochaine fois.`,
      name: info?.brand ?? '',
      rayon: info?.rayon ?? 'autre',
    });
    if (res.action === 'ok' && res.name) {
      const entry = { ...info, name: res.name, rayon: res.rayon, code };
      remember(entry);
      addToList(entry);
    }
  }
  setStatus(SCAN_HINT);
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = addInput.value.trim();
  if (!name) return;
  addInput.value = '';
  // Un nom déjà connu (scanné ou tapé avant) garde sa photo et son rayon.
  const match = Object.keys(catalog).find((key) => norm(catalog[key].name) === norm(name));
  if (match) {
    addFromCatalog(match);
  } else {
    const entry = { name, rayon: guessRayon(name) };
    remember(entry);
    addToList(entry);
  }
});

/* Liste */

function render() {
  const todo = items.filter((i) => !i.checked);
  const done = items.filter((i) => i.checked);
  countEl.textContent = todo.length
    ? `${todo.length} article${todo.length > 1 ? 's' : ''} à acheter`
    : done.length ? 'Tout est dans le caddie' : '';
  emptyEl.hidden = items.length > 0;

  let html = '';
  for (const [key, label] of RAYONS) {
    const group = todo.filter((i) => (RAYON_LABEL[i.rayon] ? i.rayon : 'autre') === key);
    if (group.length) html += sectionHtml(label, group);
  }
  if (done.length) html += sectionHtml('Dans le caddie', done, true);
  listEl.innerHTML = html;
  renderFrequent();
}

// Les produits déjà achetés qui ne sont pas dans la liste, les plus fréquents d'abord.
function renderFrequent() {
  const inList = new Set(items.filter((i) => !i.checked).map(catalogKey));
  const top = Object.entries(catalog)
    .filter(([key, entry]) => entry.count > 0 && !inList.has(key))
    .sort(([, a], [, b]) => b.count - a.count || b.last - a.last)
    .slice(0, 12);
  frequentEl.hidden = top.length === 0;
  frequentEl.querySelector('.chips').innerHTML = top
    .map(([key, entry]) => `<button type="button" class="chip" data-key="${esc(key)}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>${esc(entry.name)}</button>`)
    .join('');
}

frequentEl.addEventListener('click', (e) => {
  const key = e.target.closest('.chip')?.dataset.key;
  if (key && catalog[key]) addFromCatalog(key);
});

function sectionHtml(label, group, done = false) {
  const clear = done ? '<button type="button" class="link-btn" data-action="clear-done">Retirer</button>' : '';
  return `<section class="group${done ? ' done' : ''}">
    <div class="group-head"><h2>${esc(label)}<small>${group.length}</small></h2>${clear}</div>
    <ul>${group.map(itemHtml).join('')}</ul>
  </section>`;
}

function itemHtml(i) {
  const brand = norm(i.brand) === norm(i.name) ? '' : i.brand;
  const meta = [brand, i.quantity].filter(Boolean).join(' · ');
  const letter = esc((i.name[0] || '?').toUpperCase());
  const thumb = i.image
    ? `<img class="thumb" src="${esc(i.image)}" alt="" loading="lazy" data-letter="${letter}">`
    : `<span class="thumb letter" aria-hidden="true">${letter}</span>`;
  return `<li class="item" data-id="${esc(i.id)}">
    <button type="button" class="check" role="checkbox" aria-checked="${i.checked}" aria-label="${esc(i.name)}">
      <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
    </button>
    ${thumb}
    <button type="button" class="info"><span class="name">${esc(i.name)}</span>${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</button>
    ${i.qty > 1 ? `<span class="qty">×${i.qty}</span>` : ''}
  </li>`;
}

function renderSuggestions() {
  const names = [...new Set(Object.values(catalog).map((v) => v.name))].sort((a, b) => a.localeCompare(b, 'fr'));
  suggestionsEl.innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

listEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="clear-done"]')) {
    change(() => {
      const n = items.filter((i) => i.checked).length;
      items = items.filter((i) => !i.checked);
      return `${n} article${n > 1 ? 's' : ''} retiré${n > 1 ? 's' : ''}`;
    });
    return;
  }
  const id = e.target.closest('.item')?.dataset.id;
  const item = items.find((i) => i.id === id);
  if (!item) return;
  if (e.target.closest('.check')) {
    item.checked = !item.checked;
    saveItems();
  } else if (e.target.closest('.info, .thumb')) {
    editItem(item);
  }
});

// Photo introuvable : on remet l'initiale.
listEl.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG') return;
  const span = document.createElement('span');
  span.className = 'thumb letter';
  span.textContent = img.dataset.letter;
  img.replaceWith(span);
}, true);

async function editItem(item) {
  const res = await openItemDialog({
    title: 'Modifier',
    hint: [item.brand, item.quantity, item.code].filter(Boolean).join(' · '),
    name: item.name,
    rayon: item.rayon,
    qty: item.qty,
    existing: true,
  });
  if (res.action === 'delete') {
    change(() => {
      items = items.filter((i) => i.id !== item.id);
      return `Supprimé : ${item.name}`;
    });
  } else if (res.action === 'ok' && res.name) {
    const target = items.find((i) => i.id === item.id);
    if (!target) return;
    Object.assign(target, { name: res.name, rayon: res.rayon, qty: res.qty });
    remember(target);
    saveItems();
  }
}

/* Dialogues */

// Seul le bouton de validation est de type submit : la touche Entrée ne peut
// donc ni annuler ni supprimer par erreur.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('dialog [data-close]');
  if (btn) btn.closest('dialog').close(btn.dataset.close);
});

itemForm.elements.rayon.innerHTML = RAYONS.map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('');

// Pour un nouveau produit, le rayon suit le nom tapé tant qu'on ne l'a pas choisi soi-même.
let autoRayon = false;
itemForm.elements.name.addEventListener('input', () => {
  if (autoRayon) itemForm.elements.rayon.value = guessRayon(itemForm.elements.name.value);
});
itemForm.elements.rayon.addEventListener('change', () => {
  autoRayon = false;
});

itemForm.addEventListener('click', (e) => {
  const step = e.target.closest('[data-step]');
  if (!step) return;
  const out = itemForm.elements.qty;
  out.value = Math.max(1, (Number(out.value) || 1) + Number(step.dataset.step));
});

function openItemDialog({ title, hint = '', name = '', rayon = 'autre', qty = 1, existing = false }) {
  const f = itemForm.elements;
  $('#item-title').textContent = title;
  $('#item-hint').textContent = hint;
  f.name.value = name;
  f.rayon.value = RAYON_LABEL[rayon] ? rayon : 'autre';
  f.qty.value = qty;
  autoRayon = !existing && f.rayon.value === 'autre';
  $('#qty-field').hidden = !existing;
  $('#item-delete').hidden = !existing;
  $('#item-ok').textContent = existing ? 'Enregistrer' : 'Ajouter';
  itemDialog.returnValue = '';
  itemDialog.showModal();
  if (!existing) f.name.focus();
  return new Promise((resolve) => {
    itemDialog.addEventListener('close', () => {
      resolve({
        action: itemDialog.returnValue,
        name: f.name.value.trim(),
        rayon: f.rayon.value,
        qty: Number(f.qty.value) || 1,
      });
    }, { once: true });
  });
}

function askCode() {
  const input = codeDialog.querySelector('input');
  input.value = '';
  codeDialog.returnValue = '';
  codeDialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    codeDialog.addEventListener('close', () => {
      resolve(codeDialog.returnValue === 'ok' ? input.value.replace(/\D/g, '') : '');
    }, { once: true });
  });
}

/* Sauvegarde */

const BACKUP_APP = 'courses';

$('#menu-btn').addEventListener('click', () => menuDialog.showModal());

menuDialog.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  menuDialog.close();
  if (action === 'export') exportBackup();
  else importInput.click();
});

importInput.addEventListener('change', () => {
  const file = importInput.files[0];
  importInput.value = '';
  if (file) importBackup(file);
});

async function exportBackup() {
  const json = JSON.stringify({ app: BACKUP_APP, version: 1, date: new Date().toISOString(), items, catalog }, null, 1);
  const name = `courses-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    if (isApp && Filesystem && Share) {
      // Dans l'APK, le menu Partager d'Android permet de l'enregistrer (Drive, Fichiers, e-mail…).
      const { uri } = await Filesystem.writeFile({ path: name, data: json, directory: 'CACHE', encoding: 'utf8' });
      await Share.share({ title: 'Sauvegarde Courses', dialogTitle: 'Enregistrer la sauvegarde', files: [uri] });
    } else {
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (err) {
    if (!/cancel/i.test(err?.message ?? '')) toast('Impossible d\'exporter la sauvegarde.');
  }
}

// Remplace la liste par celle de la sauvegarde et ajoute les produits qu'elle connaît.
async function importBackup(file) {
  let data = null;
  try {
    data = JSON.parse(await file.text());
  } catch {
    // Pas du JSON : traité juste en dessous.
  }
  if (data?.app !== BACKUP_APP || !Array.isArray(data.items)) {
    toast('Ce fichier n\'est pas une sauvegarde de Courses.');
    return;
  }
  const before = { items: structuredClone(items), catalog: structuredClone(catalog) };
  items = data.items.map(cleanItem).filter(Boolean);
  for (const [key, raw] of Object.entries(data.catalog ?? {})) {
    const entry = isCatalogKey(key) && cleanEntry(raw);
    if (entry) catalog[key] = entry;
  }
  saveCatalog();
  saveItems();
  toast(`Sauvegarde importée : ${items.length} article${items.length > 1 ? 's' : ''}`, () => {
    ({ items, catalog } = before);
    saveCatalog();
    saveItems();
  });
}

/* Mise à jour */

let lastUpdateCheck = 0;

// Le site se met à jour tout seul ; l'APK demande à GitHub la dernière version publiée.
async function checkForUpdate() {
  if (!appPlugin) {
    $('#app-version').textContent = 'Version web : elle se met à jour toute seule.';
    return;
  }
  if (Date.now() - lastUpdateCheck < 6 * 3600 * 1000) return;
  lastUpdateCheck = Date.now();
  try {
    const { version } = await appPlugin.getInfo();
    $('#app-version').textContent = `Version ${version}`;
    const res = await fetch(`https://api.github.com/repos/${PUBLIC_REPO}/releases/latest`, {
      signal: AbortSignal.timeout(8000),
    });
    const latest = res.ok ? (await res.json()).tag_name?.replace(/^v/, '') : null;
    if (latest && isNewer(latest, version)) {
      bannerEl.querySelector('.banner-text').textContent = `La version ${latest} est disponible.`;
      bannerEl.hidden = false;
    }
  } catch {
    lastUpdateCheck = 0; // pas de connexion : on réessaiera au prochain retour dans l'app
  }
}

bannerEl.querySelector('.banner-close').addEventListener('click', () => {
  bannerEl.hidden = true;
});

/* Toast */

let toastTimer = 0;

function toast(message, undo) {
  toastEl.querySelector('.toast-msg').textContent = message;
  const undoBtn = toastEl.querySelector('.toast-undo');
  undoBtn.hidden = !undo;
  undoBtn.onclick = () => {
    hideToast();
    undo();
  };
  toastEl.hidden = false;
  toastEl.style.animation = 'none';
  void toastEl.offsetHeight; // relance l'animation d'apparition
  toastEl.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4500);
}

function hideToast() {
  toastEl.hidden = true;
}

/* Scanner */

let stream = null;
let detector = null;
let detectorPromise = null;
let scanTimer = 0;
let busy = false;
let lastCode = '';
let lastSeen = 0;
let audio = null;

async function createDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) return new window.BarcodeDetector({ formats });
    } catch {
      // Détecteur natif inutilisable : on passe au polyfill.
    }
  }
  const { BarcodeDetector, prepareZXingModule } = await import(POLYFILL);
  prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? ZXING_WASM : prefix + path) },
  });
  return new BarcodeDetector({ formats: FORMATS });
}

function getDetector() {
  detectorPromise ??= createDetector().catch((err) => {
    detectorPromise = null;
    throw err;
  });
  return detectorPromise;
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function openScanner() {
  scannerEl.hidden = false;
  document.body.style.overflow = 'hidden';
  lastCode = ''; // nouvelle ouverture : le premier code vu compte, même s'il vient d'être scanné
  if (!history.state?.scanner) history.pushState({ scanner: true }, '');
  try {
    audio ??= new AudioContext();
    audio.resume();
  } catch {
    audio = null;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Caméra indisponible ici : il faut ouvrir l\'app en https.');
    return;
  }
  setStatus('Ouverture de la caméra…');
  const detectorReady = getDetector();
  detectorReady.catch(() => {});
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    setStatus(err.name === 'NotAllowedError'
      ? 'Accès à la caméra refusé. Autorise-le dans les réglages du navigateur.'
      : 'Aucune caméra disponible. Tu peux taper le code.');
    return;
  }
  if (scannerEl.hidden) {
    stopStream(); // fermé pendant l'ouverture de la caméra
    return;
  }
  video.srcObject = stream;
  video.play().catch(() => {});
  try {
    detector = await detectorReady;
  } catch {
    setStatus('Lecteur de code-barres indisponible (connexion ?). Tu peux taper le code.');
    return;
  }
  setStatus(SCAN_HINT);
  setupTorch();
  scheduleScan();
}

// La lampe n'apparaît que si la caméra l'annonce (la plupart des téléphones Android, pas l'iPhone).
function setupTorch() {
  const track = stream?.getVideoTracks()[0];
  torchBtn.setAttribute('aria-pressed', 'false');
  torchBtn.hidden = !track?.getCapabilities?.().torch;
}

torchBtn.addEventListener('click', async () => {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const on = torchBtn.getAttribute('aria-pressed') !== 'true';
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    torchBtn.setAttribute('aria-pressed', String(on));
  } catch {
    toast('Impossible d\'allumer la lampe.');
  }
});

function scheduleScan() {
  scanTimer = setTimeout(scanFrame, 150);
}

async function scanFrame() {
  if (!stream) return;
  if (!busy && video.readyState >= 2) {
    try {
      const found = await detector.detect(video);
      const code = found.map((b) => b.rawValue).find((v) => /^\d{8,14}$/.test(v));
      if (code) await onDetected(code);
    } catch {
      // Image illisible, on réessaie à la suivante.
    }
  }
  if (stream) scheduleScan();
}

// Un produit laissé devant la caméra ne compte qu'une fois :
// pour en ajouter un deuxième, on l'écarte puis on le représente.
async function onDetected(code) {
  const now = Date.now();
  const stillInView = code === lastCode && now - lastSeen < 1500;
  lastCode = code;
  lastSeen = now;
  if (stillInView) return;
  beep();
  navigator.vibrate?.(50);
  busy = true;
  try {
    await handleCode(code);
  } finally {
    busy = false;
    lastSeen = Date.now();
  }
}

function beep() {
  if (!audio) return;
  try {
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 1320;
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.12);
  } catch {
    // Pas de son, tant pis.
  }
}

function stopStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

function hideScanner() {
  scannerEl.hidden = true;
  torchBtn.hidden = true;
  document.body.style.overflow = '';
  clearTimeout(scanTimer);
  stopStream(); // éteint aussi la lampe
}

// Le scanner occupe une entrée d'historique : le geste retour d'Android
// le ferme au lieu de quitter l'app.
function closeScanner() {
  if (history.state?.scanner) history.back();
  else hideScanner();
}

addEventListener('popstate', () => {
  if (!scannerEl.hidden) hideScanner();
});

$('#scan-btn').addEventListener('click', openScanner);
$('#close-scan').addEventListener('click', closeScanner);

$('#type-code').addEventListener('click', async () => {
  busy = true;
  try {
    const code = await askCode();
    if (/^\d{8,14}$/.test(code)) await handleCode(code);
    else if (code) toast('Un code-barres fait de 8 à 14 chiffres.');
  } finally {
    busy = false;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !scannerEl.hidden && !document.querySelector('dialog[open]')) closeScanner();
});

// Bouton retour d'Android dans l'APK : ferme ce qui est ouvert, sinon met l'app en arrière-plan
// (sans ce gestionnaire, Capacitor ne fait rien une fois l'historique vide).
appPlugin?.addListener('backButton', () => {
  const dialog = document.querySelector('dialog[open]');
  if (dialog) dialog.close('cancel');
  else if (!scannerEl.hidden) closeScanner();
  else appPlugin.minimizeApp();
});

// On rend la caméra dès que l'app passe en arrière-plan ; au retour, on regarde s'il y a une mise à jour.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !scannerEl.hidden) closeScanner();
  if (!document.hidden) checkForUpdate();
});

/* Démarrage */

addEventListener('storage', (e) => {
  if (e.key === KEY_ITEMS) {
    items = load(KEY_ITEMS, []);
    render();
  } else if (e.key === KEY_CATALOG) {
    catalog = load(KEY_CATALOG, {});
    renderSuggestions();
  }
});

render();
renderSuggestions();
checkForUpdate();

// Dans l'APK, les fichiers sont déjà sur le téléphone : pas besoin de service worker.
if ('serviceWorker' in navigator && !isApp) navigator.serviceWorker.register('sw.js').catch(() => {});

// Sans lecteur natif (iPhone, ordinateur), on précharge le polyfill pour que
// le premier scan soit immédiat et qu'il reste disponible hors connexion.
if (!('BarcodeDetector' in window)) {
  setTimeout(() => {
    getDetector().then((d) => d.detect(new ImageData(1, 1))).catch(() => {});
  }, 1500);
}
