#!/usr/bin/env python3
"""Temporary Apple Music web API bridge POC. No disk token persistence."""
import json, os, ssl, threading, time, re, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

HOST=os.environ.get('APPLE_POC_HOST','127.0.0.1')
PORT=int(os.environ.get('APPLE_POC_PORT','3333'))
TTL=3600
state={}  # user ID -> {headers, expires}; memory-only
lock=threading.RLock()
HTML='''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aurral Apple Music POC</title><style>body{font:16px system-ui;background:#121519;color:#f4f6f8;max-width:850px;margin:40px auto;padding:18px}section{border:1px solid #414854;border-radius:12px;padding:20px;margin:16px 0}button{background:#d94462;color:white;border:0;padding:12px 18px;border-radius:7px;cursor:pointer}textarea{width:100%;box-sizing:border-box;min-height:100px;background:#20262d;color:white;padding:10px}#result{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#b2beca}</style></head><body><h1>Apple Music ↔ Aurral (POC)</h1><p>Temporary proof of concept. Apple sign-in stays on your Windows PC. Paste only the two Apple Music request headers below; they stay in CT102 process memory for up to one hour.</p><section><label>Apple Music request headers (JSON, Authorization and Music-User-Token)<textarea id="headers" placeholder='{"Authorization":"Bearer ...","Music-User-Token":"..."}'></textarea></label><p><button id="connect">Test Apple connection & recommendations</button> <button id="disconnect">Disconnect</button></p><small>No credentials written to disk. Disconnect or service restart clears them. Never paste them into chat.</small></section><section><h2>Results</h2><div id="result">Not connected</div></section><section><h2>Explore Apple recommendations</h2><p><button id="groups">Load groups</button></p><div id="groupsResult"></div><h3>Selected group</h3><div id="groupResult"></div><h3>Playlist tracks</h3><div id="tracksResult"></div><p><button id="export" disabled>Download for Aurral JSON import</button></p><small>Download the selected playlist as Aurral-compatible JSON. Import it from Aurral's Library → Playlists → Import playlist → JSON file. The POC does not start downloads.</small></section><script>const r=document.getElementById('result');document.getElementById('connect').onclick=async()=>{r.textContent='Contacting Apple...';try{const h=JSON.parse(document.getElementById('headers').value);document.getElementById('headers').value='';const x=await fetch('/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(h)});const j=await x.json();r.textContent=JSON.stringify(j,null,2)}catch(e){r.textContent='Error: '+e.message}};document.getElementById('disconnect').onclick=async()=>{const x=await fetch('/api/disconnect',{method:'POST'});r.textContent=JSON.stringify(await x.json());document.getElementById('headers').value='';document.getElementById('groupsResult').replaceChildren();document.getElementById('groupResult').replaceChildren();document.getElementById('tracksResult').replaceChildren();selectedPlaylist=null;exportButton.disabled=true};
const groups=document.getElementById('groupsResult'), group=document.getElementById('groupResult'), tracks=document.getElementById('tracksResult');let selectedPlaylist=null, selectedName='';const exportButton=document.getElementById('export');exportButton.onclick=()=>{if(selectedPlaylist)window.location.href='/api/export?id='+encodeURIComponent(selectedPlaylist)+'&name='+encodeURIComponent(selectedName)};
// APPLE_PHASE4_CLEAN_V1: authenticated Aurral import only; legacy POC bridge removed.
// APPLE_PHASE4_OWNER_UI_RESTORED_V1: Aurral handles login and import on its own origin.
const ownerImportButton=document.createElement('button');
ownerImportButton.textContent='Import via Aurral login';
ownerImportButton.disabled=true;
ownerImportButton.style.marginLeft='8px';
exportButton.insertAdjacentElement('afterend',ownerImportButton);
ownerImportButton.onclick=()=>{
  if(!selectedPlaylist)return;
  const qs=new URLSearchParams({id:selectedPlaylist,name:selectedName});
  window.location.assign('http://192.168.1.202:3001/api/playlists/shared-playlists/apple-import?'+qs.toString());
};
const syncOwnerButton=()=>{ownerImportButton.disabled=!selectedPlaylist};
function btn(label,fn){const b=document.createElement('button');b.textContent=label;b.style.margin='5px';b.onclick=fn;return b}
async function getJSON(url){const r=await fetch(url,{cache:'no-store'});const data=await r.json();if(!data.ok)throw Error(data.message||'Request failed');return data}
document.getElementById('groups').onclick=async()=>{groups.textContent='Loading groups...';group.replaceChildren();tracks.replaceChildren();try{const data=await getJSON('/api/groups');groups.replaceChildren();for(const item of data.items){groups.append(btn(item.name+' →',()=>openGroup(item.id)))}}catch(e){groups.textContent=e.message}};
async function openGroup(id){group.textContent='Loading '+id+'...';tracks.replaceChildren();try{const data=await getJSON('/api/group?id='+encodeURIComponent(id));group.replaceChildren();for(const item of data.items){const label=(item.name||item.id)+' ['+item.type+']';if(item.type==='playlists'){group.append(btn(label,()=>openTracks(item.id,item.name)))}else{const p=document.createElement('p');p.textContent=label;group.append(p)}}if(!data.items.length)group.textContent='No items in group'}catch(e){group.textContent=e.message}}
async function openTracks(id,name){selectedPlaylist=null;exportButton.disabled=true;tracks.textContent='Loading playlist...';try{const data=await getJSON('/api/tracks?id='+encodeURIComponent(id));tracks.replaceChildren();const p=document.createElement('p');p.textContent=data.total+' tracks'+(data.hasMore?' (more pages available)':'');tracks.append(p);const ol=document.createElement('ol');for(const t of data.tracks){const li=document.createElement('li');li.textContent=t.artist+' — '+t.title;ol.append(li)}tracks.append(ol);if(data.hasMore){tracks.append(document.createTextNode('Export is disabled until all pages are supported.'));}else{selectedPlaylist=id;selectedName=name||'Apple Music Playlist';exportButton.disabled=false;syncOwnerButton()}}catch(e){tracks.textContent=e.message}}
</script></body></html>'''

