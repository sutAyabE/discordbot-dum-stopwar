// ─── config (EXAMPLE) ──────────────────────────────────────────────────────────
// Copy this file to `config.js` and fill in your own values. `config.js` is
// gitignored, so your live trigger phrase and channel IDs stay out of the repo.
// The numbers below are sensible production defaults — tune to your community.

export default {
  // Vote: three choices (Time out / Arena / Cancel) — highest tally wins at the timer's end.
  quorum: 5, // minimum TOTAL votes for any action; below it → no action
  durationMinutes: 10, // the "Time out" choice length (minutes)
  postArenaTimeoutMinutes: 5, // timeout applied AFTER the arena (0 = none)
  voteWindowMinutes: 5, // how long voting stays open before the tally is read

  // Targets & who may hand-pick them.
  maxTargets: 6, // most members a moderator can name in one vote
  modRoleIds: [], // roles allowed to hand-pick targets & run /release ([] = use the "Moderate Members" permission)
  votePasscode: '', // non-mods must supply this to start a vote via /dumplshelp passcode:… ('' = open to all, case-sensitive)

  // Auto-nomination (the 2 most-active recent talkers).
  activityWindowMinutes: 5, // how far back "recently active" looks
  minMessagesToNominate: 3, // a user needs ≥ this many recent msgs to be auto-picked

  // Cooldowns (anti-abuse). Set to 0 to disable while testing.
  starterCooldownMinutes: 10, // one user can't start back-to-back votes
  retargetCooldownMinutes: 30, // global grace after a successful timeout
  userRetargetCooldownMinutes: 30, // a member can't be re-muted within this window

  // Where the bot listens/tracks. Empty array = every channel it can see.
  allowedChannelIds: ['YOUR_CHANNEL_ID'],

  // Where outcomes are logged. Empty string = no logging.
  modLogChannelId: 'YOUR_MODLOG_CHANNEL_ID',
  modAlertRoleId: '', // role pinged in the mod-log when a vote needs a manual check ('' = no ping)

  // Roles that can never be nominated/voted on (mods/staff). Owner + admins +
  // anyone with the "Moderate Members" permission + bots are always excluded.
  protectedRoleIds: [],

  // ── Arena room (the 🥊 choice) ──
  containmentMinutes: 30, // time in the ring before everyone is auto-released
  containedRoleId: '', // a role with "View Channel" DENIED on every category; '' disables the room
  containmentCategoryId: '', // optional parent category ID for the temp channel ('' = no parent)
  containmentChannelPrefix: '🥊Arena', // temp channel name prefix (Discord shows it lowercased: 🥊arena)
  stripRolesOnContain: true, // remove the member's roles while jailed & restore on release (seals the jail)
};
