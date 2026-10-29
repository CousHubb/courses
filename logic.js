// La logique de l'app qui ne touche ni à la page ni au réseau : rayons, fusion des articles,
// nettoyage des sauvegardes, comparaison de versions. Testée par test/unit/logic.test.js.

export const RAYONS = [
  ['fruits', 'Fruits & légumes'],
  ['boulangerie', 'Boulangerie'],
  ['viandes', 'Viandes & poissons'],
  ['cremerie', 'Crèmerie & œufs'],
  ['epicerie', 'Épicerie'],
  ['sucre', 'Épicerie sucrée'],
  ['boissons', 'Boissons'],
  ['surgeles', 'Surgelés'],
  ['hygiene', 'Hygiène & beauté'],
  ['maison', 'Maison & entretien'],
  ['animaux', 'Animaux'],
  ['autre', 'Autre'],
];
export const RAYON_LABEL = Object.fromEntries(RAYONS);

// Catégories Open Food Facts → rayon. La première règle qui correspond l'emporte.
const CATEGORY_RULES = [
  ['surgeles', ['en:frozen-foods', 'en:frozen-desserts', 'en:ice-creams-and-sorbets']],
  ['animaux', ['en:pet-food', 'en:cat-food', 'en:dog-food']],
  ['cremerie', ['en:dairies', 'en:eggs', 'en:cheeses', 'en:yogurts', 'en:butters', 'en:milks', 'en:creams']],
  ['boissons', ['en:beverages', 'en:waters', 'en:alcoholic-beverages']],
  ['viandes', ['en:meats', 'en:prepared-meats', 'en:poultries', 'en:seafood', 'en:fishes']],
  ['boulangerie', ['en:breads', 'en:viennoiseries']],
  ['sucre', ['en:sweet-snacks', 'en:biscuits-and-cakes', 'en:chocolates', 'en:confectioneries', 'en:breakfast-cereals',
    'en:sweet-spreads', 'en:jams', 'en:honeys', 'en:sugars', 'en:desserts', 'en:breakfasts']],
  ['fruits', ['en:fresh-fruits', 'en:fresh-vegetables']],
  ['epicerie', ['en:canned-foods', 'en:pastas', 'en:rices', 'en:sauces', 'en:condiments', 'en:salty-snacks', 'en:soups',
    'en:meals', 'en:vegetable-oils', 'en:cereals-and-potatoes', 'en:legumes']],
  ['fruits', ['en:fruits', 'en:vegetables']],
];

// Les autres bases de la famille Open Food Facts renvoient un product_type.
const TYPE_RAYON = { beauty: 'hygiene', petfood: 'animaux', product: 'maison' };

// Mots-clés pour ranger les articles tapés à la main (sans accents, au singulier).
const KEYWORDS = {
  fruits: 'pomme banane orange citron fraise framboise tomate salade carotte oignon echalote ail poireau courgette aubergine poivron concombre avocat poire raisin kiwi peche abricot melon patate champignon legume fruit persil basilic',
  boulangerie: 'pain baguette croissant brioche',
  viandes: 'viande poulet boeuf steak porc jambon lardon saucisse saucisson merguez poisson saumon thon cabillaud crevette dinde veau agneau',
  cremerie: 'lait yaourt fromage beurre creme oeuf emmental comte mozzarella parmesan',
  epicerie: 'pate riz farine huile vinaigre sel poivre moutarde mayonnaise ketchup sauce conserve lentille semoule',
  sucre: 'sucre chocolat biscuit gateau cereale confiture miel cafe the compote',
  boissons: 'eau jus vin biere soda coca sirop',
  surgeles: 'surgele glace',
  hygiene: 'shampoing shampooing savon dentifrice deodorant gel coton rasoir papier mouchoir',
  maison: 'lessive vaisselle eponge poubelle javel nettoyant adoucissant essuie',
  animaux: 'croquette litiere patee',
};
const KEYWORD_RAYON = new Map(
  Object.entries(KEYWORDS).flatMap(([rayon, words]) => words.split(' ').map((w) => [w, rayon])),
);

export const norm = (s) =>
  s.toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export const uid = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);

// Clé d'un produit dans le catalogue : son code-barres, sinon son nom.
export const catalogKey = (item) => (item.code ? 'code:' + item.code : 'nom:' + norm(item.name));

export function guessRayon(name) {
  for (const word of norm(name).split(/[^a-z0-9]+/)) {
    const rayon = KEYWORD_RAYON.get(word) ?? KEYWORD_RAYON.get(word.replace(/[sx]$/, ''));
    if (rayon) return rayon;
  }
  return 'autre';
}

export function rayonFromCategories(tags) {
  const rule = CATEGORY_RULES.find(([, cats]) => cats.some((c) => tags.includes(c)));
  if (rule) return rule[0];
  return tags.length ? 'epicerie' : 'autre';
}

// Produit renvoyé par Open Food Facts → ce que l'app en garde.
export function toInfo(p, sourceRayon) {
  const image = p.image_front_small_url || p.image_small_url || '';
  return {
    name: (p.product_name_fr || p.product_name || p.generic_name_fr || '').trim(),
    brand: (p.brands ?? '').split(',')[0].trim(),
    quantity: (p.quantity ?? '').trim().replace(/\s+[e℮]$/, ''), // "400 g e" : le ℮ des emballages
    image: image.startsWith('https://') ? image : '',
    rayon: TYPE_RAYON[p.product_type] ?? sourceRayon ?? rayonFromCategories(p.categories_tags ?? []),
  };
}

// Ajoute un produit à la liste, ou augmente sa quantité s'il y est déjà
// (même code-barres ou même nom). Modifie la liste et renvoie la ligne concernée.
export function addItem(items, info) {
  let item = items.find((i) => (info.code && i.code === info.code) || norm(i.name) === norm(info.name));
  if (item) {
    item.qty = item.checked ? 1 : item.qty + 1;
    item.checked = false;
  } else {
    item = { id: uid(), code: null, brand: '', quantity: '', image: '', rayon: 'autre', ...info, qty: 1, checked: false };
    items.push(item);
  }
  return item;
}

// Une sauvegarde vient d'un fichier : on ne garde que des champs propres.
export function cleanItem(raw) {
  if (typeof raw?.name !== 'string' || !raw.name.trim()) return null;
  const text = (v) => (typeof v === 'string' ? v : '');
  return {
    id: text(raw.id) || uid(),
    code: /^\d{8,14}$/.test(text(raw.code)) ? raw.code : null,
    name: raw.name.trim(),
    brand: text(raw.brand),
    quantity: text(raw.quantity),
    image: text(raw.image).startsWith('https://') ? raw.image : '',
    rayon: RAYON_LABEL[raw.rayon] ? raw.rayon : 'autre',
    qty: Math.max(1, Math.floor(Number(raw.qty)) || 1),
    checked: raw.checked === true,
  };
}

export function cleanEntry(raw) {
  const item = cleanItem(raw);
  if (!item) return null;
  const { name, brand, quantity, image, rayon } = item;
  const entry = { name, brand, quantity, image, rayon };
  if (Number(raw.count) > 0) Object.assign(entry, { count: Math.floor(raw.count), last: Number(raw.last) || 0 });
  return entry;
}

export const isCatalogKey = (key) => /^(code:\d{8,14}|nom:.+)$/.test(key);

// "1.10.0" est plus récent que "1.9.2".
export function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}
