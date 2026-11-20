import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../weather.html', import.meta.url), 'utf8');
const inline = html.split('<script>')[1].split('</script>')[0];

function elStub() {
  const fn = function () { return elStub(); };
  return new Proxy(fn, {
    get(t, k) {
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      if (k === 'dataset') return {};
      if (k === 'style') return { setProperty() {} };
      if (k === Symbol.toPrimitive) return () => '';
      if (typeof k === 'symbol') return undefined;
      if (k === 'children' || k === 'childNodes') return [];
      return elStub();
    },
    set() { return true; },
    apply() { return elStub(); }
  });
}
function runWith(store = {}) {
  const sandbox = {
    console, Math, Date, JSON, URLSearchParams, Blob, URL,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    document: {
      querySelector: () => elStub(),
      querySelectorAll: () => [],
      createElement: () => elStub(),
      addEventListener: () => {},
      hidden: false,
      body: { dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }
    },
    window: { addEventListener: () => {} },
    location: { search: '', pathname: '/' },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    fetch: async () => { throw new Error('no network in tests'); },
    Intl, confirm: () => false, alert: () => {}, innerWidth: 1200, innerHeight: 800
  };
  vm.createContext(sandbox);
  vm.runInContext(inline, sandbox, { filename: 'weather-inline.js' });
  return sandbox.window.WXDesk;
}

test('link types are detected from URLs', () => {
  const W = runWith();
  expect(W.detectType('https://example.com/cam.jpg')).toBe('image');
  expect(W.detectType('https://example.com/cam.JPG?x=1')).toBe('image');
  expect(W.detectType('https://example.com/stream.m3u8?token=1')).toBe('hls');
  expect(W.detectType('https://example.com/clip.mp4')).toBe('mp4');
  expect(W.detectType('https://www.youtube.com/embed/abc')).toBe('iframe');
  expect(W.TYPES).toEqual(['image', 'hls', 'mp4', 'iframe']);
});

test('cameras normalize links, folder and rotation override', () => {
  const W = runWith();
  const cam = W.normalizeCamera({
    name: '  Pass Cam  ',
    url: 'https://example.com/a.jpg',
    lat: '39.6', lon: -105.9, seconds: 2
  });
  expect(cam.name).toBe('Pass Cam');
  expect(cam.folderId).toBe('f_inbox');
  expect(cam.links.length).toBe(1);
  expect(cam.links[0].type).toBe('image');
  expect(cam.lat).toBe(39.6);
  expect(cam.seconds).toBe(null); // below the 3s floor
  const named = W.normalizeCamera({ links: [{ url: 'https://harbor.example.com/x.m3u8' }] });
  expect(named.name).toBe('harbor.example.com');
  expect(named.links[0].type).toBe('hls');
  expect(W.normalizeCamera({ links: [] }).links).toEqual([]);
});

test('state normalization keeps folders, queue and widgets sane', () => {
  const W = runWith();
  const s = W.normalizeState({
    folders: [{ id: 'f_a', name: 'I-70' }],
    cameras: [
      { id: 'c1', name: 'One', url: 'https://e.com/1.jpg', folderId: 'f_a' },
      { id: 'c2', name: 'Two', url: 'https://e.com/2.jpg', folderId: 'gone' }
    ],
    queue: [{ kind: 'cam', id: 'c1' }, { kind: 'folder', id: 'f_a' }, { kind: 'cam', id: 'nope' }],
    settings: { rotateSec: 2, widgets: { radar: false } }
  });
  expect(s.folders.some((f) => f.id === 'f_inbox')).toBe(true);
  expect(s.cameras.find((c) => c.id === 'c2').folderId).toBe('f_inbox');
  expect(s.queue).toEqual([{ kind: 'cam', id: 'c1' }, { kind: 'folder', id: 'f_a' }]);
  expect(s.settings.rotateSec).toBe(3);
  expect(s.settings.widgets).toEqual({ title: true, weather: true, radar: false, next: true });
});

test('sponsor settings normalise, clamp and default', () => {
  const W = runWith();
  const s = W.normalizeState({ settings: { sponsor: { enabled: true, name: '  Acme  ', logo: 'https://e.com/a.png', text: '', seconds: 1, every: 5 } } });
  const sp = s.settings.sponsor;
  expect(sp.enabled).toBe(true);
  expect(sp.name).toBe('Acme');
  expect(sp.text).toBe('Thanks for watching — made possible by');
  expect(sp.seconds).toBe(3);
  expect(sp.every).toBe(15);
  const d = W.defaultState().settings.sponsor;
  expect(d).toEqual({ enabled: false, name: '', logo: '', text: 'Thanks for watching — made possible by', seconds: 8, every: 120 });
  expect(W.normalizeState({}).settings.sponsor).toEqual(d);
});

