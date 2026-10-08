# Guide

> **Important for error reports:** switch on the **Diagnostic log** at the bottom of the page *before* you connect to the scooter. Only then is the full connection handshake captured - and those are exactly the lines we need in a [ticket](https://github.com/Laufbursche42/Laufbursche42/issues) to reproduce a problem.

## What you need
- An MV Agusta vehicle from the MV Ride app: motorcycle, e-bike or kickscooter.
- A phone or computer with **Chrome**, **Edge**, or on iOS **Bluefy**. Safari and Firefox cannot do Web Bluetooth.

## Connecting
1. Turn on Bluetooth and wake the vehicle.
2. Tap **Connect** and pick the vehicle from the list.
3. If it is not listed, tick **Show all devices** and try again. The real check is the Bluetooth service found, not the advertised name.
4. The page probes the three profiles itself (motorcycle, e-bike, kickscooter) and uses the first that answers. Which profile was detected is shown as the **Profile** tile and after the device name.

## Reading live values
The vehicle streams its status continuously. Each tile appears once its value has arrived. Which values arrive depends on the profile: the e-bike gives battery, speed, assist, trip, range, light and fault code; the kickscooter gives assist level, cruise, lock and light. Below the tiles, **All received frames** lets you follow the raw data per tag.

## Speed
None of the three profiles has a derestrict, region or speed-limit command. On the e-bike and kickscooter only the app display limits the speed; the motorcycle has only the parameters of its CUSTOM ride mode. That is why this page deliberately has no speed field.

## Lock (kickscooter only)
Only the kickscooter has a lock. In the **Lock** card, **Lock** sends `+LOCK=1` and **Unlock** sends `+LOCK=0`. Note: a locked scooter can only be unlocked again over Bluetooth. An echo in the log only means the scooter accepted the command; only the reported lock state in the live values proves it took effect.

## Settings
Only rows that match the connected profile are shown. Kickscooter: assist (`+MODE`, levels none/Eco/Normal/Sport), cruise (`+CRZE`) and light (`+HLGT`). Motorcycle: ABS mode (Normal/Race) and quick-shift as CUSTOM ride-mode parameters. The dashboard accepts the motorcycle parameters only while the CUSTOM ride mode is active; they are confirm-gated.

## Advanced settings (engine level)
**Send a raw frame** sends your hex bytes unchanged to the active write characteristic. **Send an ASCII command** sends the entered text as UTF-8, for example a kickscooter command like `+MODE=?` or a motorcycle text segment.

## Shortcuts
Copy the link to your home screen, then one tap locks or unlocks the kickscooter directly. On iOS via Bluefy, and the vehicle must have been connected normally once before.

## If something does not work
- Cannot connect? Check that the browser supports Web Bluetooth, Bluetooth is on and the vehicle is awake. Retry with **Show all devices**.
- The e-bike shows no switches? That is correct: the e-bike profile is telemetry only in the app and sends no write commands.
- Nothing happens after a command? Check the log: if it says "sent" but no "confirmed", the firmware did not acknowledge the frame.
- **Diagnostics: list all devices** in the log area shows every Bluetooth service of a device without writing anything - useful for support.

## Contribute
Want to find out if and how tuning works on your scooter? Test this tool on your own vehicle and open a ticket on [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - with your model and what worked (or did not). That way we figure out together what is possible on which model.
