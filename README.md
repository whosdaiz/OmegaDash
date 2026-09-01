# OmegaDash

A native-window CS2 aim telemetry dashboard. Live matches come from `OmegaDash.lua` into a local SQLite database.

Works on **Windows** and **Linux**. Launch Omega / process watch is Windows-only; everything else (ingest, history, profile, loot, settings) is the same.

## Requirements

- Python **3.10+**
- pip packages from `requirements.txt` (`pywebview`)
- First-run internet for Chart.js / fonts (CDN in `index.html`)

### Windows

WebView2 is used when the Edge runtime is present (normal on current Windows).

```powershell
cd OmegaDash
python -m pip install -r requirements.txt
python app.py
```

### Linux

pywebview needs GTK 3 + WebKitGTK. Tk is used for the folder picker. On Debian / Ubuntu / Mint:

```bash
sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1 python3-tk
cd OmegaDash
python3 -m pip install -r requirements.txt
python3 app.py
```

Fedora:

```bash
sudo dnf install python3-gobject gtk3 webkit2gtk4.1 python3-tkinter
```

If WebKit 4.1 is not in your repos, try `gir1.2-webkit2-4.0` / `webkit2gtk3` instead.

## Run

Keep the dashboard open while you play. 

Lua POSTs match JSON to `http://127.0.0.1:27182/ingest` and writes `omegadash_current.json` / `_last.json` / `_archive.jsonl` under the Omega solution folder as backup. The dashboard also watches those files, so a match is not lost if HTTP was down.

## API keys

Constelia, CSFloat, Leetify, and Gemini keys live in **Settings → API Keys**. They are stored in `omega-secrets.json` next to the app:

- **Windows** — DPAPI (tied to your Windows user)
- **Linux / macOS** — encrypted for this user on this machine (`uid` + `/etc/machine-id`), file mode `600`

A Windows secrets file will not decrypt on Linux (and the other way around). Paste the keys again on the new OS. Profile and loot use the Constelia key.

## What is stored per match

Scoreboard totals (K/D/A, HS, damage, flashed, rounds, team, CT/T scores, duration, map) plus every kill/death engagement: pre-aim, flick land pitch/yaw, reaction, TTK, first shot, counter-strafe, origins, round, team, weapon, and the rest of the Lua record.

History lives in `omegadash.sqlite`. Every engagement is stored in full (`payload_json`) so later UI changes can use fields that already landed.

Map **win rate** only counts Prem/Comp (and untagged) games. Deathmatch, practice, and casual still affect K/D and aim stats.

## Linux notes

- **Launch Omega** and the rootlink stall restart use Windows process APIs. They do nothing on Linux; start Omega yourself.
- Frameless chrome (DWM caption, native resize hits) is Windows-specific. The GTK window still opens.
- Copying `omega-secrets.json` between machines or users will not unlock the keys.

## Build an executable

`icons/omegadash.ico` is embedded in the `.exe` (Explorer, taskbar, Alt-Tab). On Linux, `webview.start(icon=...)` also uses that file.

The spec is **one-file**: you get a single `OmegaDash.exe`. The first launch unpacks to a temp directory, so it is a bit slower to start. SQLite, settings, and API keys are written **next to the exe**, not into temp.

From `OmegaDash/`:

```powershell
python -m pip install pyinstaller
pyinstaller --noconfirm OmegaDash.spec
```

Linux:

```bash
python3 -m pip install pyinstaller
pyinstaller --noconfirm OmegaDash.spec
```

The build is `dist/OmegaDash.exe`. Use `OmegaDash.spec` so the icon is written into the exe. A one-off `--icon` on the command line is easy to miss if an old spec is reused.

