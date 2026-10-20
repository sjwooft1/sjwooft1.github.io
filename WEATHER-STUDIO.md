# Weather broadcast studio

## Camera workflow

1. Open `weather.html` → **Discover cameras**.
2. Search the curated collection and choose **Add to library**. The name, coordinates and feed are included. This does not put a camera on air.
3. Add it to output from the camera library, then arrange it on **On output**.
4. For a custom camera, search a city/postal code or click the map and choose **Use this location for custom camera**. Paste an authorized image, embed or HLS URL into the editor and save.
5. Existing cameras also have **Find location / choose on map** in their editor.

The catalog contains the 15 existing station sources. It is not a global webcam search engine. Arbitrary camera websites cannot be scraped for private streams from a static browser page. Check player availability and obtain any necessary rebroadcast permission. Cross-origin frames cannot reliably report internal playback failure.

## Broadcast studio

- **Overlay studio**: six weather designs, field visibility, alert graphics and widget placement. **Minimalist mode** flattens every overlay to type-first graphics — no card chrome, gradients or blur — and is also toggled with the **M** key on the broadcast wall.
- **Broadcast information**: station name/tagline, blue/white/red graphic packages, safe-area margin, 3/5/7-day forecast, expiring station bulletin and school/community notices.
- **Output & display**: animated precipitation radar, street map or satellite basemap. Satellite is static imagery, not a live cloud product.
- Forecast layout hides radar/up-next to avoid overlap. When notices and forecasts are both shown, the bottom weather card is hidden.
- Notices are operator-entered, rotate every eight seconds and also appear in the ticker. A future expiry is mandatory. Expired notices stop broadcasting; no notices means no implied school status.
- Save and export the station JSON before changing browsers or clearing browser storage. Settings use the existing local storage key and migrate without replacing saved cameras. Local output tabs synchronize; there is no shared server-side camera library.

## TV operation

Open TV from **Screens & remote**. Click **Start TV mode** for fullscreen, or **Continue without fullscreen** for edge-to-edge browser output. Space pauses/resumes; arrow keys select previous/next; F requests fullscreen; O toggles overlays; M toggles minimalist graphics.

Widget boxes, text and the ticker scale with the output frame's width and height (1280×720 reference) and are capped in viewport units (vw/vh), so the preview and the full TV wall show the same proportions. The ticker grows with the frame and its crawl speed stays even as the text length changes; the scroll-time setting is the minimum duration.

Whole-wall fullscreen no longer blocks rotation. Individual-camera fullscreen intentionally holds that tile. Hover pause is opt-in and disabled in TV and fullscreen. Rotation only applies to single-camera layout; multi-view remains a fixed grid. Wake lock and fullscreen are browser/device-dependent, not guaranteed system-level controls. If the embedded preview refuses fullscreen, open the page in a normal browser.

## Data and service constraints

- Weather/geocoding: [Open-Meteo documentation](https://open-meteo.com/en/docs) and [geocoding](https://open-meteo.com/en/docs/geocoding-api). °F/mph; forecasts are model data rather than a local observation station.
- Open-Meteo's free endpoint is non-commercial. Commercial broadcasting requires appropriate licensing/setup; see [terms](https://open-meteo.com/en/terms). No private commercial API key is embedded in this static page.
- Alerts: NWS, US locations only. The existing alert request failures currently result in an empty alert list; do not interpret that as proof of no hazards.
- Maps: OpenStreetMap / Esri; radar: RainViewer. Network availability, tile policies and feed-owner restrictions apply.
- The existing public MQTT remote is not an authenticated private control service. Do not broadcast sensitive information or treat the pairing code as strong security.

## Verification

Six automated Bun regression tests cover notice expiry, whole-wall fullscreen rotation logic, individual-tile hold, pause, shuffle eligibility/up-next consistency and saved-camera migration. Run `bun test tests/weather-station.test.js`.

Browser checks covered catalog import/duplicate prevention, real place search, coordinate autofill into the editor, settings persistence, notice entry, real five-day forecast, edge-to-edge TV sizing, rotation and pause/resume. Viewport-scaled widgets (preview vs 1280×720 reference vs 1920×1080 TV wall), inline measurement flow, scaled ticker, and the minimalist toggle (settings checkbox, M key and persistence) were checked in-browser at each frame size. The browser panel did not enter native fullscreen, so native fullscreen and physical-TV wake-lock behavior remain unverified; fullscreen engine behavior was tested with a simulated fullscreen document. Every third-party camera was not playback-certified. There is no configured project typecheck/build suite.