def get_recommendations(headers):
    # Apple web API, compatible with the headers captured by applemusic-mcp.
    uri='https://amp-api.music.apple.com/v1/me/recommendations?platform=web&limit=5'
    req=urllib.request.Request(uri,headers={**headers,'Accept':'application/json','Origin':'https://music.apple.com','Referer':'https://music.apple.com/'})
    try:
        with urllib.request.urlopen(req,timeout=25) as res:
            obj=json.load(res)
            raw=obj.get('data',[])
            if not isinstance(raw,list):raw=[]
            items=[]
            for v in raw[:50]:
                attrs=v.get('attributes') or {}
                title=attrs.get('name') or attrs.get('title') or (attrs.get('editorialNotes') or {}).get('short') or v.get('type','item')
                items.append({'name':display_name({'name':title}),'id':str(v.get('id',''))[:120],'type':str(v.get('type',''))[:60]})
            return {'ok':True,'http':res.status,'items':items,'total':len(raw),'message':'Apple responded successfully. This is a POC; playlist import is not implemented.'}
    except urllib.error.HTTPError as e:
        return {'ok':False,'http':e.code,'message':'Apple rejected the request or endpoint. We will inspect the MCP web request format next.'}
    except Exception as e:
        return {'ok':False,'message':'Apple request failed: '+type(e).__name__}


# Recommendation group browsing, and catalog playlist track preview. Read only.
APPLE='https://amp-api.music.apple.com'
VALID_GROUP=re.compile(r'^[A-Za-z0-9_-]{1,100}$')
VALID_PLAYLIST=re.compile(r'^pl\.[A-Za-z0-9_.-]{1,100}$')

def api_json(path,headers):
    request=urllib.request.Request(APPLE+path,headers={**headers,'Accept':'application/json','Origin':'https://music.apple.com','Referer':'https://music.apple.com/'})
    try:
        with urllib.request.urlopen(request,timeout=25) as response:
            return {'ok':True,'http':response.status,'body':json.load(response)}
    except urllib.error.HTTPError as error:
        return {'ok':False,'http':error.code,'message':'Apple returned an HTTP error'}
    except Exception as error:
        return {'ok':False,'message':'Apple connection failed: '+type(error).__name__}

