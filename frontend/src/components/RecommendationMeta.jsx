import Tooltip from "./Tooltip";

export const getMatchPercent = (artist) => {
  const value = Number(artist?.matchPercent);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
};

export default function RecommendationMeta({ artist, text, className }) {
  // matchPercent is a position-derived ranking label, not a calibrated similarity.
  // Show supporting evidence instead of presenting rank as a probability.
  const seeds = Array.isArray(artist?.supportingSeeds)
    ? artist.supportingSeeds.map((seed) => seed?.artistName).filter(Boolean)
    : [];
  const tags = Array.isArray(artist?.matchedTags)
    ? artist.matchedTags.filter(Boolean)
    : [];
  const detail = [
    seeds.length ? `Related via: ${seeds.join(", ")}` : null,
    tags.length ? `Shared tags: ${tags.join(", ")}` : null,
  ].filter(Boolean).join(" • ");
  const visibleText = seeds.length
    ? `Related via ${seeds.slice(0, 2).join(" & ")}${seeds.length > 2 ? ` +${seeds.length - 2}` : ""}`
    : tags.length
      ? `Shared tags: ${tags.slice(0, 2).join(", ")}`
      : text || "Suggested artist";
  return (
    <Tooltip content={detail || visibleText}>
      <p className={className}>{visibleText}</p>
    </Tooltip>
  );
}
