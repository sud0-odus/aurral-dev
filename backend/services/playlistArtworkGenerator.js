import fs from "node:fs/promises";
import path from "node:path";
import { dbOps } from "../db/helpers/index.js";
import { buildPlaylistArtworkWebpBuffer } from "./playlistArtwork.js";
import sharp from "./sharpConfig.js";
import axios from "../../lib/axiosFetch.js";
import { isTrustedArtworkUrl } from "./playlistArtworkSources.js";
import {
  renderStylizedPhotoArtwork,
} from "./discovery/stylizedArtwork.js";
export const PLAYLIST_ARTWORK_STYLES = ["aurral", "photo"];

export function getPlaylistArtworkStyle() {
  const settings = dbOps.getSettings() || {};
  const style = String(settings?.playlistArtwork?.style || "photo")
    .trim()
    .toLowerCase();
  return PLAYLIST_ARTWORK_STYLES.includes(style) ? style : "photo";
}

export function getArtworkExtensionForStyle(style = getPlaylistArtworkStyle()) {
  return style === "photo" ? ".jpg" : ".webp";
}

export function getArtworkContentTypeForExtension(extension) {
  const normalized = String(extension || "").toLowerCase();
  if (normalized === ".webp") return "image/webp";
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  return "image/png";
}

// Deliberately no random stock images: a playlist cover must be musically relevant.
export async function resolvePlaylistSourceImageUrl(imageUrls = []) {
  return imageUrls.find(isTrustedArtworkUrl) || null;
}
async function downloadTrustedCover(url) {
  if (!isTrustedArtworkUrl(url)) throw new Error("Untrusted playlist cover URL");
  const response = await axios.get(url, {
    responseType: "arraybuffer", timeout: 7000, maxRedirects: 0,
    maxContentLength: 6 * 1024 * 1024, maxBodyLength: 6 * 1024 * 1024,
    validateStatus: status => status === 200,
  });
  return Buffer.from(response.data);
}
async function selectCoverImageBuffer(imageUrls) {
  const urls = [...new Set((Array.isArray(imageUrls) ? imageUrls : []).filter(isTrustedArtworkUrl))].slice(0, 4);
  const covers = [];
  for (const url of urls) {
    try {
      const buffer = await downloadTrustedCover(url);
      const meta = await sharp(buffer, { animated: false, limitInputPixels: 20_000_000 }).metadata();
      if (meta.width < 16 || meta.height < 16) continue;
      covers.push(buffer);
    } catch { /* Another album may still provide artwork. */ }
  }
  if (!covers.length) throw new Error("No usable album artwork for this playlist");
  if (covers.length === 1) return covers[0];
  const tile = 600;
  const positions = [
    { left: 0, top: 0 }, { left: tile, top: 0 },
    { left: 0, top: tile }, { left: tile, top: tile },
  ];
  const sources = covers.length === 2 ? [covers[0],covers[1],covers[1],covers[0]] :
    covers.length === 3 ? [covers[0],covers[1],covers[2],covers[0]] : covers;
  const layers = await Promise.all(sources.map(async (buffer, index) => ({
    input: await sharp(buffer, { animated: false, limitInputPixels: 20_000_000 })
      .resize(tile, tile, { fit: "cover" }).jpeg().toBuffer(),
    ...positions[index],
  })));
  return sharp({ create: { width: 1200, height: 1200, channels: 3, background: "#1b1924" } })
    .composite(layers).jpeg().toBuffer();
}

export async function isGeneratedPlaylistArtworkFallback(filePath, { title, kind, artistNames = [] }) {
  try {
    const metadata = await sharp(filePath).metadata();
    if (metadata.width !== 1000 || metadata.height !== 1000) return false;
    const existing = await fs.readFile(filePath);
    const fallback = await buildPlaylistArtworkWebpBuffer({ playlistName: title, kind, artistNames });
    if (path.extname(filePath).toLowerCase() === ".webp") {
      return existing.equals(fallback);
    }
    const jpeg = await sharp(fallback).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    return existing.equals(jpeg);
  } catch {
    return false;
  }
}

export async function buildGeneratedPlaylistArtworkBuffer({
  title,
  kind = "Playlist",
  style = null,
  paletteSeed = null,
  imageUrls = [],
  artistNames = [],
}) {
  const resolvedStyle = style || getPlaylistArtworkStyle();
  const displayTitle = String(title || "").trim() || "Untitled";

  if (resolvedStyle === "aurral") {
    return buildPlaylistArtworkWebpBuffer({
      playlistName: displayTitle,
      kind,
      artistNames,
    });
  }

  // Use only artwork associated with the playlist's own tracks.
  // A missing cover falls back to Aurral's music-themed art, not an unrelated photo.
  const sourceBuffer = await selectCoverImageBuffer(imageUrls);
  return renderStylizedPhotoArtwork({
    imageBuffer: sourceBuffer,
    title: displayTitle,
    paletteSeed,
  });
}

const resolveArtworkOutputPath = (outputPath, style) => {
  const extension = getArtworkExtensionForStyle(style);
  const directory = path.dirname(outputPath);
  const baseName = path.basename(outputPath, path.extname(outputPath));
  return path.join(directory, `${baseName}${extension}`);
};

export async function writeGeneratedPlaylistArtwork({
  outputPath,
  title,
  kind = "Playlist",
  style = null,
  paletteSeed = null,
  imageUrls = [],
  artistNames = [],
}) {
  const resolvedStyle = style || getPlaylistArtworkStyle();
  const targetPath = resolveArtworkOutputPath(outputPath, resolvedStyle);
  const directory = path.dirname(targetPath);
  const baseName = path.basename(targetPath, path.extname(targetPath));
  const keepExtension = path.extname(targetPath);

  const buffer = await buildGeneratedPlaylistArtworkBuffer({
    title,
    kind,
    style: resolvedStyle,
    paletteSeed,
    imageUrls,
    artistNames,
  });

  for (const extension of [".jpg", ".webp", ".png"]) {
    if (extension === keepExtension) continue;
    await fs.unlink(path.join(directory, `${baseName}${extension}`)).catch(() => {});
  }

  await fs.writeFile(targetPath, buffer);
  return targetPath;
}
