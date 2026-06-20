import { customAlphabet } from "nanoid";

// Unambiguous alphabet — excludes i, l, o, 0, 1.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const seg3 = customAlphabet(CODE_ALPHABET, 3);
const seg4 = customAlphabet(CODE_ALPHABET, 4);

/**
 * Generates a meeting code in xxx-yyyy-zzz format (3-4-3 = 10 chars).
 * ~31^10 ≈ 8.2e14 combinations.
 */
export function generateMeetingCode(): string {
  return `${seg3()}-${seg4()}-${seg3()}`;
}
