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
  sponsored: !!c.querySelector('.puis-sponsored-label-text, [aria-label*="Sponsored"]') || /^Sponsored/.test((c.innerText || '').trim()),
})).filter((r) => r.asin && r.title)),
  "amazon.resultsReady": (arg) => (!!document.querySelector('[data-component-type="s-search-result"][data-asin]') || !!document.querySelector('#checkpointForm, form[action*=validateCaptcha]')),
  "amazon.titlesReady": (arg) => (document.querySelectorAll('[data-component-type="s-search-result"][data-asin] h2').length >= 6 || document.readyState !== 'loading'),
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
};
