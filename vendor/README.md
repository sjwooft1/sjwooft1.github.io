# Vendored libraries

These are checked in so the check-in flow works at a venue with no internet:
the organizer console prints labels with QR codes and reads them back off the
camera, both of which must keep working offline.

| File | Version | Source | Licence |
| --- | --- | --- | --- |
| `qrcode.min.js` | qrcodejs 1.0.0 | https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js | MIT |
| `jsQR.js` | jsQR 1.4.0 | https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js | Apache-2.0 |

`qrcodejs` draws the code on a label (`window.QRCode`); `jsQR` decodes a camera
frame (`window.jsQR`) for browsers without the native `BarcodeDetector`.

To upgrade, drop the new file in and update the version in this table — the
global names (`QRCode`, `jsQR`) are what `organizer.html` relies on.
