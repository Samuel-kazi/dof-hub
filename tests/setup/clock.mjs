// Loaded before every test file (see scripts/run-tests.mjs). It fixes "now" so that sample data built
// relative to today and dates written into the tests always agree, whatever day the tests run.
// The clock still moves forward in real time from the fixed start, so timers and timeouts behave normally.
// Override with DOF_TEST_NOW=2026-12-01T09:00:00+03:00 to try another day.

const RealDate = Date;
const fixed = RealDate.parse(process.env.DOF_TEST_NOW || "2026-09-26T09:00:00+03:00");
if (Number.isNaN(fixed)) throw new Error(`DOF_TEST_NOW is not a date: ${process.env.DOF_TEST_NOW}`);
const startedAt = RealDate.now();
const now = () => fixed + (RealDate.now() - startedAt);

class TestDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(now());
    else super(...args);
  }
  static now() {
    return now();
  }
}

globalThis.Date = TestDate;
