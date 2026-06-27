# 🐱 Dum the Gigacat — community vote-to-action bot

Dum is a neutral, community-run Discord bot for cooling down heated arguments. Anyone trusted with
the **magic word** (a passcode) can call a vote on the channel's most heated members; the community
decides what happens, and the highest tally wins when the timer ends. Dum never targets a preset
person — it acts on whoever's in the fight.

> Built for the GeForce NOW Thailand community. All wording lives in `messages.js`, so you can
> translate or restyle every message (the shipped copy is bilingual Thai + English in Dum's voice).

## How a vote works

1. **Someone reports a war** with `/dumplshelp` (they need the *magic word*, unless they're a
   moderator). Dum nominates the **two most-active recent talkers** — or a moderator can hand-pick.
2. **The community votes** via three buttons (a live countdown ticks in the embed):
   - 👌 **Let them** — no action
   - ⛔ **Time out** — Discord timeout for `durationMinutes`
   - 🥊 **Elsewhere** — sent to a temporary **🥊 Arena** channel, then a post-arena timeout
3. **Highest tally wins** when the window closes. Ties: *Let them* wins any two-way tie it's in;
   *Time out* wins a Time-out-vs-Elsewhere tie and a three-way tie. Below the **quorum**, nothing happens.

## Commands

| Command | Who | What |
|---|---|---|
| `/dumplshelp [passcode] [user1…]` | Anyone with the magic word, or a moderator | Start a vote. Hand-picking `user`s is **moderators only**. |
| `/release <user>` | Moderators | Pull someone out of the 🥊 Arena early, with no post-arena timeout. |

## The 🥊 Arena

If *Elsewhere* wins, Dum creates a temporary channel (`containmentChannelPrefix`), moves the
nominees in (stripping their other roles if `stripRolesOnContain`), and lets the community spectate
but not type. When the timer ends, Dum restores roles, deletes the room, and applies
`postArenaTimeoutMinutes`. Active arenas survive a restart (saved to `.containments.json`).

## Anti-abuse

- **Magic word gate** — non-moderators need the passcode to start a vote; hand-picking is mods-only.
- One vote per person (change/undo freely); **quorum** floor; one active vote at a time.
- Starter / post-action / per-member cooldowns; channel allowlist.
- Owner, admins, **Moderate Members** holders, protected roles, and bots are **never** nominated.
- Every event is mirrored to a mod-log channel (and the console).

## Setup

**Requirements:** Node **≥ 24**, discord.js **^14**.

1. Create an app + bot in the [Discord Developer Portal](https://discord.com/developers/applications).
   **No privileged intents required** — Dum reads message *metadata* only (Message Content can stay off).
2. Invite with scopes **`bot` + `applications.commands`** and permissions: **View Channel, Send
   Messages, Embed Links, Read Message History, Moderate Members, Manage Channels, Manage Roles,
   Attach Files, Create Public/Private Threads, Send Messages in Threads**.
3. **Role hierarchy:** drag Dum's role **above** any member it may act on, and **above** the Contained role.
4. **Contained role:** create a role with **View Channel denied on every category**; put its ID in
   `containedRoleId`. Dum only adds/removes this role.

```bash
npm install
cp config.example.js config.js       # fill in your IDs + the magic word
cp messages.example.js messages.js   # then edit the wording to taste
```

## Run

The token comes from an environment variable — never commit it.

```bash
# macOS / Linux / Git Bash
DISCORD_TOKEN=your-token node index.js
# …or a .env file:
node --env-file=.env index.js
```
```powershell
# Windows PowerShell
$env:DISCORD_TOKEN = "your-token"; node index.js
```

## Configuration (`config.js`)

Copy `config.example.js` → `config.js` (gitignored) and fill in:

| Key | What |
|---|---|
| `quorum` | Minimum total votes for any action |
| `durationMinutes` | ⛔ Time-out length |
| `postArenaTimeoutMinutes` | Timeout after the Arena (0 = none) |
| `voteWindowMinutes` | How long voting stays open |
| `maxTargets` | Most members a moderator can hand-pick |
| `modRoleIds` | Roles allowed to hand-pick & `/release` (`[]` = use *Moderate Members*) |
| `votePasscode` | The magic word non-mods need (`''` = open to all) |
| `activityWindowMinutes` / `minMessagesToNominate` | Auto-nomination window + message floor |
| `starterCooldownMinutes` / `retargetCooldownMinutes` / `userRetargetCooldownMinutes` | Cooldowns |
| `allowedChannelIds` | Channels Dum listens in (`[]` = all) |
| `modLogChannelId` | Where events are logged (`''` = off) |
| `modAlertRoleId` | Role pinged in the mod-log when a vote needs a manual check (`''` = no ping) |
| `protectedRoleIds` | Roles that can never be nominated |
| `containmentMinutes` | Time in the 🥊 Arena before auto-release |
| `containedRoleId` | The Contained role (`''` disables the Arena) |
| `containmentCategoryId` | Optional parent category for the temp channel |
| `containmentChannelPrefix` | Arena channel name (e.g. `🥊Arena`) |
| `stripRolesOnContain` | Strip & restore roles while in the Arena |

## Customizing messages (`messages.js`)

Every user-facing string — embeds, buttons, ephemeral replies, mod-log lines, and command
descriptions — lives in `messages.js` (copied from `messages.example.js`). Edit that file to
translate or restyle the bot without touching `index.js`. Static text is a plain string; dynamic
text is a small function that receives the live values (e.g. `({ nameList, endsAt }) => …`). Useful
Discord tokens: `<@id>` (mention), `<#id>` (channel), `<t:unix:R>` (live countdown), `-#` (subtext).

## Notes

- Vote state is in-memory: a restart cancels any in-flight vote. Active Arenas resume from
  `.containments.json`.
- This repo ships `config.example.js` and `messages.example.js` only; your real `config.js` and
  `messages.js` are gitignored.
