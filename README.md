# Wave AVI – Exterior lighting control (Lutron HomeWorks QSX)

A small local server for a mini PC on the yacht network. It serves the
exterior lighting touch-panel app (deck plans, lit zones, dimming, scenes,
admin editor) and controls the Lutron **HomeWorks QSX** processor directly
over Lutron **LEAP**.

```
Touch panels / iPads ──HTTP 8080──▶ mini PC (this server) ──LEAP over TLS 8081──▶ HomeWorks QSX processor
                                                         └─pairing, TLS 8083 (once)
```

## Why LEAP

HomeWorks QSX processors (HQP7) do not support the old Telnet integration;
Lutron replaced it with LEAP. LEAP uses TLS with a client certificate that
the processor signs during **pairing**, which needs someone to press the
**Access button** on the processor.

Lutron does not publish the LEAP command set openly. This server uses the
same calls as the open-source `pylutron-caseta` library, which Home
Assistant uses with QSX/RA3. Test on site before handover, and re-test after
QSX firmware updates.

## What the integration does

| Function | LEAP call |
|---|---|
| Ping / test connection | `ReadRequest /server/1/status/ping`, `/project`, `/device?where=IsThisDevice:true` |
| Read zones | `ReadRequest /area`, `/area/{id}/associatedzone` |
| Read Lutron scenes | `ReadRequest /virtualbutton` |
| Set a dimmed zone | `CreateRequest /zone/{id}/commandprocessor` → `GoToDimmedLevel` (level + fade time) |
| Set a switched zone | `CreateRequest /zone/{id}/commandprocessor` → `GoToLevel` |
| Press a Lutron scene | `CreateRequest /virtualbutton/{id}/commandprocessor` → `PressAndRelease` |
| Live feedback | `SubscribeRequest /zone/status` (keypads and the Lutron app update the panels too) |

The connection is kept open with a ping every 60 s and reconnects
automatically (2 s backoff, rising to a 60 s maximum).

## Requirements

* Mini PC with Linux (Ubuntu 22.04/24.04 LTS or Debian 12 recommended) or Windows.
* Node.js 18 or newer (`node -v`).
* A fixed IP address for the mini PC and for the QSX processor, on the same network/VLAN.
* The mini PC must reach the processor on TCP **8081** (LEAP) and **8083** (pairing).
* Touch panels must reach the mini PC on TCP **8080** (or the port you set).

## Install on the mini PC (Linux, from Git)

```bash
sudo apt install -y git nodejs npm             # Node.js 18+ (or use NodeSource for a newer LTS)
sudo useradd -r -m -d /opt/wave-lighting wave  # service user
sudo -u wave git clone https://github.com/adriankobsin/WaveYachtLighting.git /opt/wave-lighting
cd /opt/wave-lighting
sudo -u wave npm ci --omit=dev
sudo -u wave npm run fetch-certs               # once, needs internet – see below
sudo -u wave npm run set-password              # optional: change the Wave AVI master password
sudo cp deploy/wave-lighting.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wave-lighting
journalctl -u wave-lighting -f                 # logs
```

If the repository is private, give the mini PC a read-only **deploy key**
(GitHub → repo → Settings → Deploy keys) and clone with the SSH URL.

### Updating to a new version

```bash
sudo /opt/wave-lighting/deploy/update.sh        # pulls main, installs, restarts
sudo /opt/wave-lighting/deploy/update.sh some-branch   # or test a branch
```

`data/` is not in Git, so the saved layout, Lutron addresses, pairing and
password stay as they are. If an update adds a new deck to the standard
layout (as 1.4.0 did with Lower and Tank deck), it is added to the saved
layout once without changing anything else. Back up `data/` before big updates.

Open `http://<mini-pc-ip>:8080` on the touch panels. In kiosk mode, point the
panel browser at that address.

**Windows:** install Node.js LTS, copy the folder, run `npm install`,
`npm run fetch-certs`, then `npm start`. To start it automatically, use a
service wrapper such as NSSM (`nssm install WaveLighting "C:\Program Files\nodejs\node.exe" C:\wave-lighting\server.js`).

