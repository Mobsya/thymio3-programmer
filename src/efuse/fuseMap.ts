/**
 * Fuse map arithmetic: what the current eFuse word looks like, and what a
 * candidate ID would do to it. eFuses only ever go from 0 to 1, so a target
 * bit at 0 where the fuse already reads 1 is physically impossible and needs
 * a fresh slot.
 *
 * Pure module: index 0 is bit 0, index 31 is bit 31.
 */

export type BitState = "intact" | "burned" | "toburn" | "conflict";

export interface FuseMapResult {
  /** One entry per bit, indexed by bit position. */
  bits: BitState[];
  /** Bits at 0 that the write would blow to 1. */
  toBurn: number;
  /** Bits at 1 that the target would need back at 0: impossible. */
  conflict: number;
}

export function classifyBits(current: number | null, target: number | null): FuseMapResult {
  const bits: BitState[] = new Array<BitState>(32).fill("intact");
  let toBurn = 0;
  let conflict = 0;

  for (let i = 0; i < 32; i++) {
    const currentBit = current === null ? 0 : (current >>> i) & 1;
    const targetBit = target === null ? currentBit : (target >>> i) & 1;

    if (current !== null && currentBit === 1 && targetBit === 0) {
      bits[i] = "conflict";
      conflict++;
    } else if (currentBit === 1) {
      bits[i] = "burned";
    } else if (current !== null && targetBit === 1) {
      bits[i] = "toburn";
      toBurn++;
    }
  }

  return { bits, toBurn, conflict };
}

export type VerdictLevel = "neutral" | "ok" | "warn" | "bad";

export interface Verdict {
  level: VerdictLevel;
  text: string;
}

export function describeVerdict(
  current: number | null,
  target: number | null,
  map: FuseMapResult,
): Verdict {
  if (current === null) {
    return { level: "neutral", text: "Connect the robot to fill the map." };
  }
  if (target === null) {
    return { level: "neutral", text: "The ID in the write field is not valid." };
  }
  if (map.conflict > 0) {
    return {
      level: "bad",
      text: `${map.conflict} bits would have to go back to 0: this slot cannot take the ID, kill it first.`,
    };
  }
  if (map.toBurn === 0) {
    return { level: "ok", text: "This ID is already programmed, writing it burns nothing." };
  }
  return {
    level: "warn",
    text: `${map.toBurn} bits to burn, no conflict: the write goes through on the current slot.`,
  };
}
