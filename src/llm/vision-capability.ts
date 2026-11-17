// Which models are known to accept image input (OpenAI-compatible image_url parts).
// Fail-closed: a model that is not known to support vision returns false, so the
// fallback layer skips it instead of burning a request on a call that will fail.
// A model may only be marked true after its vision support has been verified
// against the provider's docs or a live call — never from the model name alone.
//
// Verified (18 Nov 2026, owner's provider chain in .env.example):
// - gemini-4-hydrogen: yes (Google multimodal model, image input supported).
// - nvidia/nemotron-3.5-super-vl:free: yes (VL = vision-language).
// - cohere/north-mini-code:free: no (text-only coding model).
// - nvidia/nemotron-3.5-lightning:free: no (text-only fast model).
// - baidu/ernie-5.5-flash-preview:free: UNKNOWN — returns false until verified.
// - z-ai/glm-5.3-flash: UNKNOWN — returns false until verified.
//   Do not flip either of those to true without checking the provider first.

/** Model ids known to support image input (compared lowercase). */
const VISION_MODELS: ReadonlySet<string> = new Set([
  "gemini-4-hydrogen",
  "nvidia/nemotron-3.5-super-vl:free",
]);

/**
 * Family patterns for vision models. Only the Nemotron Super-VL family is
 * listed: the "-vl" marker is the vendor's own vision-language designation,
 * so other sizes of the same family share the capability. Nothing else is
 * inferred from a name — e.g. a future "gemini-*" model is NOT assumed to
 * support vision until it is verified and added to VISION_MODELS.
 */
const VISION_FAMILY_PATTERNS: readonly RegExp[] = [
  /(^|\/)nemotron-[^/]*super-vl(?::|$)/,
];

export function supportsVision(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (id === "") return false;
  if (VISION_MODELS.has(id)) return true;
  return VISION_FAMILY_PATTERNS.some((re) => re.test(id));
}
