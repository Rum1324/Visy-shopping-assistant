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
  price: (c.querySelector('.a-price:not(.a-text-price) .a-offscreen') || c.querySelector('.a-price .a-offscreen'))?.textContent?.trim() || null,
  // UX-SALES: the struck-through "List:" / "Typical:" price, and a deal badge or coupon tile ("Coupon price $28.51").
  listPrice: c.querySelector('.a-text-price[data-a-strike="true"] .a-offscreen')?.textContent?.trim() || null,
  deal: [...c.querySelectorAll('.a-badge-text, [class*="coupon-tile-text"], .s-coupon-unclipped')].map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()).find((t) => /deal|coupon|sale|% off/i.test(t))?.slice(0, 80) || null,
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
  "amazon.orderTotalReady": (arg) => (/Order total:?\s*(?:[A-Z]{3}|\$)\s*[\d,]/i.test(document.body?.innerText || '') || /\/ap\/signin/.test(location.pathname) || !!document.querySelector('#checkpointForm, form[action*=validateCaptcha]')),
  "amazon.orderTotal": (arg) => ((() => {
  const t = document.body?.innerText || '';
  const total = t.match(/Order total:?\s*((?:[A-Z]{3}|\$)\s*[\d,]+(?:\.\d{1,2})?)/i)?.[1] || null;
  const tax = t.match(/(?:Estimated tax to be collected|Estimated tax):?\s*((?:[A-Z]{3}|\$)\s*[\d,]+(?:\.\d{1,2})?)/i)?.[1] || null;
  const usd = /^\$/.test(total || '') ? total : t.match(/USD\s*([\d,]+\.\d{2})/)?.[1] || null;
  const button = t.match(/Place your order(?: in [A-Z]{3})?/i)?.[0] || (/Proceed to checkout/i.test(t) ? 'Proceed to checkout' : null);
  return { total, tax, usd, button, url: location.href };
})()),
  "target.results": (arg) => (Array.from(document.querySelectorAll('[data-test="ListingPageProductListing"]')).map((c) => {
  const t = (e) => (e ? e.textContent || '' : '').replace(/\s+/g, ' ').trim();
  const a = c.querySelector('a[href*="/A-"]');
  const href = a ? a.getAttribute('href') || '' : '';
  const h3 = c.querySelector('h3');
  const parts = h3 ? Array.from(h3.children).map(t).filter(Boolean) : [];
  const lines = Array.from(c.querySelectorAll('[data-test="text-quill"], [data-test="cdui-marker-v2"]'))
    .filter((e) => !e.closest('h3, [data-test="rating-stars"]') && !(e.getAttribute('data-test') === 'cdui-marker-v2' && e.querySelector('[data-test="text-quill"]')))
    .map(t).filter(Boolean);
  const aria = (c.querySelector('[data-test="product-listing-gallery-desktop-image-link"]')?.getAttribute('aria-label') || '').trim();
  const label = aria.replace(/\s+Sponsored$/, '');
  return {
    tcin: (/\/A-(\d+)/.exec(href) || [])[1] || null,
    path: href.split('?')[0].split('#')[0],
    title: label || t(h3),
    brand: parts.length > 1 ? parts[0] : null,
    lines,
    rating: c.querySelector('[data-test="rating-stars"]')?.getAttribute('aria-label') || null,
    image: c.querySelector('img')?.getAttribute('src') || null,
    // Card text runs together ("...may varySponsoredAdd to cart"), so match the "Sponsored" block, not a word.
    sponsored: lines.some((l) => /^Sponsored$/i.test(l)) || /\sSponsored$/.test(aria),
  };
}).filter((r) => r.tcin && r.title)),
  "target.resultsReady": (arg) => (!!document.querySelector('[data-test="ListingPageProductListing"] h3') || !!document.querySelector('[data-test="nlr-container"]') || /captcha|robot or human|access denied/i.test(document.title)),
  "target.cardsReady": (arg) => (document.querySelectorAll('[data-test="ListingPageProductListing"] h3').length >= 20),
  "target.detailReady": (arg) => (!!document.getElementById('__NEXT_DATA__') || !!document.querySelector('[data-test="product-title"]') || /captcha|robot or human|access denied/i.test(document.title)),
  "target.priceReady": (arg) => (!!document.querySelector('[data-test="product-price"]') || /captcha|robot or human|access denied/i.test(document.title)),
  "target.fulfillment": (arg) => ([...new Set(Array.from((document.querySelector('[role="region"][aria-label="Fulfillment"]') || document).querySelectorAll('[data-test="text-quill"]')).map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
  .filter((s) => s.length < 120 && /^(Arrives|Get it|Ships free|Shipping|Delivery|Same Day|Pickup|Ready within|Order pickup|Drive Up|Only \d+ left|Out of stock|Sold out|Not available|Temporarily out)/i.test(s)))].slice(0, 6)),
  "target.nextItem": (arg) => ((() => {
  let d; try { d = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null'); } catch { return null; }
  const hits = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 18 || hits.length > 4) return;
    if (o.tcin && o.item && o.item.product_description) hits.push(o);
    for (const k in o) walk(o[k], depth + 1);
  };
  walk(d, 0);
  const p = hits.find((h) => String(h.tcin) === String(arg)) || hits[0];
  if (!p) return null;
  const it = p.item, pd = it.product_description || {}, ii = (it.enrichment || {}).image_info || {};
  const strip = (s) => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return {
    title: strip(pd.title) || null,
    brand: (it.primary_brand || {}).name || null,
    bullets: ((pd.soft_bullets || {}).bullets || []).map(strip).filter(Boolean).slice(0, 12),
    description: strip(pd.downstream_description).slice(0, 3000) || null,
    images: [ii.primary_image].concat(ii.alternate_images || []).map((i) => i && i.url).filter(Boolean).slice(0, 8),
    specs: (pd.bullet_descriptions || []).map((b) => strip(b).split(/:\s*/)).filter((kv) => kv.length > 1 && kv[1]).map((kv) => [kv[0], kv.slice(1).join(': ')]).slice(0, 40),
  };
})()),
  "target.nextReviews": (arg) => ((() => {
  let d; try { d = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null'); } catch { return []; }
  const hits = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 16 || hits.length > 4) return;
    if (o.ratings_and_reviews && Array.isArray(o.ratings_and_reviews.most_recent)) hits.push(o);
    for (const k in o) walk(o[k], depth + 1);
  };
  walk(d, 0);
  const p = hits.find((h) => String(h.tcin) === String(arg)) || hits[0];
  return (p ? p.ratings_and_reviews.most_recent : []).map((r) => ({ id: String(r.id || ''), title: r.title || '', body: r.text || '', date: r.rating?.submitted_at || '', author: r.author?.nickname || null, rating: r.rating?.value ?? null, verified: null, syndicated: false })).filter((r) => r.body);
})()),
  "target.scrollReviews": (arg) => (void document.querySelector('[data-test="ReviewsDashboard"], [data-test="reviews-heading"]')?.scrollIntoView()),
  "target.reviewsReady": (arg) => (!!document.querySelector('[data-test="review-card--text"]')),
  "target.reviews": (arg) => (Array.from(document.querySelectorAll('[data-test="review-card--text"]')).map((b) => {
  let c = b;
  while (c.parentElement && !c.querySelector('[data-test="review-card--username"]')) c = c.parentElement;
  const t = (h) => (c.querySelector('[data-test="review-card--' + h + '"]')?.textContent || '').replace(/\s+/g, ' ').trim();
  return { title: t('title'), body: (b.innerText || b.textContent || '').trim(), date: t('reviewTime'), author: t('username') || null, rating: parseFloat(t('ratings')) || null, verified: !!c.querySelector('[data-test="review-card--verified-purchase"]'), syndicated: !!c.querySelector('[data-test="review-card--syndicated-badge"]') };
}).filter((r) => r.body)),
  "walmart.ready": (arg) => ((document.readyState !== 'loading' && !!document.getElementById('__NEXT_DATA__')) || /^\/blocked/.test(location.pathname)),
  "walmart.results": (arg) => ((() => {
  let d;
  try { d = JSON.parse(document.getElementById('__NEXT_DATA__').textContent); } catch { return []; }
  const stacks = d?.props?.pageProps?.initialData?.searchResult?.itemStacks || [];
  const ordered = [...stacks.filter((s) => s.layoutEnum !== 'CAROUSEL'), ...stacks.filter((s) => s.layoutEnum === 'CAROUSEL')];
  const seen = new Set();
  const out = [];
  for (const s of ordered) for (const it of s.items || []) {
    if (it.__typename !== 'Product' || !it.usItemId || !it.name || seen.has(String(it.usItemId))) continue;
    seen.add(String(it.usItemId));
    const line = (types, key) => {
      for (const l of it.priceInfo?.priceDetails?.priceLines || []) if (types.includes(l.lineType)) for (const v of l.values || []) if (v.key === key) return v.value;
      return null;
    };
    const tile = (it.badges?.groupsV2 || []).find((g) => g.name === 'ProdTileBadgeModule5');
    const ship = (tile?.members || []).map((m) => (m.content || []).map((c) => c.value).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    out.push({
      id: String(it.usItemId),
      title: it.name,
      brand: it.brand || null,
      price: line(['CURRENT_PRICE', 'DISCOUNTED_PRICE'], 'PRICE') ?? line(['OPTIONS', 'OPTIONS_RANGE'], 'LOW_PRICE') ?? (it.price ?? null),
      wasPrice: line(['COMPARISON'], 'WAS_PRICE'),
      rating: typeof it.averageRating === 'number' ? it.averageRating : null,
      reviews: typeof it.numberOfReviews === 'number' ? it.numberOfReviews : null,
      image: it.imageInfo?.thumbnailUrl || null,
      path: (it.canonicalUrl || '').split('?')[0] || null,
      availability: it.availabilityStatusV2?.value || null,
      flags: (it.badges?.flags || []).map((f) => ({ key: f.key || '', text: f.text || '' })),
      delivery: ship.find((t) => /shipping/i.test(t)) || ship[0] || null,
      sponsored: !!it.isSponsoredFlag,
    });
  }
  return out;
})()),
  "walmart.detail": (arg) => ((() => {
  let d;
  try { d = JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props.pageProps.initialData.data; } catch { return null; }
  const p = d?.product;
  if (!p) return null;
  const idml = d.idml || {};
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const pi = p.priceInfo || {};
  const ship = (p.fulfillmentOptions || []).find((o) => o.type === 'SHIPPING');
  return {
    title: p.name || null,
    brand: p.brand || null,
    price: pi.currentPrice?.price ?? null,
    wasPrice: pi.wasPrice?.price ?? null,
    savings: pi.savings?.priceString || null,
    flags: (p.badges?.flags || []).map((f) => ({ key: f.key || '', text: f.text || '' })),
    rating: typeof p.averageRating === 'number' ? p.averageRating : null,
    reviews: typeof p.numberOfReviews === 'number' ? p.numberOfReviews : null,
    images: (p.imageInfo?.allImages || []).map((i) => String(i.url || '').split('?')[0]).filter(Boolean).slice(0, 8),
    availability: p.availabilityStatus || null,
    shipEta: ship?.speedDetails?.fulfillmentBadge || null,
    shipFree: ship?.speedDetails?.freeFulfillment ?? null,
    lowStock: ship?.isLowInStock ? (ship.availableQuantity ?? 0) : null,
    description: strip(idml.shortDescription || p.shortDescription).slice(0, 3000) || null,
    bullets: (String(idml.longDescription || '').match(/<li[^>]*>[\s\S]*?<\/li>/gi) || []).map(strip).filter(Boolean).slice(0, 12),
    specs: (idml.specifications || []).map((s) => [strip(s.name), strip(s.value)]).filter((kv) => kv[0] && kv[1]).slice(0, 40),
    variants: (p.variantCriteria || []).map((v) => ({ name: v.name || '', options: (v.variantList || []).map((o) => o.name).filter(Boolean).slice(0, 30) })).filter((v) => v.name && v.options.length).slice(0, 6),
    customerReviews: (d.reviews?.customerReviews || []).map((r) => ({
      id: String(r.reviewId || ''),
      rating: typeof r.rating === 'number' ? r.rating : null,
      title: r.reviewTitle || '',
      body: r.reviewText || '',
      date: r.reviewSubmissionTime || '',
      author: r.userNickname || null,
      verified: (r.badges || []).some((b) => b.id === 'VerifiedPurchaser'),
    })),
  };
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
