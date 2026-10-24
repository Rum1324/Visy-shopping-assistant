/**
 * In-page script that numbers interactive elements and returns a PageState-shaped object.
 * Kept as a plain JS string (not a TS function) so page.evaluate never sees bundler helpers,
 * and so the extension content script can reuse it verbatim later.
 * Each element gets data-visy-idx so act() can find it again.
 */
export const INDEXER_JS = String.raw`(maxElements) => {
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=combobox], [role=tab], [role=menuitem], [role=option], [role=searchbox], [contenteditable=true]';
  const RISK = /place (your )?order|buy now|submit (order|payment)|pay now|complete (purchase|order)|confirm (order|purchase)|^place order/i;
  const RISK_IDS = /submitOrderButtonId|buy-now-button|placeYourOrder/i;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  };

  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label && clean(label.innerText)) return clean(label.innerText);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && ['submit', 'button'].includes((el.getAttribute('type') || '').toLowerCase()) && el.value) return clean(el.value);
    const text = clean(el.innerText);
    if (text) return text;
    const img = el.querySelector('img[alt]');
    if (img && clean(img.getAttribute('alt'))) return clean(img.getAttribute('alt'));
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.value || '');
  };

  const LANDMARK = { nav: 'navigation', header: 'header', footer: 'footer', main: 'main', aside: 'sidebar', form: 'form' };
  const sectionOf = (el) => {
    const parts = [];
    let n = el.parentElement;
    while (n && n !== document.body && parts.length < 2) {
      const label = n.getAttribute('aria-label');
      const comp = n.getAttribute('data-component-type');
      const tag = n.tagName.toLowerCase();
      let p = '';
      if (label) p = clean(label);
      else if (comp) p = comp;
      else if (n.id && !/^[a-f0-9-]{16,}$/i.test(n.id) && !/\d{4,}/.test(n.id) && !(n.id.length >= 12 && (n.id.match(/\d/g) || []).length >= 2)) p = n.id;
      else if (LANDMARK[tag]) p = LANDMARK[tag];
      if (p && !parts.includes(p)) parts.unshift(cut(p, 40));
      n = n.parentElement;
    }
    return parts.join(' > ');
  };

  document.querySelectorAll('[data-visy-idx]').forEach((e) => e.removeAttribute('data-visy-idx'));
  const all = Array.from(document.querySelectorAll(SEL)).filter(visible);
  // Viewport first, then the rest in document order.
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const ordered = all.filter(inView).concat(all.filter((e) => !inView(e)));

  const elements = [];
  for (const el of ordered) {
    if (elements.length >= maxElements) break;
    const name = cut(nameOf(el), 100);
    const role = roleOf(el);
    if (!name && role !== 'textbox' && role !== 'searchbox') continue;
    const idx = elements.length;
    el.setAttribute('data-visy-idx', String(idx));
    const e = { idx, role, name };
    const section = sectionOf(el);
    if (section) e.section = section;
    if (el.href) e.href = el.href;
    if (el.value && role !== 'button' && typeof el.value === 'string') e.value = cut(el.value, 60);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') e.disabled = true;
    if (role === 'checkbox' || role === 'radio') e.checked = !!el.checked;
    if (RISK.test(name) || RISK_IDS.test(el.id || '') || RISK_IDS.test(el.getAttribute('name') || '')) e.purchaseRisk = true;
    elements.push(e);
  }

  const seen = new Set();
  const textBlocks = [];
  for (const line of (document.body.innerText || '').split('\n')) {
    const t = clean(line);
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    textBlocks.push(cut(t, 200));
    if (textBlocks.length >= 150) break;
  }

  let h = 5381;
  const sig = location.hostname + location.pathname.replace(/[A-Z0-9]{10}/g, ':id') + elements.slice(0, 150).map((e) => e.role + (e.section || '')).join('|');
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0;

  return { url: location.href, title: document.title, elements, textBlocks, fingerprint: (h >>> 0).toString(36) };
}`;

/**
 * Source of apps/extension/indexer.js, the content-script copy of INDEXER_JS (MV3 can't eval strings).
 * Regenerate with `npm run gen-indexer -w @visy/server`; test/capture.test.ts fails when it drifts.
 */
export function extensionIndexerSource() {
  return `// GENERATED from apps/server/src/navigator/driver/indexer.ts by \`npm run gen-indexer -w @visy/server\`. Do not edit.\nglobalThis.visyIndexPage = ${INDEXER_JS};\n`;
}