### Pairing certificates (`npm run fetch-certs`)

Pairing opens the first TLS connection with the public "LAP" certificate
that Lutron systems accept for pairing. The script downloads it from the
`pylutron-caseta` package on PyPI (Apache-2.0) into `data/lutron/`. Do this
once, in the workshop or anywhere with internet. Offline alternative: copy a
downloaded `pylutron_caseta-*.tar.gz` to the mini PC and run
`npm run fetch-certs -- --from pylutron_caseta-x.y.z.tar.gz`.

## Commissioning steps (admin)

1. Open the app and press **Admin**. Log in with the Wave AVI master password or your own user password.
2. Go to **Lutron setup** and enter the processor IP address. Leave the LEAP port at 8081 and set the default fade time. Press **Save connection settings**.
3. Press **Pair with processor**. When the screen says so, press the **Access button** on the HomeWorks QSX processor within 3 minutes. The status turns **Processor connected**.
4. Press **Test connection**. It shows the ping time, LEAP version, processor model/serial and project name.
5. Press **Read from processor** to load all zones and Lutron scenes.
6. In **Integration addresses – circuits**, give each circuit its Lutron zone ID(s). Either pick them from the list or type the numbers. One circuit can drive several zones, e.g. port + starboard floods.
7. Use **On / Off** next to each circuit to check that the right lights respond.
8. Optionally, link ship-wide scenes to Lutron scenes (virtual buttons) under **Integration addresses – scenes**. Use **Press** to test them.
9. Press **Save & deploy**. Every panel updates immediately.

The deck screens (Lights / Scenes tabs) let you add, edit, move or delete
circuits and their lit areas on the GA. Scenes can be edited on each deck
(Scenes tab) or for every deck at once on the Overview: each light is
**Off**, **On** at a level, or **Don't change**. You can also rename, add,
duplicate, reorder and delete scenes.

## Languages (English / Russian)

The **EN / RU** switch in the top bar changes the whole app: menus, buttons, messages and admin pages, plus deck, circuit and scene names. Each panel or browser remembers its own choice.

* Interface text is in `public/i18n.js`. English is the key and Russian the value, so a new text in the app only needs one new line there.
* Names of decks, circuits and scenes are saved with the layout. Each has an English `name` and an optional `ru.name`, and deck notes have `ru.note`. If no Russian name is set, the English one is shown.
* To edit names in admin:
  * **Circuits:** deck → **Lights** tab → **Name (English)** and **Name (Russian)**.
  * **Scenes:** **Scenes** tab or Overview → **Scene name (English)** and **Scene name (Russian)**.
* Zone and scene names read from the Lutron processor are shown as they are programmed in Lutron.

## Admin users and passwords

Admins log in with **their password only**, so every user needs a different password.

* **Wave AVI** is the master account. It always exists and cannot be deleted, and only Wave AVI can change its password.
* Other users, such as the ETO or a service engineer, have the **same admin access** as Wave AVI: layout, scenes, Lutron setup and users. The only exceptions are changing the master password and deleting the master account.
* In the app: **Admin** → left menu **Users & passwords**.
  * **Your password**: change your own password. Your current password is needed.
  * **Users**: rename users, set a new password for another user (they are logged out on other screens), or delete them.
  * **Add a user**: name and password, at least 8 characters.
* Locked out? On the mini PC, run `npm run set-password` (Wave AVI) or `npm run set-password -- --user "ETO"`, then `sudo systemctl restart wave-lighting`.

Users are stored in `data/users.json` as scrypt hashes, readable only by the service user. Servers installed with 1.0/1.1 move the old `admin.json` password into the Wave AVI account automatically.

## Repository layout

| Path | What it is |
|---|---|
| `server.js`, `lib/` | The local server and the Lutron LEAP integration |
| `public/` | The touch-panel web app (`index.html`), translations (`i18n.js`) and deck images |
| `defaults/` | Starting layout and admin password hash, copied to `data/` on first run |
| `demo/` | Browser demo: `demo-shim.js` simulates the server and a QSX processor |
| `assets/deck-plans/` | Transparent PNGs of the deck GA plans (white and dark lines) |
| `deploy/` | systemd service and `update.sh` |
| `scripts/` | Password, LAP certificates, demo build |
| `test/` | Mock QSX processor for testing without hardware |