def display_name(attrs):
    value=attrs.get('name') or attrs.get('title') or ''
    if isinstance(value,dict): value=value.get('stringForDisplay') or ''
    return str(value)[:180]

def group_items(headers,group_id):
    if not VALID_GROUP.fullmatch(group_id): return {'ok':False,'message':'Invalid recommendation group ID'}
    result=api_json('/v1/me/recommendations/'+quote(group_id,safe='')+'/contents?platform=web&limit=100',headers)
    if not result['ok']:return result
    raw=result['body'].get('data') or []
    items=[]
    for item in raw:
        if not isinstance(item,dict):continue
        attrs=item.get('attributes') or {}
        items.append({'id':str(item.get('id') or '')[:120],'type':str(item.get('type') or '')[:40],'name':display_name(attrs),'artist':str(attrs.get('artistName') or '')[:150]})
    return {'ok':True,'http':result['http'],'items':items,'total':len(items),'group':group_id}

def playlist_tracks(headers,playlist_id):
    if not VALID_PLAYLIST.fullmatch(playlist_id):
        return {'ok':False,'message':'Invalid catalog playlist ID'}
    base='/v1/catalog/us/playlists/'+quote(playlist_id,safe='')+'/tracks'
    path=base+'?platform=web&limit=100'
    tracks=[]
    visited=set()
    max_pages=30
    max_tracks=3000
    for page_number in range(1,max_pages+1):
        if path in visited:
            return {'ok':False,'message':'Apple pagination repeated a page; import blocked'}
        visited.add(path)
        result=api_json(path,headers)
        if not result['ok']:
            return {'ok':False,'message':'Apple playlist page '+str(page_number)+' failed; import blocked','http':result.get('http',502)}
        obj=result.get('body') or {}
        raw=obj.get('data')
        if not isinstance(raw,list):
            return {'ok':False,'message':'Apple playlist returned an invalid page; import blocked'}
        for item in raw:
            if not isinstance(item,dict):
                return {'ok':False,'message':'Apple playlist returned an invalid track; import blocked'}
            attrs=item.get('attributes') or {}
            tracks.append({'id':str(item.get('id') or '')[:100],'title':display_name(attrs),'artist':str(attrs.get('artistName') or '')[:180],'album':str(attrs.get('albumName') or '')[:180],'durationMs':attrs.get('durationInMillis')})
        if len(tracks)>max_tracks:
            return {'ok':False,'message':'Apple playlist exceeds the 3000-track safety limit; import blocked'}
        next_page=obj.get('next')
        if not next_page:
            return {'ok':True,'http':result['http'],'playlist':playlist_id,'tracks':tracks,'total':len(tracks),'hasMore':False}
        if not isinstance(next_page,str):
            return {'ok':False,'message':'Apple playlist pagination link invalid; import blocked'}
        parsed=urlparse(next_page)
        if parsed.scheme or parsed.netloc:
            if parsed.scheme!='https' or parsed.netloc!='amp-api.music.apple.com':
                return {'ok':False,'message':'Apple pagination changed host; import blocked'}
        if parsed.path!=base or not parsed.query or parsed.fragment:
            return {'ok':False,'message':'Apple pagination path invalid; import blocked'}
        path=parsed.path+'?'+parsed.query
    return {'ok':False,'message':'Apple playlist exceeds the 30-page safety limit; import blocked'}

