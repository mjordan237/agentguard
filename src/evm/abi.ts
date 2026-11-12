import type { DecodedInstructionSummary } from "../policy/types.js";

export const WORD = 64; // hex characters in one 32-byte ABI word
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function normalizeAddress(value: string): string | undefined {
  return ADDRESS.test(value) ? value.toLowerCase() : undefined;
}

export function rawDump(programId: string, name: string, reason: string, accounts: string[]): DecodedInstructionSummary {
  return { programId, instructionName: name, fields: { reason }, mode: "raw_dump", accounts };
}

/** Splits hex (no 0x) into 32-byte words, or undefined if it is not exactly `count` words. */
export function words(body: string, count: number): string[] | undefined {
  if (body.length !== count * WORD || !/^[0-9a-f]*$/.test(body)) return undefined;
  return Array.from({ length: count }, (_, i) => body.slice(i * WORD, (i + 1) * WORD));
}

/** A word is an address only if its top 12 bytes are zero; anything else is malformed and not guessed at. */
export function wordAddress(word: string): string | undefined {
  return /^0{24}[0-9a-f]{40}$/.test(word) ? `0x${word.slice(24)}` : undefined;
}

/** A word as an unsigned integer, or undefined if it does not fit in `bits` bits (dirty high bits are malformed). */
export function wordUint(word: string, bits: number): bigint | undefined {
  if (!/^[0-9a-f]{64}$/.test(word)) return undefined;
  const n = BigInt(`0x${word}`);
  return n < 1n << BigInt(bits) ? n : undefined;
}

/** Reads `count` words starting at word index `at` of `body`, or undefined if that runs past the end. */
export function wordsAt(body: string, at: number, count: number): string[] | undefined {
  if (at < 0 || count < 0 || (at + count) * WORD > body.length) return undefined;
  return Array.from({ length: count }, (_, i) => body.slice((at + i) * WORD, (at + i + 1) * WORD));
}

/** The integer in word `at` of `body`, or undefined if the word is missing or does not fit in `bits` bits. */
export function uintAt(body: string, at: number, bits: number): bigint | undefined {
  const w = wordsAt(body, at, 1);
  return w ? wordUint(w[0], bits) : undefined;
}

/** A byte offset that must sit on a word boundary, converted to a word index; undefined otherwise. */
export function offsetWords(value: bigint | undefined): number | undefined {
  return value !== undefined && value % 32n === 0n && value < 1n << 31n ? Number(value / 32n) : undefined;
}
