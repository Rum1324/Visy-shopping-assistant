import { z } from "zod";
import { IsoDate, ProductId } from "./common.ts";
import { ProductCandidate, ProductDetail, RawReview } from "./product.ts";

/** Questions every review synthesis tries to answer. These set us apart from Innosearch. Extend freely. */
export const ACCESSIBILITY_QUESTIONS = [
  "Can it be used without sight (tactile buttons, distinct shapes, audible feedback)?",
  "Are setup and instructions usable without sight (audio or video guide, braille, screen-reader-friendly app)?",
  "Do the photos or listing misrepresent color, size, texture or materials?",
  "Is the packaging easy to open?",
  "Are there sharp edges, hot surfaces or other safety concerns?",
  "If there is a companion app, does it work with VoiceOver or TalkBack?",
] as const;

export const AccessibilityInsight = z.object({
  question: z.string(),
  answer: z.string(), // speakable, 1 to 2 sentences; "Reviewers don't mention this" is a valid answer
  sentiment: z.enum(["positive", "negative", "mixed", "unknown"]),
  evidenceCount: z.number().int().nonnegative(),
  quotes: z.array(z.string().max(200)).max(2).default([]),
});
export type AccessibilityInsight = z.infer<typeof AccessibilityInsight>;

export const ReviewSynthesis = z.object({
  productId: ProductId,
  /** At most 2 sentences, written to be spoken aloud. */
  summary: z.string(),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
  accessibility: z.array(AccessibilityInsight).default([]),
  sourceCounts: z.partialRecord(RawReview.shape.source, z.number().int().nonnegative()).default({}),
  newestReviewAt: IsoDate.optional(),
  /** E.g. "Most reviews are over 2 years old", "Few verified purchases". */
  warnings: z.array(z.string()).default([]),
  generatedAt: IsoDate,
});
export type ReviewSynthesis = z.infer<typeof ReviewSynthesis>;

export const VisualDescription = z.object({
  productId: ProductId,
  imageUrl: z.url(),
  /** One sentence, said by default. */
  short: z.string(),
  /** Said when the user asks "describe it more". */
  detailed: z.string(),
  colors: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type VisualDescription = z.infer<typeof VisualDescription>;

/** One of the 3 picks. reviews and visual are optional so the shortlist can stream in progressively. */
export const ShortlistItem = z.object({
  rank: z.number().int().min(1).max(3),
  product: z.union([ProductDetail, ProductCandidate]),
  reviews: ReviewSynthesis.optional(),
  visual: VisualDescription.optional(),
  whyPicked: z.string(),
});
export type ShortlistItem = z.infer<typeof ShortlistItem>;
