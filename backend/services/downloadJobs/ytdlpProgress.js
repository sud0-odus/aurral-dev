// Parse yt-dlp's explicit byte-progress markers, with legacy percentage fallback.
// Keep independent line buffers for stdout/stderr because OS pipe chunks split
// arbitrary lines and the two streams are not interleavable.
export function createYtdlpProgressObserver(onProgress) {
  let progressBytes = -1;
  let progressPercent = -1;
  const buffers = { stdout: "", stderr: "" };
  return (output, stream = "stdout") => {
    const key = stream === "stderr" ? "stderr" : "stdout";
    const lines = (buffers[key] + String(output || "")).split(/[\r\n]+/);
    buffers[key] = lines.pop()?.slice(-256) || "";
    for (const line of lines) {
      const bytes = /__AURRAL_BYTES__:(\d+)/.exec(line);
      if (bytes && Number(bytes[1]) > progressBytes) {
        progressBytes = Number(bytes[1]);
        onProgress();
        continue;
      }
      const percentage = /(?:\[download\]\s+|__AURRAL_BYTES__:[^:]*:\s*)(\d+(?:\.\d+)?)%/.exec(line);
      if (percentage && Number(percentage[1]) > progressPercent) {
        progressPercent = Number(percentage[1]);
        onProgress();
      }
    }
  };
}
