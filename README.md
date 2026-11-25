# Advanced SNES ROM Utility JS – Tauri-Version

Schlanke Variante der Electron-Version für Windows, macOS und Linux. Statt eines mitgelieferten
Chromium nutzt sie den Browser-Kern des Betriebssystems:

| System | Browser-Kern | Hinweis |
|---|---|---|
| Windows 10/11 | WebView2 (Edge) | ist vorinstalliert; der Installer lädt es sonst nach |
| macOS 10.15+ | WebKit (WKWebView) | ist Teil des Systems |
| Linux | WebKitGTK 4.1 | Paket `libwebkit2gtk-4.1-0` (bei Desktop-Distributionen meist vorhanden) |

Oberfläche (klassisch/modern, Heatmap, Handbuch) und die gesamte ROM-Logik sind identisch zur
Electron-Version 2.0.

## Aufbau

```
lib/core/            ROM-Logik (unveränderter JS-Core der Electron-Version)
lib/shims/           Ersatz für die Node-Module fs, path, crypto im Browser
scripts/bundle-core.js  packt lib/ in eine Browser-Datei: web/js/core.bundle.js
web/                 Oberfläche
  index.html, renderer.js, styles.css   Hauptfenster (wie Electron)
  js/app.js          Steuerung des Hauptfensters (Port von src/main/main.js)
  js/platform.js     Zugriff auf Dateien, Dialoge, Fenster, Events über Tauri
  js/modal.js        Meldungsfenster innerhalb der App
  js/bridge-child.js Verbindung für Handbuch, About und Heatmap
src-tauri/           Rust-Teil: Dateizugriff, Einstellungen, Menü, Fenster
cli.js               Kommandozeile (läuft mit Node.js)
```

**Wie es funktioniert:** Die ROM-Logik läuft als JavaScript im Fenster. Weil der Browser Dateien nicht
synchron lesen kann, liest die App eine Datei zuerst über Rust ein und legt sie in einer kleinen
Datei-Tabelle im Speicher ab (`lib/shims/fs.js`). Der Core arbeitet darauf wie gewohnt. Dateien, die der
Core schreibt (Split, SwapBin), sammelt die Tabelle; die App schreibt sie danach über Rust auf die
Platte. MD5, SHA-1 und SHA-256 sind in `lib/shims/crypto.js` in reinem JavaScript umgesetzt.

## Einrichten und bauen (Windows)

1. `setup-windows.cmd` doppelklicken. Das Skript prüft bzw. installiert Node.js, Rust, die
   Visual Studio C++ Build Tools (Windows fragt dabei nach Administratorrechten) und lädt alle
   Abhängigkeiten. Protokoll: `setup.log`.
2. `build-windows.cmd` doppelklicken. Der erste Build dauert 5–15 Minuten, danach deutlich kürzer.
   Ergebnis in `dist\`:
   - `…_x64-setup.exe` – Installer
   - `Advanced SNES ROM Utility JS-Portable-2.0.0.exe` – einzelne EXE ohne Installation
     (braucht WebView2, das unter Windows 10/11 vorhanden ist)

Weitere Befehle:

```bash
npm run dev          # App im Entwicklungsmodus starten
npm test             # Tests (Core + Browser-Ersatzmodule)
npm run build:linux  # deb + AppImage (unter Linux)
npm run build:mac    # app + dmg (unter macOS)
node cli.js -help    # Kommandozeile
```

Linux braucht zum Bauen: `build-essential file libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.

## Build-Pipeline (GitHub Actions)

`.github/workflows/build.yml` baut auf GitHub für alle drei Systeme, macOS als Universal-Build für
Intel und Apple Silicon. (Im Projektordner liegt eine Kopie unter `ci/build.yml`; vor dem ersten Push
nach `.github/workflows/build.yml` verschieben, falls der Ordner `.github` fehlt.)

| Auslöser | Ergebnis |
|---|---|
| Push auf `main`/`dev`, Pull Request | Tests + Builds; Pakete als „Artifacts“ am Lauf |
| *Actions* → *Build* → *Run workflow* | dasselbe manuell |
| Tag `v*`, z. B. `v2.1.0` | zusätzlich ein Release mit allen Paketen |

Neue Version: Version in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` und
`lib/version.js` anheben, committen, `git tag v2.1.0` und `git push origin v2.1.0`.

## Unterschiede zur Electron-Version

- **Kommandozeile:** läuft über Node.js (`node cli.js …`), nicht über die installierte App.
- **Meldungsfenster** erscheinen innerhalb des App-Fensters statt als Systemdialog
  (gleiches Aussehen auf allen Systemen, passend zum gewählten Design).
- **Einstellungen** liegen im App-Konfigurationsordner (`de.snes-projects.advanced-snes-rom-utility-js`).
  Beim ersten Start werden die Einstellungen der Electron-Version übernommen.
- **Noch nicht umgesetzt:** nur eine laufende Instanz (eine zweite Datei per „Öffnen mit“ startet ein
  zweites Fenster) und „Öffnen mit“ über das Dock unter macOS.
- Unsignierte Builds lösen beim ersten Start ggf. eine SmartScreen- bzw. Gatekeeper-Warnung aus.
  macOS-Builds sind nur ad-hoc signiert: beim ersten Start Rechtsklick → *Öffnen*. Meldet macOS, die App
  sei „beschädigt“, hilft im Terminal: `xattr -cr "/Applications/Advanced SNES ROM Utility JS.app"`.

## Lizenz

GPL-3.0, wie das Original.
