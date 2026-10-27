import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  minutesSetting,
  numberSetting,
  optionalNumberSetting,
  ruleWords,
  secondsSetting,
} from "../../src/common/settings.ts";
import { brokerNumbers } from "../../src/harness/broker/settings.ts";
import { harnessNumbers } from "../../src/harness/env-numbers.ts";

describe("numeric settings stop the part at start with words (goal 164)", () => {
  test("seconds: unset or empty is the default; a typo, 0 or a unit is refused", () => {
    assert.equal(secondsSetting({}, "THERMITE_POLL_SECONDS", 60), 60_000);
    assert.equal(
      secondsSetting({ THERMITE_POLL_SECONDS: " " }, "THERMITE_POLL_SECONDS", 60),
      60_000,
    );
    assert.equal(
      secondsSetting({ THERMITE_POLL_SECONDS: "2.5" }, "THERMITE_POLL_SECONDS", 60),
      2500,
    );
    for (const bad of ["abc", "0", "-5", "30s"])
      assert.throws(
        () => secondsSetting({ THERMITE_POLL_SECONDS: bad }, "THERMITE_POLL_SECONDS", 60),
        new RegExp(
          `^Error: THERMITE_POLL_SECONDS takes a number of seconds above 0, not "${bad}"$`,
        ),
      );
  });

  test("minutes: the export interval that once stopped exports, or exported every few seconds", () => {
    const env = (v: string) => ({ THERMITE_EXPORT_MINUTES: v });
    assert.equal(minutesSetting(env("90"), "THERMITE_EXPORT_MINUTES", 60), 90 * 60_000);
    assert.throws(
      () => minutesSetting(env("6O"), "THERMITE_EXPORT_MINUTES", 60),
      /takes a number of minutes above 0, not "6O"/,
    );
    assert.throws(() => minutesSetting(env("0"), "THERMITE_EXPORT_MINUTES", 60), /above 0/);
  });

  test("an interval whose 0 turns its loop off takes 0, and nothing below", () => {
    const off = { aboveMin: false, zeroMeans: "off" };
    assert.equal(secondsSetting({ K: "0" }, "K", 180, off), 0);
    assert.throws(
      () => secondsSetting({ K: "-1" }, "K", 180, off),
      /^Error: K takes a number of seconds from 0 \(0: off\), not "-1"$/,
    );
  });

  test("counts and ports: whole numbers within their bounds", () => {
    const port = { integer: true, min: 1, max: 65535 };
    assert.equal(numberSetting({ P: "8800" }, "P", 1, port), 8800);
    assert.throws(
      () => numberSetting({ P: "88.5" }, "P", 1, port),
      /P takes a whole number from 1 to 65535, not "88.5"/,
    );
    assert.throws(() => numberSetting({ P: "70000" }, "P", 1, port), /from 1 to 65535/);
    assert.equal(optionalNumberSetting({}, "N", { integer: true }), undefined);
    assert.equal(ruleWords({ unit: "MB", aboveMin: true }), "a number of MB above 0");
  });

  test("the harness's and the broker's settings are read at their start", () => {
    assert.equal(harnessNumbers({}).exportEveryMs, 60 * 60_000);
    assert.equal(
      harnessNumbers({ THERMITE_RESEARCH_MAX_MB: "2" }).researchMaxBytes,
      2 * 1024 * 1024,
    );
    assert.throws(
      () => harnessNumbers({ THERMITE_MAX_TURNS: "lots" }),
      /THERMITE_MAX_TURNS takes a whole number from 1/,
    );
    assert.throws(
      () => harnessNumbers({ THERMITE_EXPORT_MINUTES: "6O" }),
      /THERMITE_EXPORT_MINUTES/,
    );
    assert.deepEqual(brokerNumbers({}), { outboxGid: 10001, fatalHoldMs: 0 });
    assert.equal(brokerNumbers({ THERMITE_FATAL_HOLD_SECONDS: "900" }).fatalHoldMs, 600_000);
    assert.throws(
      () => brokerNumbers({ THERMITE_OUTBOX_GID: "group" }),
      /THERMITE_OUTBOX_GID takes a whole number/,
    );
  });
});
