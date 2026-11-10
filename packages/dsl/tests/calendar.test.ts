import { describe, expect, it } from "vitest";
import { calendarDay, checkBindings, type FlatTree, formatDate, readDate, resolveTemplate } from "../src/index.js";

/** Every form a feed sends a date with no time in: all of them are the same calendar day. */
const FORMS = [
  "2026-07-22",
  "2026/07/22",
  "7/22/2026",
  "07/22/2026",
  "7/22/26",
  "22-07-2026",
  "22.07.2026",
  "22 Jul 2026",
  "22-Jul-2026",
  "22 July 2026",
  "Jul 22, 2026",
  "July 22nd, 2026",
  "Wed, 22 Jul 2026",
  "Wednesday 22 July 2026",
  "Wednesday, July 22, 2026",
  "20260722",
];

/** A wall-clock time with no zone: a time in the zone the page is shown in, drawn as written. */
const WALL = [
  "2026-07-22 13:45",
  "2026-07-22T13:45:00",
  "2026-07-22T13:45:00.000",
  "7/22/2026 1:45 PM",
  "7/22/2026, 1:45 pm",
  "07/22/2026 13:45:00",
  "22/07/2026 13:45",
  "22 Jul 2026 13:45",
  "Jul 22, 2026 1:45 PM",
  "July 22, 2026 at 1:45 p.m.",
  "Wed, 22 Jul 2026 13:45",
  "20260722134500",
];

/** An instant: a date and time with an offset or `Z`. 13:45 UTC every one. */
const INSTANTS = [
  "2026-07-22T13:45:00Z",
  "2026-07-22T13:45Z",
  "2026-07-22T13:45:00.000Z",
  "2026-07-22T14:45:00+01:00",
  "2026-07-22T19:15:00+0530",
  "2026-07-22 08:45:00 -05:00",
  "Wed, 22 Jul 2026 13:45:00 GMT",
  "Wed, 22 Jul 2026 13:45:00 +0000",
  "Wed Jul 22 2026 14:45:00 GMT+0100 (British Summer Time)",
  "22 Jul 2026 13:45 UTC",
];

const ZONES = ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"];

describe("a date with no time is a calendar day", () => {
  it("reads each form into its year, month and day", () => {
    for (const form of FORMS) expect(calendarDay(form), form).toEqual({ year: 2026, month: 7, day: 22 });
  });

  it("is the same day whatever the zone of the machine or of the club", () => {
    for (const form of FORMS) {
      for (const zone of ZONES) {
        expect(formatDate(form, "DDDD DD MMMM YYYY", zone), `${form} in ${zone}`).toBe("Wednesday 22 July 2026");
      }
    }
  });

  it("settles day and month by order only where they could swap", () => {
    expect(calendarDay("07/08/2026")).toEqual({ year: 2026, month: 7, day: 8 });
    expect(calendarDay("07/08/2026", "dmy")).toEqual({ year: 2026, month: 8, day: 7 });
    expect(calendarDay("22/07/2026", "mdy")).toEqual({ year: 2026, month: 7, day: 22 });
    expect(calendarDay("07/22/2026", "dmy")).toEqual({ year: 2026, month: 7, day: 22 });
    expect(calendarDay("Sept 22, 2026")).toEqual({ year: 2026, month: 9, day: 22 });
  });

  it("does not read an instant, a number or a non-date as a day", () => {
    expect(calendarDay("2026-07-22T13:45:00Z")).toBeUndefined();
    expect(calendarDay("2026-07-22 13:45")).toBeUndefined();
    expect(calendarDay("soon")).toBeUndefined();
    expect(formatDate("soon", "DD", "UTC")).toBeUndefined();
  });

  it("reads an impossible date as no date, never as another day", () => {
    for (const bad of ["2/30/2026", "2026-02-30", "31 Apr 2026", "2026-13-01", "2/29/2027", "7/22/2026 25:00", "7/22/2026 13:61", "7/22/2026 13 PM"]) {
      expect(formatDate(bad, "DD MMM YYYY", "UTC"), bad).toBeUndefined();
      expect(readDate(bad), bad).toBeUndefined();
    }
    expect(formatDate("2/29/2028", "DD MMM", "UTC")).toBe("29 Feb");
    expect(resolveTemplate('{d | date:"DD MMM" | default:"TBC"}', { d: "2/30/2026" }).value).toBe("TBC");
  });

  it("keeps a year below 100 as written", () => {
    expect(formatDate("0026-07-22", "DD MMM YYYY", "UTC")).toBe("22 Jul 0026");
    expect(formatDate("0026-07-22T10:00:00Z", "DD MMM YYYY HH:mm", "UTC")).toBe("22 Jul 0026 10:00");
    expect(calendarDay("0099-12-31")).toEqual({ year: 99, month: 12, day: 31 });
  });

  it("takes the order from the render's locale", () => {
    expect(resolveTemplate('{d | date:"DD MMM"}', { d: "07/08/2026" }, { dateOrder: "dmy" }).value).toBe("07 Aug");
    expect(resolveTemplate('{d | date:"DD MMM"}', { d: "07/08/2026" }).value).toBe("08 Jul");
    expect(formatDate("07/08/2026 18:30", "DD MMM HH:mm", "UTC", "dmy")).toBe("07 Aug 18:30");
  });
});

