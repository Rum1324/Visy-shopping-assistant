import type { Need } from "@visy/contracts";

/** The shopper's budget in cents, for a site's own price filter. Either end may be missing. */
export type PriceRange = { minCents?: number; maxCents?: number };

export const priceRange = (need: Pick<Need, "budget">): PriceRange => ({ minCents: need.budget?.min?.cents, maxCents: need.budget?.max?.cents });

/** Amazon's price refinement is `rh=p_36:<min>-<max>` in cents, either end blank. Checked live 2026-10-25 (it is what `low-price`/`high-price` redirect to). */
export function amazonSearchUrl(query: string, price: PriceRange = {}) {
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
  const { minCents: min, maxCents: max } = price;
  if (min == null && max == null) return url;
  return `${url}&rh=${encodeURIComponent(`p_36:${min ?? ""}-${max ?? ""}`)}`;
}

/** Walmart takes whole dollars in `min_price` / `max_price`. Checked live 2026-10-25. */
export function walmartSearchUrl(query: string, price: PriceRange = {}) {
  let url = `https://www.walmart.com/search?q=${encodeURIComponent(query)}`;
  if (price.minCents != null) url += `&min_price=${Math.floor(price.minCents / 100)}`;
  if (price.maxCents != null) url += `&max_price=${Math.ceil(price.maxCents / 100)}`;
  return url;
}

/**
 * Target has no free min/max: only fixed price buckets, each a site-wide facet id, joined with "Z" in `facetedValue`
 * (`min_price`/`max_price` are ignored). Ids read off the live Price filter on 2026-10-25 ("water bottle", "tv").
 */
const TARGET_BUCKETS: [lo: number, hi: number, id: string][] = [
  [0, 5, "7mocu"],
  [5, 10, "bpbp3"],
  [10, 15, "ebfa1"],
  [15, 25, "5zja3"],
  [25, 50, "5zja4"],
  [50, 100, "5zja5"],
  [100, 150, "5zja6"],
  [150, 200, "5zja7"],
  [200, 300, "5zja8"],
  [300, 500, "5zja9"],
  [500, 800, "5zjaa"],
  [800, 1000, "5zjab"],
  [1000, 1500, "5zjac"],
  [1500, 5000, "5zjad"],
  [5000, Infinity, "5zjae"],
];

/** Every bucket that overlaps the range. The edges are coarse, so narrowing still trims to the exact budget. */
export function targetSearchUrl(query: string, price: PriceRange = {}) {
  const url = `https://www.target.com/s?searchTerm=${encodeURIComponent(query)}`;
  const min = (price.minCents ?? 0) / 100;
  const max = (price.maxCents ?? Infinity) / 100;
  const ids = TARGET_BUCKETS.filter(([lo, hi]) => lo < max && hi > min).map(([, , id]) => id);
  if (!ids.length || ids.length === TARGET_BUCKETS.length) return url;
  return `${url}&facetedValue=${ids.join("Z")}`;
}
