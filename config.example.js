// ─── config (EXAMPLE) ──────────────────────────────────────────────────────────
// Copy this file to `config.js` and fill in your own values. `config.js` is
// gitignored, so your live trigger phrase and channel IDs stay out of the repo.
// The numbers below are sensible production defaults — tune to your community.

export default {
  // What text in a message starts a vote (case-insensitive, matched anywhere in
  // the message). To manually pick the pair, mention two members in the same
  // message, e.g. "<phrase> @userA @userB".
  triggerPhrase: 'YOUR_TRIGGER_PHRASE',

  // Vote maths.
  threshold: 5, // (Yes − No) needed to pass
  quorum: 8, // minimum distinct voters before a pass can fire (anti-clique)
  durationMinutes: 10, // timeout length applied to BOTH nominated members
  voteWindowMinutes: 5, // auto-close the vote if it hasn't passed by now

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

  // Roles that can never be nominated/voted on (mods/staff). Owner + admins +
  // anyone with the "Moderate Members" permission + bots are always excluded.
  protectedRoleIds: [],
};