def library_playlists(headers):
    # Read-only, paginated personal library list. Never expose Apple headers.
    base='/v1/me/library/playlists'
    path=base+'?limit=100'
    entries=[]
    seen=set()
    for page in range(30):
        if path in seen:
            return {'ok':False,'message':'Repeated Apple library page; scan incomplete'}
        seen.add(path)
        result=api_json(path,headers)
        if not result['ok']:
            return {'ok':False,'http':result.get('http'), 'message':'Apple library playlists unavailable', 'items':[]}
        body=result.get('body') or {}
        data=body.get('data')
        if not isinstance(data,list):
            return {'ok':False,'message':'Apple library returned invalid data'}
        for item in data:
            if not isinstance(item,dict):continue
            attrs=item.get('attributes') or {}
            pid=str(item.get('id') or '')[:120]
            catalog_id=str((attrs.get('playParams') or {}).get('catalogId') or '')[:120]
            entries.append({'id':pid,'catalogId':catalog_id,'name':display_name(attrs),'type':str(item.get('type') or '')[:50]})
        if len(entries)>3000:
            return {'ok':False,'message':'Playlist scan safety limit exceeded'}
        next_url=body.get('next')
        if not next_url:
            return {'ok':True,'items':entries,'total':len(entries),'hasMore':False}
        if not isinstance(next_url,str):return {'ok':False,'message':'Invalid next page'}
        parsed=urlparse(next_url)
        if parsed.scheme or parsed.netloc:
            if parsed.scheme!='https' or parsed.netloc!='amp-api.music.apple.com':
                return {'ok':False,'message':'Unexpected next-page host'}
        if parsed.path!=base or not parsed.query or parsed.fragment:
            return {'ok':False,'message':'Unexpected next-page path'}
        path=parsed.path+'?'+parsed.query
    return {'ok':False,'message':'Too many Apple library pages'}

# Library playlists can have p.* identifiers and may contain library-song records.
VALID_LIBRARY_PLAYLIST=re.compile(r'^[A-Za-z0-9._-]{1,120}$')

def library_playlist_tracks(headers,playlist_id):
    if not VALID_LIBRARY_PLAYLIST.fullmatch(playlist_id):
        return {'ok':False,'message':'Invalid library playlist ID'}
    base='/v1/me/library/playlists/'+quote(playlist_id,safe='')+'/tracks'
    path=base+'?limit=100'
    tracks=[]
    visited=set()
    for page in range(30):
        if path in visited:
            return {'ok':False,'message':'Repeated library track page; import blocked'}
        visited.add(path)
        response=api_json(path,headers)
        if not response['ok']:
            return {'ok':False,'http':response.get('http',502),'message':'Apple library tracks unavailable; import blocked'}
        body=response.get('body') or {}
        entries=body.get('data')
        if not isinstance(entries,list):
            return {'ok':False,'message':'Invalid library track page; import blocked'}
        for entry in entries:
            if not isinstance(entry,dict):
                return {'ok':False,'message':'Invalid library track; import blocked'}
            attrs=entry.get('attributes') or {}
            tracks.append({'id':str(entry.get('id') or '')[:100],
                           'title':display_name(attrs),
                           'artist':str(attrs.get('artistName') or '')[:180],
                           'album':str(attrs.get('albumName') or '')[:180],
                           'durationMs':attrs.get('durationInMillis')})
        if len(tracks)>3000:
            return {'ok':False,'message':'Library playlist exceeds 3000 tracks; import blocked'}
        next_page=body.get('next')
        if not next_page:
            return {'ok':True,'tracks':tracks,'total':len(tracks),'hasMore':False,'playlist':playlist_id}
        if not isinstance(next_page,str):
            return {'ok':False,'message':'Invalid library pagination; import blocked'}
        parsed=urlparse(next_page)
        if parsed.scheme or parsed.netloc:
            if parsed.scheme!='https' or parsed.netloc!='amp-api.music.apple.com':
                return {'ok':False,'message':'Unexpected pagination host; import blocked'}
        if parsed.path!=base or not parsed.query or parsed.fragment:
            return {'ok':False,'message':'Unexpected pagination path; import blocked'}
        path=parsed.path+'?'+parsed.query
    return {'ok':False,'message':'Library playlist exceeds 30 pages; import blocked'}

def requesting_user(handler):
    # Bridge accepts only the local Aurral backend. Never trust browser-supplied user IDs.
    if handler.client_address[0] not in ('127.0.0.1', '::1'):
        return None
    value = handler.headers.get('X-Aurral-User-Id', '')
    if not value.isdecimal() or not (1 <= int(value) <= 2147483647):
        return None
    return str(int(value))