test('queue expands folders in camera order, without duplicates', () => {
  const W = runWith();
  const cameras = [
    { id: 'a', folderId: 'f1', addedAt: 1 },
    { id: 'b', folderId: 'f2', addedAt: 2 },
    { id: 'c', folderId: 'f1', addedAt: 3 }
  ];
  const folders = [{ id: 'f1', parentId: null }, { id: 'f2', parentId: null }];
  const ids = W.expandQueue([
    { kind: 'folder', id: 'f1' },
    { kind: 'cam', id: 'b' },
    { kind: 'cam', id: 'a' },
    { kind: 'cam', id: 'missing' }
  ], cameras, folders);
  expect(ids).toEqual(['a', 'c', 'b']);
});

test('nested folders queue every camera below them', () => {
  const W = runWith();
  const folders = [
    { id: 'f_root', name: 'Root', parentId: null },
    { id: 'f_kid', name: 'Kid', parentId: 'f_root' },
    { id: 'f_grand', name: 'Grand', parentId: 'f_kid' },
    { id: 'f_other', name: 'Other', parentId: null }
  ];
  const cameras = [
    { id: 'a', folderId: 'f_root', addedAt: 1 },
    { id: 'b', folderId: 'f_kid', addedAt: 2 },
    { id: 'c', folderId: 'f_grand', addedAt: 3 },
    { id: 'd', folderId: 'f_other', addedAt: 4 }
  ];
  expect(W.folderDescendants(folders, 'f_root')).toEqual(['f_kid', 'f_grand']);
  expect(W.expandQueue([{ kind: 'folder', id: 'f_root' }], cameras, folders)).toEqual(['a', 'b', 'c']);
  expect(W.expandQueue([{ kind: 'folder', id: 'f_kid' }, { kind: 'cam', id: 'd' }], cameras, folders)).toEqual(['b', 'c', 'd']);
});

test('folders keep valid parents and cycles are broken', () => {
  const W = runWith();
  const s = W.normalizeState({ folders: [
    { id: 'f1', name: 'One', parentId: 'f2' },
    { id: 'f2', name: 'Two', parentId: 'f1' },
    { id: 'f3', name: 'Three', parentId: 'nope' },
    { id: 'f4', name: 'Four', parentId: 'f3' }
  ] });
  const by = Object.fromEntries(s.folders.map((f) => [f.id, f]));
  expect(by.f3.parentId).toBe(null);
  expect(by.f4.parentId).toBe('f3');
  expect(by.f_inbox.parentId).toBe(null);
  expect(by.f1.parentId === null || by.f2.parentId === null).toBe(true);
});

test('schedules normalise and fire in their minute', () => {
  const W = runWith();
  const sch = W.normalizeSchedule({ name: '  Morning  ', time: '8:05', days: [1, 1, 9, 2], sources: [{ kind: 'folder', id: 'f1' }, { kind: 'nope', id: 'x' }], rotateSec: 2 });
  expect(sch.time).toBe('08:05');
  expect(sch.days).toEqual([1, 2]);
  expect(sch.name).toBe('Morning');
  expect(sch.rotateSec).toBe(null);
  expect(sch.sources).toEqual([{ kind: 'folder', id: 'f1' }]);
  expect(sch.message).toBe('');
  expect(sch.enabled).toBe(true);
  const at = new Date(2026, 4, 12, 8, 5, 20).getTime();
  expect(W.scheduleDue({ ...sch, days: [2] }, at).at).toBe(new Date(2026, 4, 12, 8, 5).getTime());
  expect(W.scheduleDue({ ...sch, days: [2] }, at + 40000)).toBe(null);
  expect(W.scheduleDue({ ...sch, days: [3] }, at)).toBe(null);
  expect(W.scheduleDue({ ...sch, enabled: false }, at)).toBe(null);
});

test('next camera wraps in both directions', () => {
  const W = runWith();
  const list = ['a', 'b', 'c'];
  expect(W.nextCamera(list, 'a', 1)).toBe('b');
  expect(W.nextCamera(list, 'c', 1)).toBe('a');
  expect(W.nextCamera(list, 'a', -1)).toBe('c');
  expect(W.nextCamera(list, null, 1)).toBe('a');
  expect(W.nextCamera([], 'a', 1)).toBe(null);
});