## Browser demo (no mini PC, no processor)

```bash
npm run build-demo          # writes demo/dist/
npx serve demo/dist         # or any static web server
```

The demo runs the same app code as the server. `demo/demo-shim.js` answers
the `/api` calls in the browser and simulates a QSX processor. Its panel
(**Press Access button**, **Processor online**) is only shown to admins on
the Lutron setup page. The hosted copy on claude.ai
is built from this too. Outside claude.ai the demo has no shared store, so
saved layouts last only until the page is reloaded.

## Files

| Path | What it is |
|---|---|
| `server.js` | HTTP server, control API, admin API, live updates (Server-Sent Events) |
| `lib/leap.js` | LEAP client (TLS, JSON lines, requests, subscriptions) |
| `lib/pair.js` | Pairing flow (CSR, Access-button wait, certificate) |
| `lib/lutron.js` | Connection manager, discovery, zone status, commands |
| `lib/auth.js` | Admin users (master + others), scrypt hashes, sessions, login rate limit |
| `public/` | Touch-panel web app and deck plan images |
| `defaults/` | Starting layout and the initial Wave AVI password hash, copied to `data/` on first run |
| `data/config.json` | Live layout: decks, circuits, lit areas, scenes, Lutron addresses (30 automatic backups in `data/backups/`) |
| `data/settings.json` | Processor IP, ports, fade time |
| `data/lutron/` | Pairing certificates and the last zone discovery. **Keep private** |
| `test/mock-processor.js` | Fake QSX processor for testing without hardware |

Back up the whole `data/` folder after commissioning.

## Testing without a processor

```bash
npm run mock-processor                  # terminal 1 – fake QSX on 18081/18083
DATA_DIR=test-data npm start            # terminal 2
```

In **Lutron setup**, enter IP `127.0.0.1` and port `18081`, then pair. The
mock "presses" the Access button by itself and has three zones (101, 102,
201) and one scene button (7). It flips zone 101 every 20 s to simulate a
keypad.

## Security notes

* Admin passwords are stored as scrypt hashes on the server (`data/users.json`). Admin sessions use an HttpOnly cookie and last 12 h. Login is limited to 5 attempts per minute, and changing a user's password logs that user out everywhere else.
* Normal lighting control has no login, so anyone on the same network as the panels can use it. Keep the server on the crew/AV network, not guest Wi-Fi.
* The app uses plain HTTP inside the boat. For HTTPS, put a reverse proxy (Caddy or nginx) in front of it.
* `data/lutron/client.key` is the key the processor trusts. If the mini PC is replaced or the key is exposed, use **Forget pairing**, pair again, and remove the old integration in Lutron Designer if it is listed there.

## API (for Crestron or other systems)

| Method | Path | Body |
|---|---|---|
| GET | `/api/bootstrap` | – layout, levels, connection status |
| GET | `/api/events` | – Server-Sent Events: `state`, `lutron`, `config` |
| POST | `/api/circuit` | `{ "id": "GR24", "on": true, "level": 60 }` |
| POST | `/api/scene` | `{ "id": "evening", "scope": "all" }` or a deck id (`"main"`) |
| POST | `/api/alloff` | – |

Admin routes (`/api/config`, `/api/lutron/*`) need the admin session cookie.

## Light fixtures on the GA

Each circuit carries a list of fixtures (`fx`) drawn on its deck plan: `flood`, `spot`,
`down`, `pendant`, `wall`, `step`, `under`, `strip`, `neon` and `area`. Positions are % of
the plan width/height, sizes are % of the plan height. Admins place and edit them in
deck → Lights. Older layouts with lit areas (`z`) are converted to `area` fixtures.
`prototypes/fixtures/` holds the original stand-alone concept demo.

Decks with `hidden: true` are not shown to the crew (Admin → Overview → Decks on the dashboard).
