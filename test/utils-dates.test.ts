import { describe, it, expect, afterEach, vi } from "vitest";
import { addDays, daysBetween, todayISO } from "@/lib/utils";

/**
 * The date a screen pre-fills, and the arithmetic done on it.
 *
 * `todayISO()` is the default for every date field in the product — an invoice
 * issue date, a receipt, a payment, a petty cash chit — and it used to be
 * `new Date().toISOString().slice(0, 10)` under a comment claiming Asia/Dubai.
 * That is UTC, and between midnight and four in the morning in the Gulf it is
 * still yesterday in UTC. The window is small and the consequence is not: a
 * receipt keyed at one in the morning on 1 July was offered 30 June, which is
 * the previous VAT quarter and may be a period that has already been closed.
 *
 * The clock is frozen in each of these, because a test whose answer depends on
 * when it runs is a test that fails once a quarter and is then re-run until it
 * passes.
 */
describe("today, on the calendar the books are kept on", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (utc: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(utc));
  };

  it("is already tomorrow in the Gulf when UTC still says yesterday", () => {
    // 21:00 UTC on 30 June is one in the morning on 1 July in Dubai — the exact
    // hour the old implementation put the whole quarter wrong.
    at("2026-06-30T21:00:00.000Z");
    expect(todayISO()).toBe("2026-07-01");
  });

  it("does not run ahead of the Gulf day either", () => {
    // 19:00 UTC is eleven at night here: still the same day, and a date field
    // that offered tomorrow would be as wrong as one that offered yesterday.
    at("2026-07-01T19:00:00.000Z");
    expect(todayISO()).toBe("2026-07-01");
  });

  it("crosses a year end on the Gulf's midnight, not on UTC's", () => {
    at("2026-12-31T20:00:00.000Z");
    expect(todayISO()).toBe("2027-01-01");
  });
});

/**
 * The arithmetic is in UTC because a plain date has no clock on it. Parsing
 * "2026-01-01T00:00:00" as a LOCAL instant and printing it back through
 * `toISOString()` returns the day before for every reader east of Greenwich,
 * which is every reader of this product — and `addDays(todayISO(), 30)` is how
 * a bill's due date is offered.
 */
describe("date arithmetic on plain dates", () => {
  it("adds days without the day shifting under it", () => {
    expect(addDays("2026-01-01", 30)).toBe("2026-01-31");
    expect(addDays("2026-01-01", 0)).toBe("2026-01-01");
    expect(addDays("2026-01-31", -30)).toBe("2026-01-01");
  });

  it("steps over a month and a year end", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("knows a leap year has a 29 February", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
  });

  it("counts the days between two dates the same way round", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2026-01-31", "2026-01-01")).toBe(-30);
    expect(daysBetween(addDays("2026-06-15", 45), "2026-06-15")).toBe(-45);
  });
});