describe("a time with no zone is a time in the zone the page is shown in", () => {
  it("draws it as written, whatever the zone", () => {
    for (const form of WALL) {
      for (const zone of ZONES) {
        expect(formatDate(form, "DD MMM HH:mm hh:mm a", zone, "dmy"), `${form} in ${zone}`).toBe("22 Jul 13:45 01:45 PM");
      }
    }
  });

  it("is the instant that wall time is in the zone named", () => {
    expect(readDate("2026-07-22 13:45", { timeZone: "Europe/London" })).toBe(Date.UTC(2026, 6, 22, 12, 45));
    expect(readDate("2026-07-22 13:45", { timeZone: "Asia/Kolkata" })).toBe(Date.UTC(2026, 6, 22, 8, 15));
    expect(readDate("2026-01-22 13:45", { timeZone: "America/Los_Angeles" })).toBe(Date.UTC(2026, 0, 22, 21, 45));
    expect(readDate("2026-07-22 13:45")).toBe(Date.UTC(2026, 6, 22, 13, 45));
    expect(readDate("2026-07-22 13:45", { timeZone: "Mars/Olympus" })).toBeUndefined();
  });

  it("reads a calendar day as the start of that day in the zone named", () => {
    expect(readDate("7/22/2026")).toBe(Date.UTC(2026, 6, 22));
    expect(readDate("22 Jul 2026", { timeZone: "Asia/Kolkata" })).toBe(Date.UTC(2026, 6, 21, 18, 30));
  });
});

describe("an instant is shown in the zone named, never the machine's", () => {
  it("reads every form with an offset as the same instant", () => {
    for (const form of INSTANTS) {
      expect(readDate(form), form).toBe(Date.UTC(2026, 6, 22, 13, 45));
      expect(formatDate(form, "DD MMM HH:mm", "Europe/London"), form).toBe("22 Jul 14:45");
      expect(formatDate(form, "DD MMM HH:mm", "Asia/Kolkata"), form).toBe("22 Jul 19:15");
    }
  });

  it("shows the same time for the same zone", () => {
    const instant = "2026-07-22T13:45:00Z";
    expect(formatDate(instant, "HH:mm", "Europe/London")).toBe("14:45");
    expect(formatDate(instant, "HH:mm", "UTC")).toBe("13:45");
    expect(formatDate(instant, "HH:mm DD", "Asia/Kolkata")).toBe("19:15 22");
    expect(formatDate(Date.UTC(2026, 6, 22, 13, 45), "HH:mm", "Europe/London")).toBe("14:45");
    expect(resolveTemplate('{t | date:"HH:mm"}', { t: instant }, { timeZone: "Europe/London" }).value).toBe("14:45");
  });

  it("gives a sortable key", () => {
    expect(formatDate("2026-07-22T14:45:00+01:00", "YYYYMMDDHHmmss", "UTC")).toBe("20260722134500");
    expect(formatDate("7/22/2026", "YYYYMMDDHHmmss", "UTC")).toBe("20260722000000");
    const keys = ["7/22/2026 1:45 PM", "7/3/2026", "12/1/2025 9:00 AM"].map((v) => formatDate(v, "YYYYMMDDHHmmss", "UTC"));
    expect([...keys].sort()).toEqual(["20251201090000", "20260703000000", "20260722134500"]);
    expect(formatDate("not a date", "YYYYMMDDHHmmss", "UTC")).toBeUndefined();
  });
});

