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
