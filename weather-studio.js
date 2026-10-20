'use strict';
window.WeatherStudio = (() => {
  const byId=id=>document.getElementById(id);
  const safe=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeAttr=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const activeClosings=s=>(s?.closings||[]).filter(c=>c.name&&c.status&&c.until&&Number.isFinite(Date.parse(c.until))&&Date.parse(c.until)>Date.now());
  const closingTicker=s=>s?.closingsOn?activeClosings(s).map(c=>`${c.name}: ${c.status}${c.note?' — '+c.note:''} (operator-entered)`):[];
  function render(root,s,wx,cam,esc,icon){
    root.classList.toggle('studio-has-forecast',!!s?.forecast);
    root.classList.toggle('studio-has-closings',!!(s?.closingsOn&&activeClosings(s).length));
    if(!s)return;
    const frame=document.createElement('div');frame.className='studio-graphics studio-'+(['newsroom','clean','emergency'].includes(s.style)?s.style:'newsroom');
    frame.style.setProperty('--safe',Math.max(0,Math.min(10,Number(s.safeArea)||0))+'%');
    const current=wx?.forecast?.slice(0,Math.max(3,Math.min(7,Number(s.forecastDays)||5)))||[];
    const bulletin=s.bulletin&&s.bulletinUntil&&Date.parse(s.bulletinUntil)>Date.now()?`<div class="studio-bulletin"><b>STATION BULLETIN</b><span>${esc(s.bulletin)}</span></div>`:'';
    const closings=s.closingsOn?activeClosings(s):[];
    const selected=closings.length?closings[Math.floor(Date.now()/8000)%closings.length]:null;
    const brand=s.station?`<div class="studio-brand"><strong>${esc(s.station)}</strong><span>${esc(s.tagline)}</span></div>`:'';
    frame.innerHTML=`${brand}${bulletin}${s.forecast?`<section class="studio-forecast"><header><b>${esc(cam?.name||'Local forecast')}</b><span>${wx?current.length+'-DAY OUTLOOK':'Weather unavailable'}</span></header>${current.length?`<div class="studio-days">${current.map(d=>`<div><b>${esc(new Date(d.date+'T12:00:00').toLocaleDateString([],{weekday:'short'}))}</b><span class="day-icon">${icon(d.code,true)}</span><strong>${d.high==null?'—':Math.round(d.high)+'°'} <small>${d.low==null?'—':Math.round(d.low)+'°'}</small></strong><span>${d.rain==null?'—':Math.round(d.rain)+'% rain'}</span></div>`).join('')}</div>`:''}<footer>Weather data: Open-Meteo.com · ${wx?.updated?'Updated '+esc(new Date(wx.updated).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})):'Check connection'} · °F</footer></section>`:''}${selected?`<section class="studio-closing"><b>SCHOOL & COMMUNITY NOTICES <small>OPERATOR-ENTERED · ${closings.length} active</small></b><strong>${esc(selected.name)}</strong><span>${esc(selected.status)}${selected.note?' · '+esc(selected.note):''}</span><small>Until ${esc(new Date(selected.until).toLocaleString())} · Confirm with the organization</small></section>`:''}`;
    root.appendChild(frame);
  }
  function init(api){
    const state=()=>api.getState(),cfg=()=>state().cfg.studio;
    const dialog=document.createElement('dialog');dialog.className='studio-discover';dialog.setAttribute('aria-labelledby','discoverTitle');
    dialog.innerHTML=`<div class="studio-dialog-head"><div><span>CAMERA DISCOVERY</span><h2 id="discoverTitle">Find a view. Build your lineup.</h2></div><button id="closeDiscovery" aria-label="Close camera discovery">×</button></div><p>Search the station’s curated collection. Names, coordinates and player links are included. Third-party availability and rebroadcast permission must be checked with the owner.</p><div class="studio-search"><input id="catalogQuery" type="search" placeholder="Search cameras by city, state, or road" aria-label="Search camera catalog"><button id="customFromDiscover">Add custom feed</button></div><div id="catalogResults" class="studio-catalog"></div><section class="studio-511"><h3>511 traffic cameras</h3><p class="hint">FL511 publishes a public camera list with a snapshot image for each camera. WV511 blocks embedding and its disclaimer limits reuse, so it is link-only. Check each agency’s terms before broadcasting.</p><label>Agency<select id="roadSource"><option value="fl">FL511 (Florida)</option><option value="wv">WV511 (West Virginia)</option></select></label><div id="fl511Panel"><form id="fl511Form" class="studio-search"><input id="fl511Query" maxlength="60" placeholder="Highway, county or place (e.g. I-95, Miami)" aria-label="Search FL511 cameras"><button>Fetch cameras</button></form><div id="fl511Status" role="status"></div><div id="fl511Results" class="studio-catalog"></div></div><div id="wv511Panel" hidden><form id="wv511Form" class="studio-search"><input id="wv511Link" type="url" placeholder="Paste a wv511.org camera link" aria-label="WV511 camera link"><button>Check link</button></form><div id="wv511Status" role="status"></div><a id="wv511Open" target="_blank" rel="noopener" hidden>Open camera page ↗</a></div></section><section class="studio-location"><h3>Find a location or pick it on the map</h3><form id="locationSearch"><input id="locationQuery" placeholder="City or postal code (at least 3 characters)" aria-label="Search places" minlength="3" required><button>Find location</button></form><div id="locationStatus" role="status"></div><div id="placeResults"></div><div id="discoveryMap" aria-label="Click the map to select camera coordinates"></div><div class="row"><span id="pickedLocation">Select a place or click the map.</span><button id="usePicked" disabled>Use this location for custom camera</button></div></section>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('close',()=>searchController?.abort());
    let map=null,pin=null,picked=null,editingLocation=false,searchController=null;
    const paintCatalog=()=>{
      const q=byId('catalogQuery').value.toLowerCase();
      const items=api.catalog.map((c,i)=>({c,i})).filter(({c})=>c.name.toLowerCase().includes(q));
      byId('catalogResults').innerHTML=items.length?items.map(({c,i})=>{
        const exists=state().cameras.some(x=>x.url===c.url);
        return `<article><span class="catalog-kind">${safe(c.type.toUpperCase())} · CURATED SOURCE</span><h3>${safe(c.name)}</h3><p>${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}</p><div><button data-locate="${i}">Show location</button><button data-add="${i}" ${exists?'disabled':''}>${exists?'In library':'Add to library'}</button><a href="${safe(c.url)}" target="_blank" rel="noopener">Check player ↗</a></div></article>`;
      }).join(''):'<p>No cameras found in this collection. Use location search and a custom feed below.</p>';
    };
    function pick(lat,lon,label='Selected location'){
      picked={lat,lon,label};byId('pickedLocation').textContent=`${label} · ${lat.toFixed(5)}, ${lon.toFixed(5)}`;byId('usePicked').disabled=false;
      if(map){map.setView([lat,lon],9);if(pin)pin.setLatLng([lat,lon]);else pin=L.marker([lat,lon]).addTo(map);}
    }
    const open=(edit=false)=>{
      editingLocation=edit;dialog.showModal();paintCatalog();
      if(window.L&&!map){map=L.map('discoveryMap').setView([38,-81],5);L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© OpenStreetMap contributors'}).addTo(map);map.on('click',e=>pick(e.latlng.lat,e.latlng.lng));}
      if(!window.L)byId('discoveryMap').textContent='Map library unavailable. Location search still works.';
      setTimeout(()=>map?.invalidateSize(),100);
    };
    byId('discoverCameras').onclick=()=>open();byId('closeDiscovery').onclick=()=>dialog.close();byId('catalogQuery').oninput=paintCatalog;
    byId('customFromDiscover').onclick=()=>{dialog.close();api.edit(null);};
    /* ---- 511 traffic cameras ---- */
    const FL511_QUERY='https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/FL511_Traffic_Cameras/FeatureServer/0/query';
    let fl511Results=[];
    const camName=c=>{const road=[c.HIGHWAY,c.DIRECTION].filter(Boolean).join(' ');const label=[road,c.DESCRIPT].filter(Boolean).join(' · ');return (label||'FL511 camera '+c.ID).slice(0,120);};
    byId('roadSource').onchange=()=>{const fl=byId('roadSource').value==='fl';byId('fl511Panel').hidden=!fl;byId('wv511Panel').hidden=fl;};
    function paintFl511(){
      byId('fl511Results').innerHTML=fl511Results.map((c,i)=>{
        const exists=state().cameras.some(x=>x.url===c.IMAGE);
        return `<article><span class="catalog-kind">IMAGE SNAPSHOT · FL511</span><h3>${safe(camName(c))}</h3><p>${c.COUNTY?safe(c.COUNTY)+' County · ':''}${(+c.LATITUDE).toFixed(4)}, ${(+c.LONGITUDE).toFixed(4)}</p><div><button data-fl="${i}" ${exists?'disabled':''}>${exists?'In library':'Add to library'}</button><a href="https://fl511.com/cctv" target="_blank" rel="noopener">FL511 cameras ↗</a></div></article>`;
      }).join('');
    }
    byId('fl511Form').onsubmit=async e=>{
      e.preventDefault();
      const q=byId('fl511Query').value.toUpperCase().replace(/[^A-Z0-9 .\-]/g,'').trim();
      if(q.length<2){byId('fl511Status').textContent='Enter at least 2 characters: a highway, county or place.';return;}
      byId('fl511Status').textContent='Fetching FL511 cameras…';byId('fl511Results').replaceChildren();
      const params=new URLSearchParams({where:`UPPER(HIGHWAY) LIKE '%${q}%' OR UPPER(COUNTY) LIKE '%${q}%' OR UPPER(DESCRIPT) LIKE '%${q}%'`,outFields:'ID,DESCRIPT,COUNTY,HIGHWAY,DIRECTION,LATITUDE,LONGITUDE,IMAGE',returnGeometry:'false',resultRecordCount:'40',f:'json'});
      try{
        const r=await fetch(FL511_QUERY+'?'+params);if(!r.ok)throw new Error('FL511 unavailable');
        const data=await r.json();if(data.error)throw new Error(data.error.message||'FL511 query failed');
        fl511Results=(data.features||[]).map(f=>f.attributes).filter(a=>a.IMAGE&&Number.isFinite(+a.LATITUDE)&&Number.isFinite(+a.LONGITUDE));
        byId('fl511Status').textContent=fl511Results.length?`${fl511Results.length} camera${fl511Results.length===1?'':'s'} found. Snapshots refresh about once a minute.`:'No FL511 cameras matched. Try a county or highway number.';
        paintFl511();
      }catch(err){byId('fl511Status').textContent='Could not reach FL511 right now. Try again later.';}
    };
    byId('fl511Results').onclick=e=>{
      const b=e.target.closest('[data-fl]');if(!b)return;const c=fl511Results[+b.dataset.fl];
      if(!c||state().cameras.some(x=>x.url===c.IMAGE))return;
      state().cameras.push({id:'c'+crypto.randomUUID(),name:camName(c),lat:+c.LATITUDE,lon:+c.LONGITUDE,url:c.IMAGE,type:'image',refresh:60,active:true,groupId:null});
      api.save();api.refresh();paintFl511();
    };
    byId('wv511Form').onsubmit=e=>{
      e.preventDefault();
      let u;try{u=new URL(byId('wv511Link').value.trim());}catch(err){byId('wv511Status').textContent='Paste a full wv511.org link, starting with https://.';return;}
      if(u.protocol!=='https:'||!/(^|\.)wv511\.org$/i.test(u.hostname)){byId('wv511Status').textContent='That is not an https wv511.org link.';return;}
      const cam=u.searchParams.get('CAM'),route=u.searchParams.get('ROUTE');
      byId('wv511Status').textContent=`${cam?'Camera '+cam:'Camera page'}${route?' · Route '+route:''}. Open the page to view it. The app does not import WV511 video or images.`;
      const open=byId('wv511Open');open.href=u.href;open.hidden=false;
    };
    byId('catalogResults').onclick=e=>{
      const add=e.target.closest('[data-add]'),loc=e.target.closest('[data-locate]');
      if(loc){const c=api.catalog[+loc.dataset.locate];pick(c.lat,c.lon,c.name);}
      if(add){const c=api.catalog[+add.dataset.add];if(state().cameras.some(x=>x.url===c.url))return;state().cameras.push({...c,id:'c'+crypto.randomUUID(),active:true,groupId:null});api.save();api.refresh();paintCatalog();}
    };
    byId('locationSearch').onsubmit=async e=>{
      e.preventDefault();const q=byId('locationQuery').value.trim();if(q.length<3)return;
      searchController?.abort();searchController=new AbortController();const controller=searchController;
      byId('locationStatus').textContent='Searching Open-Meteo places…';byId('placeResults').replaceChildren();
      try{
        const r=await fetch('https://geocoding-api.open-meteo.com/v1/search?name='+encodeURIComponent(q)+'&count=8&language=en&format=json',{signal:controller.signal});if(!r.ok)throw new Error('Search unavailable');const data=await r.json();
        if(controller!==searchController)return;
        byId('locationStatus').textContent=data.results?.length?'Choose a result.':'No places found. Try a nearby city or select the map.';
        (data.results||[]).forEach(p=>{const b=document.createElement('button');const label=[p.name,p.admin1,p.country].filter(Boolean).join(', ');b.textContent=label;b.onclick=()=>pick(p.latitude,p.longitude,label);byId('placeResults').appendChild(b);});
      }catch(err){if(err.name!=='AbortError')byId('locationStatus').textContent='Location search unavailable. Try again or click the map.';}
    };
    byId('usePicked').onclick=()=>{
      if(!picked)return;dialog.close();if(!editingLocation)api.edit(null);
      byId('editCamLat').value=picked.lat.toFixed(5);byId('editCamLon').value=picked.lon.toFixed(5);if(!byId('editCamName').value)byId('editCamName').value=picked.label;
      byId('editCamLat').dispatchEvent(new Event('input',{bubbles:true}));
    };
    const locationButton=document.createElement('button');locationButton.type='button';locationButton.textContent='Find location / choose on map';locationButton.className='full';locationButton.onclick=()=>open(true);byId('editCamLon').parentElement.after(locationButton);
    const panel=document.createElement('div');panel.className='panel settings-only';panel.dataset.settingsSection='information';panel.hidden=true;
    panel.innerHTML=`<h2>Broadcast information</h2><p class="hint">Brand your output, add forecasts and publish time-limited notices. Changes save locally and sync to output tabs on this browser.</p><div class="studio-settings-grid"><section><h3>Station identity & graphics</h3><label>Station name<input id="studioStation" maxlength="50"></label><label>Network / tagline<input id="studioTagline" maxlength="80"></label><label>Graphic package<select id="studioStyle"><option value="newsroom">Newsroom blue</option><option value="clean">Clean white</option><option value="emergency">Severe weather red</option></select></label><label>TV safe margin (%)<input id="studioSafe" type="number" min="0" max="10"></label><label><input id="studioForecast" type="checkbox"> Show forecast panel</label><label>Forecast days<select id="studioDays"><option>3</option><option>5</option><option>7</option></select></label><p class="hint">Forecast layout hides the radar and up-next cards to avoid overlap. Disable the forecast to restore the camera-first layout. With notices and forecast together, the bottom weather card is hidden.</p><label><input id="studioHover" type="checkbox"> Pause rotation on hover (never in TV / fullscreen)</label></section><section><h3>Station bulletin</h3><label>Message<textarea id="studioBulletin" maxlength="300" rows="3"></textarea></label><label>Expires at (required to display)<input id="studioBulletinUntil" type="datetime-local"></label><p class="hint">Bulletins are your station’s information, not official weather alerts.</p><h3>School & community notices</h3><label><input id="studioClosingsOn" type="checkbox"> Show active notices and include in ticker</label><p class="hint">Manual notices only — no live district feed. Every notice requires an expiry. Confirm details with the organization before broadcasting.</p><form id="closingForm"><label>School / organization<input id="closingName" maxlength="100" required></label><label>Status<select id="closingStatus"><option>Closed</option><option>2-hour delay</option><option>Early dismissal</option><option>Remote learning</option><option>Event canceled</option><option>Open / normal schedule</option></select></label><label>Details<input id="closingNote" maxlength="180"></label><label>Expires at<input id="closingUntil" type="datetime-local" required></label><button class="primary">Add notice</button></form><div id="closingList"></div></section></div><p class="hint">Forecast: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (°F, mph). Free API is non-commercial; commercial broadcast requires an appropriate licence. Maps: OpenStreetMap / Esri; radar: RainViewer. Feed owners control playback, embedding and rebroadcast rights.</p>`;
    byId('controlRight').appendChild(panel);
    const update=()=>{api.save();api.rerender();};
    const dateLocal=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'':new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
    const fields=[['studioStation','station'],['studioTagline','tagline'],['studioStyle','style'],['studioSafe','safeArea','number'],['studioForecast','forecast','check'],['studioDays','forecastDays','number'],['studioHover','hoverPause','check'],['studioBulletin','bulletin'],['studioBulletinUntil','bulletinUntil','date'],['studioClosingsOn','closingsOn','check']];
    function paint(){
      fields.forEach(([id,key,type])=>{const el=byId(id);if(document.activeElement===el)return;if(type==='check')el.checked=!!cfg()[key];else el.value=type==='date'?dateLocal(cfg()[key]):cfg()[key];});
      byId('closingList').innerHTML=(cfg().closings||[]).map((c,i)=>`<article><strong>${safe(c.name)}</strong> · ${safe(c.status)}<p>${safe(c.note)} · ${Date.parse(c.until)>Date.now()?'Expires':'Expired'} ${safe(new Date(c.until).toLocaleString())}</p><button data-remove-closing="${i}">Remove</button></article>`).join('')||'<p class="hint">No notices entered. Nothing will be implied about school status.</p>';
    }
    fields.forEach(([id,key,type])=>byId(id).onchange=()=>{const el=byId(id);cfg()[key]=type==='check'?el.checked:type==='number'?Math.max(key==='safeArea'?0:3,Math.min(key==='safeArea'?10:7,+el.value||0)):type==='date'?(el.value?new Date(el.value).toISOString():''):el.value;update();});
    byId('closingForm').onsubmit=e=>{e.preventDefault();const until=new Date(byId('closingUntil').value);if(!Number.isFinite(until.getTime())||until<=new Date()){byId('closingUntil').setCustomValidity('Choose a future expiry.');byId('closingUntil').reportValidity();return;}if(cfg().closings.length>=100){alert('Remove old notices first (maximum 100).');return;}cfg().closings.push({name:byId('closingName').value.trim(),status:byId('closingStatus').value,note:byId('closingNote').value.trim(),until:until.toISOString()});update();paint();e.target.reset();};
    byId('closingUntil').oninput=()=>byId('closingUntil').setCustomValidity('');
    byId('closingList').onclick=e=>{const b=e.target.closest('[data-remove-closing]');if(b){cfg().closings.splice(+b.dataset.removeClosing,1);update();paint();}};
    window.addEventListener('storage',()=>paint());paint();
    const jump=document.createElement('button');jump.className='sm';jump.textContent='Broadcast information';jump.onclick=api.settings;byId('quickWidgetSettings').after(jump);
  }
  return {init,render,closingTicker};
})();
