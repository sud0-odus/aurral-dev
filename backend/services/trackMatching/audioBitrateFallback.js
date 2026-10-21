import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";

const execFileAsync = promisify(execFile);

// music-metadata can omit bitrate for WebM/Opus; ffprobe can read container bitrate.
// Never infer lossless quality or invent a bitrate.
export async function parseAudioWithBitrate(filePath, { parse = parseFile, probe = execFileAsync } = {}) {
  const parsed = await parse(filePath, { duration: true });
  if (Number(parsed?.format?.bitrate) > 0) return parsed;
  const codec = String(parsed?.format?.codec || "").toLowerCase();
  const container = String(parsed?.format?.container || "").toLowerCase();
  if (!codec.includes("opus") && !container.includes("webm")) return parsed;
  try {
    const { stdout } = await probe("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_name,bit_rate:format=bit_rate",
      "-of", "json", filePath,
    ], { timeout: 10000, maxBuffer: 65536 });
    const data = JSON.parse(stdout);
    const audio = (data.streams || []).find((stream) =>
      String(stream.codec_name || "").toLowerCase() === "opus");
    const rate = Number(audio?.bit_rate) || Number(data.format?.bit_rate);
    if (Number.isFinite(rate) && rate > 0 && rate < 100000000) {
      return { ...parsed, format: { ...parsed.format, bitrate: rate } };
    }
  } catch {
    // Missing ffprobe or malformed metadata: leave quality unknown, never guess.
  }
  return parsed;
}
