# PedalSync

> **Free your Echelon from the subscription.**

**Live at [pedalsync.app](https://www.pedalsync.app)** — no app install, no account, no subscription.

PedalSync is a browser dashboard that connects directly to Echelon bikes, rowers, and treadmills over Bluetooth and gives you real-time workout telemetry. Open the site, tap Connect, ride.

## Features

- **Live telemetry** — cadence, estimated power, resistance, distance, and calories on bikes; strokes-per-minute, split, and stroke count on rowers; speed, incline, and pace on treadmills
- **Works with locked firmware** — newer Echelon firmware locks telemetry behind a handshake; PedalSync detects it and unlocks automatically
- **AI Coach** — adaptive guided spin and row workouts with per-segment resistance and cadence targets, powered by Claude
- **Strava & Garmin export** — one-tap TCX export of any recorded workout
- **Installable PWA** — add to home screen, offline-capable shell, screen wake-lock, automatic reconnect if the Bluetooth link drops
- **Free** — the dashboard requires no account and no subscription

## Supported equipment

| Type | Models |
|------|--------|
| Bikes | EX-3, EX-4, EX-5, EX-5S, EX-7S, GT+, Connect, Connect Sport |
| Rowers | Row-7S, Row-4S, Row Sport, Row-S |
| Treadmills | Stride series *(experimental)* |

Unrecognized Echelon devices fall back to a generic bike profile, so newer models generally work too.

## Requirements

PedalSync uses Web Bluetooth, so it needs **Chrome or Edge on Android, Windows, macOS, or ChromeOS**. iPhone/iPad and Firefox do not support Web Bluetooth.

## How it's built

- Vanilla JavaScript, no frameworks, no build step — a static PWA talking GATT directly from the browser
- A small serverless API (Vercel) handles the firmware unlock handshake and the AI coaching
- Built-in session diagnostics classify any connection failure (equipment-side vs. cloud-side vs. app-side) so problems get fixed fast

## Status & license

This repository is **source-available for transparency and showcase — it is not open source.** All rights are reserved, including all commercial rights; see [LICENSE](LICENSE). Self-hosting, redistribution, and derivative works are not permitted, and the repository does not accept contributions.

PedalSync is an independent project and is not affiliated with, endorsed by, or supported by Echelon Fitness.
