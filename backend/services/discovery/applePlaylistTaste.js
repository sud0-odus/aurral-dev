export const PERSONAL_TASTE_PROFILE_VERSION = "apple-imports-personal-v3-multi-source";
export function getAppleMusicPlaylistSeeds(playlists, userId, { limit = 100 } = {}) {
  const ownerId = Number(userId);
  if (!Number.isSafeInteger(ownerId) || ownerId < 1) return [];
  const max = Math.max(0, Math.min(250, Math.trunc(Number(limit) || 0)));
  if (!max) return [];
  const pools = (Array.isArray(playlists) ? playlists : [])
    .filter(p => Number(p?.ownerUserId) === ownerId && String(p?.sourceName || "").trim().toLowerCase() === "apple music")
    .map(p => {
      const artists = new Map();
      for (const t of Array.isArray(p?.tracks) ? p.tracks : []) {
        const name = String(t?.artistName || "").trim();
        if (!name) continue;
        const key = name.normalize("NFKC").toLowerCase();
        if (artists.has(key)) artists.get(key).count++;
        else artists.set(key, {artistName:name,count:1});
      }
      return [...artists.values()].sort((a,b)=>b.count-a.count||a.artistName.localeCompare(b.artistName));
    }).filter(p=>p.length);
  const seeds=[], seen=new Set(), positions=pools.map(()=>0);
  while(seeds.length<max){
    let advanced=false;
    for(let i=0;i<pools.length&&seeds.length<max;i++){
      while(positions[i]<pools[i].length){
        const a=pools[i][positions[i]++], key=a.artistName.normalize("NFKC").toLowerCase();
        if(seen.has(key))continue;
        seen.add(key);seeds.push({artistName:a.artistName,source:"apple_music",playcount:Math.min(30,a.count),profileBucket:"apple_playlist"});advanced=true;break;
      }
    }
    if(!advanced)break;
  }
  return seeds;
}
