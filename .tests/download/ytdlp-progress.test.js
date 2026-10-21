import assert from "node:assert/strict";
import test from "node:test";
import { createYtdlpProgressObserver } from "../../backend/services/downloadJobs/ytdlpProgress.js";

test("parse yt-dlp progress even when pipe chunks split lines", () => {
  let progress = 0;
  const observe = createYtdlpProgressObserver(() => { progress++; });
  observe("__AURRAL_BYTE", "stdout");
  observe("S__:0:   0.0%\n", "stdout");
  observe("__AURRAL_BYTES__:1024:  10.0%\n", "stdout");
  observe("__AURRAL_BYTES__:1024:  10.0%\n", "stdout");
  observe("__AURRAL_BYTES__:2048:  20.0%\n", "stderr");
  assert.equal(progress, 3);
});

test("percentage fallback works when byte metric is unavailable", () => {
  let progress = 0;
  const observe = createYtdlpProgressObserver(() => { progress++; });
  observe("__AURRAL_BYTES__:NA:  12.5%\n", "stdout");
  observe("__AURRAL_BYTES__:NA:  12.5%\n", "stdout");
  observe("__AURRAL_BYTES__:NA:  99.9%\n", "stdout");
  assert.equal(progress, 2);
});

test("arbitrary log output does not count as transfer progress", () => {
  let progress = 0;
  const observe = createYtdlpProgressObserver(() => { progress++; });
  observe("[info] waiting 99% of the time\n", "stderr");
  observe("some-log-with-bytes=500\n", "stdout");
  assert.equal(progress, 0);
});
