// OPS-2: one line per browser test that failed once and passed on its retry, appended to PULSE_CI_FLAKY_FILE; tools/ci.sh
// lists them in its summary. A test that fails both attempts is a failure, reported by the list reporter as before.
import { appendFileSync } from "node:fs";

export default class FlakyReporter {
  onTestEnd(test, result) {
    if (result.status !== "passed" || test.outcome() !== "flaky") return;
    const first = test.results.find((r) => r.status !== "passed");
    const why = (first?.error?.message || first?.status || "").split("\n")[0].replace(/\u001b\[[0-9;]*m/g, "").slice(0, 300);
    appendFileSync(process.env.PULSE_CI_FLAKY_FILE, `e2e ${test.titlePath().filter(Boolean).join(" › ")}\t${why}\n`);
  }

  printsToStdio() {
    return false;
  }
}
