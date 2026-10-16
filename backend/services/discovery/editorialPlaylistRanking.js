const normalized = value => String(value || "").normalize("NFKC").trim().toLowerCase();
const words = value => normalized(value).split(/[^\\p{L}\\p{N}]+/u).filter(Boolean);
const matches = (text, term) => {
  const needle=words(term);
  if (!needle.length) return false;
  const hay=words(text);
  return needle.some((_,index) => false) || hay.some((_,index) =>
    needle.every((word,offset)=>hay[index+offset]===word));
};
/** Owner-specific context only. Ignore playlist popularity and search response
 * ordering except as a stable tie-breaker. */
export function rankPersonalEditorialPlaylists(playlists, discovery, {limit=12}={}) {
  const seeds=(discovery?.basedOn || []).map(x=>String(x.name || x.artistName || "").trim()).filter(Boolean);
  const genres=[...(discovery?.topGenres || []),...(discovery?.topTags || [])]
    .map(x=>String(x || "").trim()).filter(Boolean);
  const seen=new Set();
  return (playlists || []).map((playlist,index)=>{
    const id=String(playlist?.id || "");
    const title=String(playlist?.name || playlist?.title || "");
    const text=title+" "+String(playlist?.description || "");
    const artistHits=seeds.filter(seed=>matches(text,seed)).length;
    const genreHits=genres.filter(tag=>matches(text,tag)).length;
    const titleHits=seeds.filter(seed=>matches(title,seed)).length;
    const score=artistHits*100+titleHits*25+genreHits*20;
    return {playlist,index,id,score};
  }).filter(entry=>{
    if (!entry.id || seen.has(entry.id)) return false;
    seen.add(entry.id);return true;
  }).sort((a,b)=>b.score-a.score || a.index-b.index)
    .slice(0,Math.max(0,Math.min(24,Number(limit)||12))).map(x=>x.playlist);
}