def active_headers(user_id):
    with lock:
        entry = state.get(user_id)
        if not entry:
            return None
        if time.time() >= entry['expires']:
            state.pop(user_id, None)
            return None
        return dict(entry['headers'])

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # No URLs, payloads, tokens, or request detail in stdout.
        return
    def reply(self,obj,status=200):
        data=json.dumps(obj,ensure_ascii=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        if urlparse(self.path).path=='/':
            data=HTML.encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        elif urlparse(self.path).path=='/health':self.reply({'ok':True,'service':'apple-music-poc-v3'})
        elif urlparse(self.path).path in ('/api/groups','/api/group','/api/tracks','/api/export','/api/library-playlists','/api/library-tracks'):
            user_id=requesting_user(self)
            if not user_id:return self.reply({'error':'Authorized Aurral user required'},403)
            headers=active_headers(user_id)
            if not headers:return self.reply({'ok':False,'message':'Connect again to browse recommendations'},401)
            uri=urlparse(self.path);args=parse_qs(uri.query)
            if uri.path=='/api/library-playlists':
                result=library_playlists(headers)
            elif uri.path=='/api/library-tracks':
                result=library_playlist_tracks(headers,(args.get('id') or [''])[0])
            elif uri.path=='/api/groups':
                result=get_recommendations(headers)
            elif uri.path=='/api/group':
                result=group_items(headers,(args.get('id') or [''])[0])
            else:
                result=playlist_tracks(headers,(args.get('id') or [''])[0])
            if uri.path=='/api/export':
                if not result.get('ok'):return self.reply(result,400)
                if result.get('hasMore'):return self.reply({'ok':False,'message':'Playlist is paginated; export blocked rather than importing an incomplete list.'},422)
                playlist_name=(args.get('name') or ['Apple Music Playlist'])[0][:120]
                payload={'type':'aurral-static-tracklist','version':1,'name':playlist_name,
                         'sourceName':'Apple Music',
                         'tracks':[{'artistName':t['artist'],'trackName':t['title'],'albumName':t['album']}
                                   for t in result['tracks'] if t['artist'] and t['title']]}
                if not payload['tracks']:return self.reply({'ok':False,'message':'No valid tracks to export'},422)
                data=json.dumps(payload,ensure_ascii=False,indent=2).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type','application/json; charset=utf-8')
                self.send_header('Content-Disposition','attachment; filename=apple-music-aurral.json')
                self.send_header('Cache-Control','no-store')
                self.send_header('X-Content-Type-Options','nosniff')
                self.send_header('Content-Length',str(len(data)))
                self.end_headers();self.wfile.write(data)
                return
            self.reply(result,200 if result.get('ok') else 400)
        else:self.reply({'error':'not found'},404)
    def do_POST(self):
        user_id=requesting_user(self)
        if not user_id:return self.reply({'error':'Authorized Aurral user required'},403)
        if self.path=='/api/disconnect':
            with lock:state.pop(user_id, None)
            return self.reply({'ok':True,'message':'Your temporary Apple Music session was cleared.'})
        if self.path!='/api/connect':return self.reply({'error':'not found'},404)
        if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.reply({'error':'JSON expected'},400)
        try:
            n=int(self.headers.get('Content-Length','0'))
            if n<2 or n>8192:return self.reply({'error':'invalid request size'},400)
            payload=json.loads(self.rfile.read(n))
            auth=payload.get('Authorization','');user=payload.get('Music-User-Token','')
            if not isinstance(auth,str) or not auth.startswith('Bearer ') or not isinstance(user,str) or len(user)<10:
                return self.reply({'error':'Expected Authorization and Music-User-Token from applemusic-mcp get_headers().'},400)
            headers={'Authorization':auth,'Music-User-Token':user}
            with lock:state[user_id]={'headers':headers,'expires':time.time()+TTL}
            outcome=get_recommendations(headers)
            if not outcome.get('ok'):
                with lock:state.pop(user_id, None)
            return self.reply(outcome)
        except (ValueError,KeyError,TypeError):return self.reply({'error':'invalid JSON'},400)

if __name__=='__main__':
    httpd=ThreadingHTTPServer((HOST,PORT),Handler)
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain('/opt/aurral-dev/apple-poc/server.crt','/opt/aurral-dev/apple-poc/server.key')
    httpd.socket=ctx.wrap_socket(httpd.socket,server_side=True)
    print(f'AURRAL_APPLE_POC_HTTPS={HOST}:{PORT}',flush=True)
    httpd.serve_forever()