test('countdown and camera timezone helpers', () => {
  const W = runWith();
  expect(W.formatCountdown(0)).toBe('0:00');
  expect(W.formatCountdown(9000)).toBe('0:09');
  expect(W.formatCountdown(65000)).toBe('1:05');
  expect(W.formatCountdown(-500)).toBe('0:00');
  expect(W.estimateZone(-105)).toBe('Etc/GMT+7');
  expect(W.estimateZone(0)).toBe('Etc/GMT');
  expect(W.estimateZone(30)).toBe('Etc/GMT-2');
  expect(W.estimateZone(null)).toBe(null);
});

test('weather is imperial and the radar is the RainViewer embed', () => {
  const W = runWith();
  const w = W.weatherUrl({ lat: 39.68, lon: -105.88 });
  expect(w).toContain('temperature_unit=fahrenheit');
  expect(w).toContain('latitude=39.68');
  expect(w).toContain('longitude=-105.88');
  const r = W.radarUrl({ lat: 39.68, lon: -105.88 });
  expect(r.startsWith('https://www.rainviewer.com/map.html?loc=39.6800,-105.8800,7&')).toBe(true);
  expect(r).toContain('layer=radar');
  expect(r).toContain('c=9');
  expect(r).toContain('o=83');
  expect(W.radarUrl({ lat: 39.68, lon: -105.88 }, 9)).toContain('loc=39.6800,-105.8800,9&');
});

test('weather codes map to conditions and icons', () => {
  const W = runWith();
  expect(W.weatherInfo(0)).toEqual({ label: 'Clear', icon: 'sun' });
  expect(W.weatherInfo(3)).toEqual({ label: 'Cloudy', icon: 'cloud' });
  expect(W.weatherInfo(63)).toEqual({ label: 'Rain', icon: 'rain' });
  expect(W.weatherInfo(75).icon).toBe('snow');
  expect(W.weatherInfo(95).icon).toBe('storm');
  expect(W.weatherInfo(9999).icon).toBe('cloud');
});

test('legacy libraries migrate once, with dedupe', () => {
  const W = runWith();
  const cams = W.migrateLegacy(
    { cameras: [
      { name: 'Old A', url: 'https://example.com/a.jpg', lat: 1, lon: 2 },
      { name: 'Dup', url: 'https://example.com/a.jpg' }
    ] },
    { cameras: [{ name: 'Old B', url: 'https://example.com/s.m3u8' }] }
  );
  expect(cams.map((c) => c.name)).toEqual(['Old A', 'Old B']);
  expect(cams[0].links[0].type).toBe('image');
  expect(cams[1].links[0].type).toBe('hls');
  expect(cams[0].folderId).toBe('f_imported');
  expect(W.migrateLegacy(null, undefined)).toEqual([]);
});

test('desk contract: finder, queue, editor, tv display', () => {
  for (const id of ['queue', 'nowPlaying', 'rotSec', 'widgets', 'fNav', 'fGrid', 'fSearch',
    'camModal', 'pickMap', 'linkRows', 'camFolder', 'camSeconds', 'btnAddLink', 'btnSaveCam',
    'folderModal', 'ctx', 'toast', 'btnTv', 'tv', 'stage', 'titleBar', 'tvClock', 'wxCard',
    'wxTemp', 'wxCond', 'wxRain', 'radarMap', 'nextPill',
    'blPane', 'sponsorAd', 'sponsorLogo', 'sponsorName', 'sponsorMsg',
    'btnSponsor', 'sponsorState', 'sponsorModal', 'spEnabled', 'spName', 'spLogo',
    'spText', 'spSeconds', 'spEvery', 'btnSaveSponsor', 'btnPlaySponsor',
    'viewSeg', 'fMap', 'mapNote', 'folderParent', 'btnSched', 'schedModal',
    'schedCal', 'schedSrc', 'schedName', 'schedTime', 'schedDays', 'schedMsg',
    'schedSponsorOn', 'schedSpName', 'schedSpLogo', 'schedSpText', 'btnSaveSched',
    'btnNewSched', 'btnDelSched', 'eventMsg']) {
    expect(html.includes('id="' + id + '"')).toBe(true);
  }
  expect(html.includes('wxdesk.v2')).toBe(true);
  expect(html.includes('wxdesk.program.v1')).toBe(true);
  expect(html.includes('rainviewer')).toBe(true);
  expect(html.includes('rainviewer.com/map.html')).toBe(true);
  expect(html.includes('weatherwall.v1')).toBe(true);
  expect(html.includes('wcamStationV2')).toBe(true);
});
