# Laufbursche MVAGUSTA unlock

A static web page that talks to MV Agusta vehicles over Web Bluetooth, using the protocols of the official **MV Ride** app. The app covers three independent profiles - **motorcycle**, **e-bike** and **kickscooter** - and this page detects which one your vehicle speaks when it connects, then reads the live values and offers the writes that profile actually has. Nothing to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in **Chrome** or **Edge** on Android or desktop.

> **This is a feasibility study - reading works; the write effects are unconfirmed, and there is no speed-unlock here because MV Ride has none.** The protocols were reconstructed from the official app (`com.mvagusta.mvride`) and are documented byte for byte. The honest verdict per profile: the **e-bike** is telemetry only - the app implements no e-bike write command, so this page only reads it. The **kickscooter** has a real immobilizer (`+LOCK`) plus assist/cruise/light AT commands, which this page sends. The **motorcycle** has no speed register either; its "tuning" is custom ride-mode parameters (ABS, quick-shift and more) that the dashboard only accepts while it is in CUSTOM mode, and its handshake uses Android classic bonding plus a plaintext HELLO carrying the phone MAC - which Web Bluetooth cannot replicate, so the motorcycle path is the least certain. **There is no speed-derestrict or region command anywhere in the app, for any profile** - so this page has no speed field; that would be inventing a command that does not exist. Whether the firmware honors any `+LOCK`/`+MODE` or GUI1 write sits in the vehicle and cannot be proven from the app: it must be tested on the device. Error-free operation is not promised and there is no warranty. Whatever you do with it, you do at your own risk - read the [Legal](#legal) section before you connect a vehicle.

**Open the web app: [laufbursche42.github.io/mvagusta-unlock](https://laufbursche42.github.io/mvagusta-unlock/)**

Or run it yourself, no build step and no dependencies: clone the repo and serve the folder over a local HTTP server. Opening `index.html` directly as a `file://` URL will not work, the page fetches its own documents and browsers block that over `file://`.

```
git clone https://github.com/Laufbursche42/mvagusta-unlock.git
cd mvagusta-unlock
python -m http.server 8000
```

Any static server works. With Node installed, this does the same job:

```
npx serve .
```

Then open the printed address in a browser that supports Web Bluetooth.

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers everything step by step, from connecting to the first send.

## What it does

- **Live values** - profile-dependent. E-bike: battery, speed, assist mode, trip/total distance, range, light and fault code. Kickscooter: assist mode, cruise, lock, light. Tiles reveal only once the vehicle reports them.
- **Lock** - the kickscooter immobilizer, via `+LOCK` (the only lock primitive in the whole app).
- **Settings** - kickscooter assist (`+MODE`), cruise (`+CRZE`) and light (`+HLGT`); motorcycle ABS and quick-shift as CUSTOM ride-mode parameters (risky, confirm-gated).
- **Speed** - deliberately no field: an honest state card explaining that MV Ride has no derestrict/region/speed-limit command in any profile.
- **Expert** - send a raw hex frame verbatim, or an ASCII command line (covers both the kickscooter AT syntax and a motorcycle text segment).
- **Shortcut** - a home-screen link that locks or unlocks the kickscooter in a single tap.

## Protocol (proven)

- **Motorcycle (BIKE):** service `0x3719`, write `0x2345`, notify `0x1234`. Text frame `CR + seg0 + RS(0x1E) + seg1 + ... + CR`, no checksum. Binary dashboard commands ride inside a `GUI1` text frame as `GUI1 + hex([header][param][value])`. Registers: CUSTOM_MAP `0x86`, QUICK_SHIFT `0x87`, ABS `0x8A`, TRACTION `0x8B`, ENGINE_BRAKE `0x8C`, SUSPENSION_TV `0x9B`. Writable only in CUSTOM ride mode.
- **E-bike (EBIKE):** service `0xFFE0`, notify `0xFFD1` (write `0xFFE2` declared but no command implemented). ASCII-header binary telemetry: `$b$Z#` battery, `$m$Z#` motor (assist + speed), `$j$Z#` EBM (odometer, autonomy, light, error). Read-only.
- **Kickscooter:** service `1760F740-...`, write `1760F741-...`, notify `1760F744-...`. ASCII AT text `<CMD>=<value>` / `<CMD>=?`: `+MODE` assist 0-3, `+CRZE` cruise, `+LOCK` lock, `+HLGT` light. Response state read from byte 6.
- No app-level crypto or PIN on any profile.

## Honesty

Device-untested by design - you test on your own vehicle, which is exactly the point of a public tool. An echo in the log means the vehicle **accepted** the frame; only the reported state changing in the live values proves it actually took effect. Known gaps, left gated rather than faked: the motorcycle inbound telemetry byte layout is not traced field by field (its frames are shown raw, not decoded into tiles), the `GUI1` hex case the firmware expects is unverified, the motorcycle classic-bond + HELLO handshake is not reproducible in a browser, and the real e-bike/kickscooter scan-name prefixes are backend-driven and not in the app.

## Legal

License: PolyForm Noncommercial, see [License](LICENSE.md). Privacy: nothing leaves your device, see [Privacy](PRIVACY.md). Trademarks: MV Agusta and MV Ride are trademarks of their respective owner, this project is independent, see [Trademarks](TRADEMARKS.md).

Source: https://github.com/Laufbursche42/mvagusta-unlock
