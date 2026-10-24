import type { PageState } from "@visy/contracts";

/** Bot checks we hand to the human: CAPTCHAs, Walmart's press-and-hold, Amazon's /checkpoint/ interstitial. */
export const CAPTCHA = /validateCaptcha|captcha|press (&|and) hold|robot or human|enter the characters you see|amazon\.com\/checkpoint\//i;
/** In-page probe for isBlocked: URL, title, top of the page text, challenge forms. Test the result with CAPTCHA. */
export const CAPTCHA_PROBE_JS = `location.href + " " + document.title + " " + (document.body ? document.body.innerText.slice(0, 600) : "") + (document.querySelector("#checkpointForm, form[action*=validateCaptcha]") ? " captcha" : "")`;
const CHALLENGE_SECTION = /tmms-challenge|checkpointForm/i;

export const looksBlocked = (s: PageState) =>
  CAPTCHA.test(s.url) ||
  CAPTCHA.test(s.title) ||
  s.textBlocks.slice(0, 15).some((t) => CAPTCHA.test(t)) ||
  s.elements.some((e) => CHALLENGE_SECTION.test(e.section ?? ""));
