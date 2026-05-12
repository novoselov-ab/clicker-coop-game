# Farm Dilemma

Async multiplayer farming clicker prototype.

Players join with a name, harvest grain, buy farm assets, and interact globally with other visible players:

- Share Feed: both players get grain, actor gains trust.
- Raid Silo: actor gets a larger payout, target loses some grain, trust drops.

State is intentionally in memory for quick prototyping. Restarting the server resets the world.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3010`.

Environment knobs:

```bash
PORT=3010 MAX_PLAYERS=40 npm start
```

## VM deployment

This VM runs the app with a user-level systemd service:

```bash
cp deploy/farm-dilemma.service ~/.config/systemd/user/farm-dilemma.service
systemctl --user daemon-reload
systemctl --user enable --now farm-dilemma.service
loginctl enable-linger anton
```

Caddy proxies `https://vm.catfloof.org/` to `127.0.0.1:3010` from the existing website container.
