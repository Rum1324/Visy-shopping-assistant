// GENERATED from apps/server/src/navigator/scripts.ts by `npm run gen-indexer -w @visy/server`. Do not edit.
export const SCRIPTS = {
  "readyState": (arg) => (document.readyState),
  "href": (arg) => (location.href),
  "loaded": (arg) => (document.readyState !== 'loading'),
  "complete": (arg) => (document.readyState === 'complete'),
  "blockProbe": (arg) => (location.href + " " + document.title + " " + (document.body ? document.body.innerText.slice(0, 600) : "") + (document.querySelector("#checkpointForm, form[action*=validateCaptcha]") ? " captcha" : "")),
  "amazon.results": (arg) => (Array.from(document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')).map((c) => ({
  asin: c.getAttribute('data-asin'),
  title: (c.querySelector('h2')?.innerText || '').trim(),
  price: c.querySelector('.a-price .a-offscreen')?.textContent?.trim() || null,
  rating: c.querySelector('.a-icon-alt')?.textContent?.trim() || null,
  reviews: (() => { const r = c.querySelector('[aria-label$="ratings"], [aria-label$="rating"], a[href*="customerReviews"] span'); return r ? (r.getAttribute('aria-label') || r.textContent || '').trim() || null : null; })(),
  sponsored: !!c.querySelector('.puis-sponsored-label-text, [aria-label*="Sponsored"]') || /^Sponsored/.test((c.innerText || '').trim()),
})).filter((r) => r.asin && r.title)),
  "amazon.resultsReady": (arg) => (!!document.querySelector('[data-component-type="s-search-result"][data-asin]') || !!document.querySelector('#checkpointForm, form[action*=validateCaptcha]')),
  "amazon.titlesReady": (arg) => (document.querySelectorAll('[data-component-type="s-search-result"][data-asin] h2').length >= 40 || document.readyState !== 'loading'),
  "amazon.loadedOrChallenge": (arg) => (document.readyState !== 'loading' || !!document.querySelector('#checkpointForm, form[action*=validateCaptcha]')),
  "amazon.added": (arg) => (location.href !== arg || /added to (your )?cart/i.test(document.body.innerText.slice(0, 20000)) || !!document.querySelector('#attachSiNoCoverage, #attach-warranty-pane, #NATC_SMART_WAGON_CONF_MSG_SUCCESS, #sw-atc-confirmation')),
  "amazon.warranty": (arg) => (!!document.querySelector('#attachSiNoCoverage, #attach-warranty-pane')),
  "amazon.reviews": (arg) => (Array.from(document.querySelectorAll('[data-hook="review"]')).map((r) => {
  const q = (...hs) => hs.map((h) => r.querySelector('[data-hook="' + h + '"]')).find(Boolean);
  const stars = r.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"], .review-rating')?.textContent || '';
  const lines = (el) => (el?.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const title = lines(q('reviewTitle', 'review-title')).filter((l) => !/out of 5 stars/.test(l)).join(' ');
  const body = lines(q('reviewText', 'review-body')).filter((l) => !/^(Read more|See more|Report|Helpful|Click to play video)$/i.test(l)).join('\n');
  return {
    id: (r.id || '').replace(/^customer_review(_foreign)?-/, ''),
    rating: parseFloat(stars) || null,
    title,
    body,
    date: q('review-date')?.innerText?.trim() || '',
    author: r.querySelector('.a-profile-name')?.textContent?.trim() || null,
    verified: !!q('avp-badge', 'avp-badge-linkless'),
  };
}).filter((r) => /^R[A-Z0-9]+$/.test(r.id) && r.body)),
  "amazon.reviewsReady": (arg) => (!!document.querySelector('[data-hook="review"]') || /\/ap\/signin/.test(location.pathname) || !!document.querySelector('#checkpointForm, form[action*=validateCaptcha]') || /no customer reviews/i.test(document.body?.innerText || '')),
  "amazon.signin": (arg) => (/\/ap\/signin/.test(location.pathname)),
  "amazon.hasShowMore": (arg) => (!!document.querySelector('[data-hook="show-more-button"]')),
  "amazon.clickShowMore": (arg) => (void document.querySelector('[data-hook="show-more-button"]')?.click()),
  "amazon.reviewsGrew": (arg) => (document.querySelectorAll('[data-hook="review"]').length > arg || !!document.querySelector('#checkpointForm, form[action*=validateCaptcha]')),
  "amazon.nextPage": (arg) => (document.querySelector('.a-pagination .a-last:not(.a-disabled) a')?.href || null),
  "amazon.productReviewsReady": (arg) => (!!document.querySelector('[data-hook="review"]') || document.readyState === 'complete' || !!document.querySelector('#checkpointForm, form[action*=validateCaptcha]')),
  "amazon.detailReady": (arg) => (!!document.querySelector('#feature-bullets, #productDescription') || document.readyState === 'complete' || !!document.querySelector('#checkpointForm, form[action*=validateCaptcha]')),
  "amazon.detail": (arg) => (({
  bullets: Array.from(document.querySelectorAll('#feature-bullets li, #productFactsDesktopExpander li')).map((l) => l.innerText.trim()).filter(Boolean).slice(0, 10),
  description: (document.querySelector('#productDescription')?.innerText || '').trim().slice(0, 3000),
})),
  "amazon.titlePrice": (arg) => (({ title: (document.querySelector("#productTitle")?.innerText || "").trim(), price: document.querySelector(".a-price .a-offscreen")?.textContent?.trim() || null })),
  "amazon.subtotalReady": (arg) => (!!document.querySelector('#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox')),
  "amazon.subtotal": (arg) => ((document.querySelector('#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox')?.innerText || '').trim()),
  "amazon.clickProceed": (arg) => ((() => { const b = document.querySelector('input[name="proceedToRetailCheckout"], [data-feature-id="proceed-to-checkout-action"] input, #sc-buy-box-ptc-button input'); if (!b) return false; b.click(); return true; })()),
  "amazon.orderTotalReady": (arg) => (/Order total:?\s*\$\s*[\d,]+\.\d{2}/i.test(document.body?.innerText || '') || /\/ap\/signin/.test(location.pathname) || !!document.querySelector('#checkpointForm, form[action*=validateCaptcha]')),
  "amazon.orderTotal": (arg) => ((() => {
  const t = document.body?.innerText || '';
  const total = t.match(/Order total:?\s*(\$\s*[\d,]+\.\d{2})/i)?.[1] || null;
  const tax = t.match(/(?:Estimated tax to be collected|Estimated tax|Tax):?\s*(\$\s*[\d,]+\.\d{2})/i)?.[1] || null;
  const button = /Place your order/i.test(t) ? 'Place your order' : null;
  return { total, tax, button, url: location.href };
})()),
  "recipe.replay": (arg) => (((f) => {
  const one = (s, root) => { if (!s) return null; try { return (root || document).querySelector(s.css); } catch { return null; } };
  const all = (s, root) => { if (!s) return []; try { return Array.from((root || document).querySelectorAll(s.css)); } catch { return []; } };
  const val = (el, s) => { if (!el || !s) return null; const v = s.attr ? el.getAttribute(s.attr) : (el.innerText || el.textContent); return (v || '').replace(/\s+/g, ' ').trim() || null; };
  const text = (k) => val(one(f[k]), f[k]);
  const texts = (k, root) => [...new Set(all(f[k], root).map((e) => val(e, f[k])).filter(Boolean))];
  return {
    title: text('title'), price: text('price'), listPrice: text('listPrice'), deal: text('deal'),
    prime: f.prime ? !!one(f.prime) : null,
    rating: text('rating'), reviewCount: text('reviewCount'), brand: text('brand'),
    availability: text('availability'), delivery: text('delivery'),
    bullets: texts('bullets').slice(0, 12),
    description: (text('description') || '').slice(0, 3000) || null,
    banners: texts('banners').slice(0, 6),
    images: texts('images').slice(0, 20),
    specs: all(f.specRows).slice(0, 60).map((r) => [val(one(f.specKey, r), f.specKey), val(one(f.specValue, r), f.specValue)]).filter((kv) => kv[0] && kv[1]),
    variants: all(f.variantGroups).slice(0, 6).map((g) => ({ name: val(one(f.variantName, g), f.variantName), options: texts('variantOption', g).slice(0, 30) })).filter((v) => v.name && v.options.length),
  };
})(arg)),
  "recipe.outline": (arg) => (((budget) => {
  const KEEP = ['id', 'class', 'data-feature-name', 'data-asin', 'data-old-hires', 'data-a-dynamic-image', 'src', 'alt', 'title', 'aria-label', 'role', 'data-hook', 'name', 'value'];
  const DROP = 'script,style,noscript,svg,iframe,link,meta,template,canvas,video,input[type=hidden],#navbar,#nav-main,#nav-belt,#rhf,#navFooter,footer,.a-carousel-container,[data-a-carousel-options],#customerReviews,#reviewsMedley,#customer-reviews_feature_div,[cel_widget_id*="sp_"],[id*="sims"],[id*="similarities"],[id*="Sponsored"],[id*="sponsored"],#HLCXComparisonWidget_feature_div,#ad-feedback,[id^="ape_"],#aplus_feature_div,#aplus,#bundles_feature_div,[id*="video"],[id*="Video"],#climatePledgeFriendlyATF_feature_div,#twisterPlusPriceSubtotalWWDesktop_feature_div,[id^="ask"],[id^="a-popover"],[id*="pricingFeedback"],#sustZoneATF_feature_div,[id*="usedAccordionRow"]';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const ser = (n) => {
    if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, ' ').trim(); return t ? esc(cut(t, 80)) : ''; }
    if (n.nodeType !== 1 || n.matches(DROP)) return '';
    const tag = n.tagName.toLowerCase();
    let a = '';
    for (const k of KEEP) {
      let v = n.getAttribute(k);
      if (v == null) continue;
      if (k === 'class') v = v.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
      a += ' ' + k + '="' + esc(cut(v, k === 'data-a-dynamic-image' ? 160 : 100)) + '"';
    }
    let inner = '';
    const seen = {};
    let skipped = 0;
    for (const c of n.childNodes) {
      if (c.nodeType === 1) {
        const sig = (c.tagName + '#' + c.id + '.' + (c.getAttribute('class') || '')).replace(/\d+/g, '0');
        seen[sig] = (seen[sig] || 0) + 1;
        if (seen[sig] > 4) { skipped++; continue; }
      }
      inner += ser(c);
    }
    if (skipped) inner += '<!-- +' + skipped + ' similar -->';
    if (!inner && (tag === 'div' || tag === 'span')) return '';
    if (!a && (tag === 'div' || tag === 'span')) return inner;
    return '<' + tag + a + '>' + inner + '</' + tag + '>';
  };
  const root = document.querySelector('#dp-container') || document.querySelector('#dp') || document.body;
  return cut(ser(root), budget);
})(arg)),
};
