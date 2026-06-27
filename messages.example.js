// ─── messages (EXAMPLE) ─────────────────────────────────────────────────────────
// Copy this file to `messages.js` and edit the wording to fit your server. `messages.js`
// is gitignored, so your live copy stays out of the repo.
//
// Every user-facing string the bot sends lives here, so you can customize it without
// touching index.js. Static text = plain strings; dynamic text = functions that receive
// the live values. The assembly logic (loops, conditionals, timers) stays in index.js —
// here you only change wording.
//
// Discord tokens you can use inside strings:
//   <@123>        → mentions a user        (use the `id` you're given)
//   <#123>        → links a channel
//   <@&123>       → mentions a role
//   <t:UNIX:R>    → a live, counting-down timestamp ("in 5 minutes")
//   -# text       → small "subtext" line
//   \u200B         → zero-width space; forces a blank line (Discord trims plain newlines)
//   **text**      → bold
// Command + option descriptions are capped at 100 characters by Discord.

export default {
  // ── Slash-command picker text (≤100 chars each) ──
  commands: {
    dumplshelp: 'Start a community vote on the most active members (or hand-pick — mods only).',
    passcodeOption: 'Passcode to start a vote. Moderators can leave this blank.',
    targetOption: (n) => `Target #${n}`,
    release: 'Release a member from the timeout room early (moderators only).',
    releaseUserOption: 'Member to release',
  },

  // ── Vote buttons (emoji + label; the bot keeps the colors/ids) ──
  buttons: {
    letThem: { emoji: '🕊️', label: 'Let them' },
    timeout: { emoji: '⛔', label: 'Time out' },
    elsewhere: { emoji: '🥊', label: 'Elsewhere' },
  },

  // ── Embeds ──
  embeds: {
    // Shared footer for the result embeds.
    finalFooter: ({ cancel, timeout, arena }) =>
      `Final vote — Let them: ${cancel} · Time out: ${timeout} · Elsewhere: ${arena}`,

    open: {
      color: 0x5865f2,
      title: 'Community vote',
      fields: { letThem: 'Let them', timeout: 'Time out', elsewhere: 'Elsewhere' },
      statusNeed: (need) => `Need ${need} more vote(s)`,
      statusEnough: 'Enough votes',
      footer: ({ total, status }) => `${total} votes · ${status}`,
      description: ({ nameList, endsAt }) =>
        '\u200B\nThe community is voting on what to do about:\n\n' +
        `**${nameList}**\n\n` +
        '1. Let them — no action\n' +
        '2. Time out — a Discord timeout\n' +
        '3. Elsewhere — move them to a temporary room\n\n' +
        `🕒 Voting ends <t:${endsAt}:R>`,
    },

    resultTimeout: {
      color: 0xffcc00,
      title: 'Vote ended',
      line: ({ id, untilUnix }) => `⛔ <@${id}> — timed out, back <t:${untilUnix}:R>`,
      lineFailed: ({ id, msg }) => `⚠️ <@${id}> — not timed out (${msg})`,
      fallback: ({ nameList }) => `Timed out ${nameList}.`,
      description: ({ body }) => `\u200B\nThe community voted to time out:\n${body}\n\u200B`,
    },

    resultArena: {
      color: 0xff3333,
      title: 'Vote ended',
      roomFallback: 'the room',
      line: ({ id }) => `🥊 <@${id}>`,
      description: ({ room, results }) => `\u200B\nMoved to ${room}:\n\n${results}\n\u200B`,
    },

    cancelled: {
      color: 0x57f287,
      title: 'Vote ended',
      description: ({ nameList }) => `\u200B\nNo action taken. Please keep it civil, ${nameList}.\n\u200B`,
    },

    arenaWelcome: {
      color: 0xff3333,
      title: 'Welcome to the room',
      description: ({ mentions, arenaEndsAt }) =>
        `\u200B\n${mentions}, settle it here — the community can watch but not type.\n\n` +
        `🕒 This room closes <t:${arenaEndsAt}:R>`,
    },

    arenaClose: {
      color: 0x57f287,
      title: 'Room closed',
      line: ({ id, postEndsAt }) => `⛔ <@${id}> — timed out, back <t:${postEndsAt}:R>`,
      description: ({ postLines }) => `\u200B\nThe room is closed.\n\n${postLines}Thanks for keeping it civil.\n\u200B`,
    },
  },

  // ── Ephemeral replies (private, to the person who ran the command/click) ──
  ephemerals: {
    wrongChannel: "Votes can't be started in this channel.",
    wrongPasscode: 'Wrong passcode.',
    needPasscode: 'You need the passcode to start a vote.',
    handpickByNonMod: 'Only moderators can hand-pick targets.',
    votePosted: 'Vote posted.',
    voteClosed: 'This vote is already closed.',
    releaseNonMod: 'Only moderators can release members.',
    released: ({ id }) => `Released <@${id}>.`,
    notInRoom: ({ id }) => `<@${id}> is not in the room.`,
    // startGuard reasons:
    voteInProgress: 'A vote is already in progress.',
    tooSoon: 'Too soon after the last action — try again shortly.',
    starterCooldown: 'You started a vote recently — please wait a bit.',
    // nominate reasons:
    notFound: ({ id }) => `I couldn't find <@${id}> in this server.`,
    cantVote: ({ id }) => `<@${id}> can't be put up for a vote.`,
    onCooldown: ({ id }) => `<@${id}> was recently actioned — on cooldown.`,
    notEnoughActivity: 'Not enough recent activity to auto-pick two members.',
  },

  // ── Mod-log lines (mirrored to the console too). `ping` is a pre-built role mention. ──
  modLog: {
    voteStarted: ({ starter, targets }) => `🗳️ <@${starter}> started a vote on ${targets}.`,
    warStopped: ({ summary, counts }) => `Vote → time out (${counts})\n${summary}`,
    timeoutLine: ({ id }) => `⛔ <@${id}> timed out`,
    timeoutFailed: ({ id, msg }) => `⚠️ <@${id}> not timed out (${msg})`,
    arenaSent: ({ counts, users, channelId }) =>
      `Vote → elsewhere (${counts}) — sent ${users} to <#${channelId}>`,
    arenaFailed: ({ counts, who }) => `Vote → elsewhere (${counts}) — couldn't set up the room for ${who}`,
    spared: ({ counts, who }) => `Vote → no action (${counts}) — ${who}`,
    postArena: ({ users, min }) => `Post-room timeout: ${users} for ${min} min.`,
    arenaClosed: ({ users }) => `Room closed — ${users} released.`,
    wrongMagicWord: ({ user }) => `<@${user}> tried to start a vote with the wrong passcode.`,
    nonModHandpick: ({ user, ping }) =>
      `<@${user}> tried to hand-pick targets without mod rights. ${ping}please check.`,
    notEnoughBloodshed: ({ user, ping }) =>
      `<@${user}> tried to start a vote, but there wasn't enough recent activity. ${ping}heads up.`,
    containNoRole: 'Room skipped: contained role is not configured.',
    containRoleNotFound: 'Room skipped: contained role not found.',
    containCreateFailed: ({ error }) => `Room skipped: couldn't create channel (${error}).`,
  },
};
