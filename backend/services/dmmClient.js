// Standalone DMM catalog / Real-Debrid client. Not registered with Aurral's active queue.
const DMM = 'https://debridmediamanager.com/api/music/library';
const RD = 'https://api.real-debrid.com/rest/1.0';

async function requestJson(url, { token, method = 'GET', body, timeoutMs = 20000 } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Aurral-DMM-POC/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(url, {
    method, headers, body: body ? new URLSearchParams(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!response.ok) throw new Error(`HTTP ${response.status} at ${new URL(url).pathname}: ${data.error || 'request failed'}`);
  return data;
}

export async function searchDmmAlbums(query, limit = 20) {
  if (!String(query || '').trim()) throw new Error('A search query is required');
  const url = new URL(DMM);
  url.searchParams.set('search', String(query).trim());
  url.searchParams.set('summary', '1');
  url.searchParams.set('limit', String(Math.min(Math.max(1, limit), 96)));
  return requestJson(url);
}

export async function getDmmAlbum(hash) {
  if (!/^[0-9a-f]{40}$/i.test(hash || '')) throw new Error('Invalid torrent hash');
  const url = new URL(DMM);
  url.searchParams.set('hash', hash);
  const data = await requestJson(url);
  const album = data.albums?.find(a => a.hash.toLowerCase() === hash.toLowerCase());
  if (!album) throw new Error('Album not found in DMM');
  return album;
}

export function findDmmTrack(album, fileId) {
  return (album.tracks || []).find(track => Number(track.fileId) === Number(fileId)) || null;
}

// Explicitly creates a temporary torrent under the supplied RD account.
// Always attempts cleanup; caller receives metadata only, never a printed URL.
export async function probeRealDebridTrack({ token, hash, fileId, maxWaitMs = 90000 }) {
  if (!token) throw new Error('Real-Debrid token missing');
  const album = await getDmmAlbum(hash);
  const target = findDmmTrack(album, fileId);
  if (!target) throw new Error('Requested file was not found in DMM album');
  let torrentId;
  try {
    const created = await requestJson(`${RD}/torrents/addMagnet`, {
      token, method: 'POST', body: { magnet: `magnet:?xt=urn:btih:${hash}` },
    });
    torrentId = created.id;
    if (!torrentId) throw new Error('RD did not return a torrent ID');
    let info;
    const deadline = Date.now() + maxWaitMs;
    do {
      info = await requestJson(`${RD}/torrents/info/${encodeURIComponent(torrentId)}`, { token });
      if (info.files?.length) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    if (!info.files?.length) throw new Error('RD file enumeration timed out');
    const rdFile = info.files.find(f => Number(f.id) === Number(fileId));
    if (!rdFile) throw new Error('RD torrent does not contain expected file ID');
    await requestJson(`${RD}/torrents/selectFiles/${encodeURIComponent(torrentId)}`, {
      token, method: 'POST', body: { files: String(fileId) },
    }).catch(error => {
      // RD sometimes responds with an empty successful body; HTTP errors still throw.
      throw error;
    });
    do {
      info = await requestJson(`${RD}/torrents/info/${encodeURIComponent(torrentId)}`, { token });
      if (info.status === 'downloaded' && info.links?.length) break;
      if (['error', 'dead', 'virus', 'magnet_error'].includes(info.status)) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    } while (Date.now() < deadline);
    if (info.status !== 'downloaded' || !info.links?.length) {
      return { matched: true, status: info.status, ready: false, filename: target.filename };
    }
    const selected = info.files.filter(f => f.selected);
    const index = selected.findIndex(f => Number(f.id) === Number(fileId));
    if (index < 0 || !info.links[index]) throw new Error('RD did not provide a link for requested track');
    const un = await requestJson(`${RD}/unrestrict/link`, {
      token, method: 'POST', body: { link: info.links[index] },
    });
    return { matched: true, status: info.status, ready: Boolean(un.download), filename: un.filename,
      bytes: un.filesize, expectedBytes: target.bytes };
  } finally {
    if (torrentId) {
      try {
        const response = await fetch(`${RD}/torrents/delete/${encodeURIComponent(torrentId)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) console.error(`RD_TEMP_TORRENT_CLEANUP=FAIL HTTP_${response.status}`);
        else console.log('RD_TEMP_TORRENT_CLEANUP=PASS');
      } catch (error) {
        console.error(`RD_TEMP_TORRENT_CLEANUP=FAIL ${error.message}`);
      }
    }
  }
}