describe("in a process of another zone", () => {
  it("gives the same answers for every form", async () => {
    // a child process: the machine's zone is not an input
    const { execFileSync } = await import("node:child_process");
    const forms = [...FORMS, ...WALL, ...INSTANTS, "Sept 22, 2026", "2/30/2026", "0026-07-22", 1784727900000];
    const script = `
      import { formatDate, readDate } from "./src/binding.ts";
      const forms = ${JSON.stringify(forms)};
      console.log(JSON.stringify(forms.map((f) => [
        formatDate(f, "DDD DD MMM YYYY HH:mm", "Europe/London", "dmy") ?? null,
        formatDate(f, "YYYYMMDDHHmmss", "UTC", "dmy") ?? null,
        readDate(f, { timeZone: "Europe/London", dateOrder: "dmy" }) ?? null,
      ])));`;
    const run = (tz: string) =>
      execFileSync("npx", ["tsx", "-e", script], { env: { ...process.env, TZ: tz }, cwd: process.cwd(), encoding: "utf8" }).trim();
    const [utc, ...others] = ["UTC", "Asia/Kolkata", "America/Los_Angeles"].map(run);
    for (const other of others) expect(other).toBe(utc);
    const answers = JSON.parse(utc!) as Array<[string | null, string | null, number | null]>;
    answers.slice(0, FORMS.length).forEach(([shown], i) => expect(shown, String(forms[i])).toBe("Wed 22 Jul 2026 00:00"));
    answers.slice(FORMS.length, FORMS.length + WALL.length).forEach(([shown], i) =>
      expect(shown, String(forms[FORMS.length + i])).toBe("Wed 22 Jul 2026 13:45"),
    );
    answers.slice(FORMS.length + WALL.length, FORMS.length + WALL.length + INSTANTS.length).forEach(([shown], i) =>
      expect(shown, String(forms[FORMS.length + WALL.length + i])).toBe("Wed 22 Jul 2026 14:45"),
    );
    expect(answers.at(-4)?.[0]).toBe("Tue 22 Sep 2026 00:00");
    expect(answers.at(-3)).toEqual([null, null, null]);
    expect(answers.at(-2)?.[1]).toBe("00260722000000");
  }, 60_000);
});

describe("the binding check reads dates as the pipe does", () => {
  const tree = (content: string): FlatTree =>
    ({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
        { id: "rep", parent: "root", idx: 0, type: "Repeater", src: "1:2", props: { over: "events.items", as: "e" } },
        { id: "txt", parent: "rep", idx: 0, type: "Text", src: "1:3", props: { content } },
      ],
    }) as never;
  const b4 = (content: string, items: unknown[]) =>
    checkBindings(tree(content), { events: { items } }).filter((i) => i.code === "B4");

  it("accepts a date-only value, a named date and a time with no zone", () => {
    // a concert listing and a tide table: neither is a sport
    expect(b4('{e.day | date:"DD MMM"}', [{ day: "7/22/2026" }, { day: "2026-07-23" }, { day: "Sept 1, 2026" }])).toEqual([]);
    expect(b4('{e.at | date:"HH:mm"}', [{ at: "2026-07-22 05:12" }, { at: null }, { at: "Thu, 23 Jul 2026 06:01" }])).toEqual([]);
  });

  it("reports the values it cannot read, apart from a field that holds no dates at all", () => {
    const some = b4('{e.day | date:"DD MMM"}', [{ day: "7/22/2026" }, { day: "2/30/2026" }, { day: "TBC" }]);
    expect(some).toHaveLength(1);
    expect(some[0]!.message).toContain('cannot be read as a date ("2/30/2026", "TBC")');
    const none = b4('{e.title | date:"DD MMM"}', [{ title: "Doors open" }]);
    expect(none[0]!.message).toContain("not dates");
  });
});
