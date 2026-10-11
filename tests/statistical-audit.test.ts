import { describe, expect, it } from "vitest";
import {
  computeExactTwoTailedBinomialPValue,
  computeWilson95Interval
} from "../src/analyzer/engine/shadow";

describe("Stage 3.4 statistical audit", () => {
  it("computes exact two-tailed McNemar binomial p-values from discordant pairs", () => {
    expect(computeExactTwoTailedBinomialPValue(0, 0)).toBe(1);
    expect(computeExactTwoTailedBinomialPValue(10, 5)).toBe(1);
    expect(computeExactTwoTailedBinomialPValue(10, 0)).toBeCloseTo(2 / 1024, 12);
    expect(computeExactTwoTailedBinomialPValue(10, 10)).toBeCloseTo(2 / 1024, 12);
    expect(computeExactTwoTailedBinomialPValue(3, 4)).toBeNull();
  });

  it("keeps confidence intervals tied to completed outcomes", () => {
    expect(computeWilson95Interval(4, 10)).not.toBeNull();
    expect(computeWilson95Interval(4, 0)).toBeNull();
    expect(computeWilson95Interval(11, 10)).toBeNull();
  });
});
