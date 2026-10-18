// Browser stand-in for node:util: Anchor only reaches for TextDecoder/TextEncoder from it under Node.
export const TextDecoder = globalThis.TextDecoder;
export const TextEncoder = globalThis.TextEncoder;
export const inspect = (v: unknown) => String(v);
export default { TextDecoder, TextEncoder, inspect };
