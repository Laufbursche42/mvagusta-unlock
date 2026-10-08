# Privacy Policy

This web application collects nothing: no analytics, no telemetry, no tracking, no ads, no cookies and no third-party scripts. Nothing goes to the developer or to any server. The whole tool runs on your device.

## What is processed and where it stays

All of the following stays on your device and is never uploaded:

- The live data of the vehicle, read over Bluetooth LE.
- The settings you make (theme, log options). They are stored locally in the browser (localStorage) only.
- The log on screen. It lives only in the open page. The device name and id are anonymized and credentials or tokens are redacted before anything is stored, shown, copied or saved.

## Network connections

- **Loading the page:** your browser fetches the static files from the host (for example GitHub Pages). The host sees your IP address and which file you requested, the usual access logs. Vehicle data or commands never reach any server.
- **Bluetooth LE to the vehicle:** a local radio link, not an internet connection. Commands and the vehicle replies run only between your browser and the vehicle.
- **Nothing else.** The page's Content Security Policy allows `connect-src 'self'` only, so the page cannot talk to any other server even if it wanted to.

## Note on the official app

The official MV Ride app signs in to a cloud backend to resolve your model and settings (for e-bikes and kickscooters the model list and scan prefixes are delivered from the server). This page does **not**. It speaks only to the vehicle over Bluetooth and needs no account.

## Contact

For privacy questions contact the author (Laufbursche) on GitHub: https://github.com/Laufbursche42
