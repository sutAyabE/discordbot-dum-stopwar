# discordbot-dum-stopwar

A small Discord bot that lets a community **vote to time out the two most-active members**
in a heated back-and-forth — neutral by design, so it isn't aimed at any one person.

## How it works

1. **Activity tracking** — the bot keeps a short, in-memory rolling count of who's talking in
   the allowed channel(s).
2. **Trigger** — when a configured phrase is typed, it nominates **two members**:
   - by default, the **two most-active** talkers in the last few minutes (the pair actually
     arguing), or
   - whoever is **@mentioned** in the trigger message (manual override).
3. **Vote** — it posts an embed with **Yes / No** buttons; the tally updates **live** on every
   click.
4. **Outcome** — when `Yes − No ≥ threshold` and a minimum number of distinct voters (quorum)
   is met, **both** members are timed out for the configured duration. Otherwise the vote
   expires with no action.

## Anti-abuse

- One vote per person (switch sides freely; click your choice again to abstain — no
  double-counting).
- Quorum gate so a small clique can't act in a near-empty channel.
- Only one active vote at a time.
- Starter / post-pass / per-member cooldowns.
- Channel allowlist.
- The server owner, admins, anyone with **Moderate Members**, protected roles, and bots can
  **never** be nominated.
- Every nomination and timeout is logged to a mod-log channel.

## Setup

- **Node ≥ 24**, **discord.js ^14**.
- Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications),
  enable the **Message Content** privileged intent, and invite it with: View Channels, Send
  Messages, Embed Links, Read Message History, **Moderate Members**.
- The bot's role must sit **above** any member it should be able to time out.

```bash
npm install
cp config.example.js config.js   # then fill in your phrase + channel IDs
```

## Run

The token comes from an environment variable — never commit it.

```bash
# macOS / Linux / Git Bash
DISCORD_TOKEN=your-token node index.js
```

```powershell
# Windows PowerShell
$env:DISCORD_TOKEN = "your-token"; node index.js
```

## Configuration

All tunables live in `config.js` (copied from `config.example.js`): trigger phrase, vote
`threshold` / `quorum`, timeout `durationMinutes`, activity window, cooldowns, allowed
channels, mod-log channel, and protected roles.

## Notes

- State is in-memory: a restart cancels any in-flight vote and clears recent-activity history.
- This repo ships `config.example.js` only; your real `config.js` is gitignored.
