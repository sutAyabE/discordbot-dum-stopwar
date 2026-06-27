import {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  ApplicationCommandOptionType,
} from 'discord.js';
import config from './config.js';
import messages from './messages.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, // activity tracking uses message metadata only — no MessageContent needed
  ],
});

// ─── State (in memory — a restart clears all of this) ─────────────────────────

const activity = new Map(); // channelId -> [{ userId, ts }]   rolling "who's talking"
let activeVote = null; // the single in-flight vote, or null
const starterCooldowns = new Map(); // userId -> ms timestamp of their last started vote
const mutedCooldowns = new Map(); // userId -> ms timestamp of when they were last muted
let lastPassAt = 0; // ms timestamp of the last successful timeout (global grace)
const activeContainments = new Map(); // channelId -> { channelId, guildId, userIds, roleId, removed, releaseAt, timer }

// ─── Small helpers ────────────────────────────────────────────────────────────

const now = () => Date.now();
const mins = (m) => m * 60_000;

/** Format milliseconds as M:SS. */
function fmt(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "A and B" for two, "A, B, and C" for more. */
function joinNames(ids) {
  const tags = ids.map((id) => `<@${id}>`);
  if (tags.length <= 2) return tags.join(' and ');
  return `${tags.slice(0, -1).join(', ')}, and ${tags.at(-1)}`;
}

/** A member who must never be put up for a vote / contained. */
function isProtected(member) {
  if (!member || member.user.bot) return true;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(PermissionFlagsBits.ModerateMembers)) return true;
  return config.protectedRoleIds.some((r) => member.roles.cache.has(r));
}

/** Can this member start a *manual* (hand-picked) vote or run /release? */
function isModerator(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ModerateMembers)) return true;
  return config.modRoleIds.some((r) => member.roles.cache.has(r));
}

/** The bot can actually time this member out (hierarchy + perms) and they're not protected. */
function canModerate(member) {
  return Boolean(member) && member.moderatable && !isProtected(member);
}

function onMuteCooldown(userId) {
  const last = mutedCooldowns.get(userId);
  return Boolean(last) && now() - last < mins(config.userRetargetCooldownMinutes);
}

/** Shared guards for starting any vote (phrase or /vote). */
function startGuard(starterId) {
  if (activeVote) return { ok: false, reason: messages.ephemerals.voteInProgress };
  if (now() - lastPassAt < mins(config.retargetCooldownMinutes))
    return { ok: false, reason: messages.ephemerals.tooSoon };
  const last = starterCooldowns.get(starterId);
  if (last && now() - last < mins(config.starterCooldownMinutes))
    return { ok: false, reason: messages.ephemerals.starterCooldown };
  return { ok: true };
}

// ─── Activity tracking ────────────────────────────────────────────────────────

function recordActivity(message) {
  const cutoff = now() - mins(config.activityWindowMinutes);
  const buf = (activity.get(message.channelId) ?? []).filter((e) => e.ts >= cutoff);
  buf.push({ userId: message.author.id, ts: now() });
  activity.set(message.channelId, buf);
}

/** User IDs in a channel sorted by recent message count (desc), past the floor. */
function topTalkers(channelId) {
  const cutoff = now() - mins(config.activityWindowMinutes);
  const counts = new Map();
  for (const e of activity.get(channelId) ?? []) {
    if (e.ts < cutoff) continue;
    counts.set(e.userId, (counts.get(e.userId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= config.minMessagesToNominate)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

// ─── Nomination ───────────────────────────────────────────────────────────────

/**
 * Pick the members to vote on.
 *  - Manual (seedIds given): use exactly those (1…maxTargets); any protected/
 *    cooldown/unknown seed aborts the whole vote with a message.
 *  - Auto (no seeds): the 2 most-active recent talkers.
 * Returns { ok, members } or { ok:false, reason }.
 */
async function nominate({ guild, channelId, seedIds }) {
  if (seedIds.length > 0) {
    const members = [];
    for (const id of seedIds.slice(0, config.maxTargets)) {
      const member = await guild.members.fetch(id).catch(() => null);
      if (!member) return { ok: false, reason: messages.ephemerals.notFound({ id }) };
      if (isProtected(member) || !member.moderatable)
        return { ok: false, reason: messages.ephemerals.cantVote({ id }) };
      if (onMuteCooldown(id)) return { ok: false, reason: messages.ephemerals.onCooldown({ id }) };
      members.push(member);
    }
    return { ok: true, members };
  }

  // Auto: the two most-active recent talkers.
  const members = [];
  const seen = new Set();
  for (const id of topTalkers(channelId)) {
    if (members.length === 2) break;
    if (seen.has(id) || onMuteCooldown(id)) continue;
    seen.add(id);
    const member = await guild.members.fetch(id).catch(() => null);
    if (canModerate(member)) members.push(member);
  }
  if (members.length < 2)
    return { ok: false, reason: messages.ephemerals.notEnoughActivity };
  return { ok: true, members };
}

// ─── Tally + embed + buttons ──────────────────────────────────────────────────

/** Count the three choices. */
function tally(vote) {
  const c = { timeout: 0, arena: 0, cancel: 0 };
  for (const v of vote.choices.values()) c[v]++;
  return c;
}

/** Plurality winner with a quorum floor. Tie-breaks: a Timeout-vs-Cancel tie is lenient
 *  (→ cancel); every other tie (incl. three-way) favors action (→ time out). */
function decide(counts, total) {
  if (total < config.quorum) return 'cancel';
  const max = Math.max(counts.timeout, counts.arena, counts.cancel);
  const leaders = ['timeout', 'arena', 'cancel'].filter((k) => counts[k] === max);
  if (leaders.length === 1) return leaders[0];
  // "Let them" (cancel) wins any 2-way tie it's in; timeout-vs-arena and the three-way tie → time out.
  if (leaders.length === 2 && leaders.includes('cancel')) return 'cancel';
  return 'timeout';
}

function buildRow(disabled) {
  // Emojis/labels come from messages.buttons; custom_ids & styles stay fixed so the handler still maps them.
  const b = messages.buttons;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vote_cancel').setEmoji(b.letThem.emoji).setLabel(b.letThem.label).setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('vote_timeout').setEmoji(b.timeout.emoji).setLabel(b.timeout.label).setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('vote_arena').setEmoji(b.elsewhere.emoji).setLabel(b.elsewhere.label).setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function buildEmbed(vote, state, opts = {}) {
  const c = tally(vote);
  const total = vote.choices.size;
  const nameList = joinNames(vote.targets.map((t) => t.id));
  const E = messages.embeds;
  const finalFooter = E.finalFooter({ cancel: c.cancel, timeout: c.timeout, arena: c.arena });

  const embed = new EmbedBuilder();

  if (state === 'open') {
    const need = config.quorum - total;
    // Live countdown via a Discord relative timestamp (ticks client-side, no bot edits).
    const endsAt = Math.floor((vote.createdAt + mins(config.voteWindowMinutes)) / 1000);
    const status = need > 0 ? E.open.statusNeed(need) : E.open.statusEnough;
    return embed
      .setColor(E.open.color)
      .setTitle(E.open.title)
      .addFields(
        { name: E.open.fields.letThem, value: String(c.cancel), inline: true },
        { name: E.open.fields.timeout, value: String(c.timeout), inline: true },
        { name: E.open.fields.elsewhere, value: String(c.arena), inline: true },
      )
      .setDescription(E.open.description({ nameList, endsAt }))
      .setFooter({ text: E.open.footer({ total, status }) });
  }

  if (state === 'result_timeout') {
    const body =
      (vote.results ?? [])
        .map((r) =>
          r.ok
            ? E.resultTimeout.line({ id: r.id, untilUnix: Math.floor(r.until / 1000) })
            : E.resultTimeout.lineFailed({ id: r.id, msg: r.msg }),
        )
        .join('\n') || E.resultTimeout.fallback({ nameList });
    return embed
      .setColor(E.resultTimeout.color)
      .setTitle(E.resultTimeout.title)
      .setDescription(E.resultTimeout.description({ body }))
      .setFooter({ text: finalFooter });
  }

  if (state === 'result_arena') {
    const room = opts.arenaChannelId ? `<#${opts.arenaChannelId}>` : E.resultArena.roomFallback;
    const ids = opts.userIds ?? vote.targets.map((t) => t.id);
    const results = ids.map((id) => E.resultArena.line({ id })).join('\n');
    return embed
      .setColor(E.resultArena.color)
      .setTitle(E.resultArena.title)
      .setDescription(E.resultArena.description({ room, results }))
      .setFooter({ text: finalFooter });
  }

  // cancelled / no action
  return embed
    .setColor(E.cancelled.color)
    .setTitle(E.cancelled.title)
    .setDescription(E.cancelled.description({ nameList }))
    .setFooter({ text: finalFooter });
}

// ─── Mod log ──────────────────────────────────────────────────────────────────

async function logMod(text, { pingRoleIds = [] } = {}) {
  console.log('[mod-log]', text); // mirror to terminal so events are visible even if the channel send fails
  if (!config.modLogChannelId) return;
  try {
    const ch = await client.channels.fetch(config.modLogChannelId);
    await ch.send({ content: text, allowedMentions: { parse: [], roles: pingRoleIds } });
  } catch (err) {
    console.error("mod-log post failed (can the bot view + send in that channel?):", err.message);
  }
}

// ─── Vote lifecycle ───────────────────────────────────────────────────────────

/** `send` posts the vote message and returns the resulting Message (so this works
 *  for both a chat phrase and a /vote reply). */
async function startVote({ guildId, channelId, starterId, members, send }) {
  const vote = {
    channelId,
    guildId,
    targets: members.map((m) => ({ id: m.id, tag: m.user.tag })),
    choices: new Map(), // userId -> 'timeout' | 'arena' | 'cancel'
    startedBy: starterId,
    createdAt: now(),
    timer: null,
  };

  const sent = await send({ embeds: [buildEmbed(vote, 'open')], components: [buildRow(false)] });
  vote.messageId = sent.id;
  vote.message = sent;
  vote.timer = setTimeout(() => resolveExpire(vote), mins(config.voteWindowMinutes));
  activeVote = vote;
  starterCooldowns.set(starterId, now());

  await logMod(messages.modLog.voteStarted({ starter: starterId, targets: vote.targets.map((t) => `<@${t.id}>`).join(' & ') }));
}

async function applyTimeoutsToIds(guild, ids, durationMin, reason) {
  const results = [];
  for (const id of ids) {
    try {
      const member = await guild.members.fetch(id);
      if (!canModerate(member)) {
        results.push({ id, ok: false, msg: 'no longer moderatable' });
        continue;
      }
      await member.timeout(mins(durationMin), reason);
      mutedCooldowns.set(id, now());
      results.push({ id, ok: true, until: now() + mins(durationMin) });
    } catch (err) {
      results.push({ id, ok: false, msg: err.message });
    }
  }
  return results;
}

async function resolveExpire(vote) {
  if (activeVote !== vote) return; // already resolved
  activeVote = null;

  const c = tally(vote);
  const total = vote.choices.size;
  const outcome = decide(c, total);
  const counts = `⛔ ${c.timeout} · 🥊 ${c.arena} · 🕊️ ${c.cancel}`;
  const who = vote.targets.map((t) => `<@${t.id}>`).join(', ');

  if (outcome === 'timeout') {
    const guild = await client.guilds.fetch(vote.guildId);
    vote.results = await applyTimeoutsToIds(
      guild,
      vote.targets.map((t) => t.id),
      config.durationMinutes,
      `Community vote (${counts})`,
    );
    lastPassAt = now();
    await vote.message.edit({ embeds: [buildEmbed(vote, 'result_timeout')], components: [buildRow(true)] }).catch(() => {});
    const summary = vote.results
      .map((r) => (r.ok ? messages.modLog.timeoutLine({ id: r.id }) : messages.modLog.timeoutFailed({ id: r.id, msg: r.msg })))
      .join('\n');
    await logMod(messages.modLog.warStopped({ summary, counts }));
  } else if (outcome === 'arena') {
    const res = await applyContainment(vote);
    lastPassAt = now();
    await vote.message
      .edit({
        embeds: [buildEmbed(vote, res ? 'result_arena' : 'cancelled', { arenaChannelId: res?.channelId, userIds: res?.userIds })],
        components: [buildRow(true)],
      })
      .catch(() => {});
    await logMod(
      res
        ? messages.modLog.arenaSent({ counts, users: res.userIds.map((id) => `<@${id}>`).join(', '), channelId: res.channelId })
        : messages.modLog.arenaFailed({ counts, who }),
    );
  } else {
    await vote.message.edit({ embeds: [buildEmbed(vote, 'cancelled')], components: [buildRow(true)] }).catch(() => {});
    await logMod(messages.modLog.spared({ counts, who }));
  }
}

// ─── Containment room ─────────────────────────────────────────────────────────

// Saved to disk so a restart resumes release timers AND restores any stripped roles
// (being stuck jailed, or losing roles, would both be worse than a lost vote).
const CONTAINMENT_STORE = new URL('./.containments.json', import.meta.url);

function saveContainments() {
  const data = [...activeContainments.values()].map(({ timer, ...rest }) => rest);
  try {
    writeFileSync(CONTAINMENT_STORE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save containment state:', err.message);
  }
}

function loadContainments() {
  if (!existsSync(CONTAINMENT_STORE)) return [];
  try {
    return JSON.parse(readFileSync(CONTAINMENT_STORE, 'utf8'));
  } catch {
    return [];
  }
}

async function applyContainment(vote) {
  const guild = await client.guilds.fetch(vote.guildId);

  if (!config.containedRoleId) {
    await logMod(messages.modLog.containNoRole);
    return null;
  }
  const role = await guild.roles.fetch(config.containedRoleId).catch(() => null);
  if (!role) {
    await logMod(messages.modLog.containRoleNotFound);
    return null;
  }

  const overwrites = [
    {
      // Spectators: the whole community can WATCH the match, but not type or open threads.
      id: guild.roles.everyone.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
    },
    {
      // The jailed fighters: can type (overrides the @everyone Send-deny), but no images/links.
      id: role.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages],
      deny: [PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
    },
    {
      id: client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
    },
    // Let configured mod roles watch and step in.
    ...config.modRoleIds.map((id) => ({
      id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    })),
  ];

  let channel;
  try {
    channel = await guild.channels.create({
      name: config.containmentChannelPrefix,
      type: ChannelType.GuildText,
      parent: config.containmentCategoryId || undefined,
      permissionOverwrites: overwrites,
      reason: 'Containment: close failed vote',
    });
  } catch (err) {
    await logMod(messages.modLog.containCreateFailed({ error: err.message }));
    return null;
  }

  const me = await guild.members.fetchMe();
  const userIds = [];
  const removed = {}; // userId -> [roleIds] we took away, to restore on release

  for (const t of vote.targets) {
    const member = await guild.members.fetch(t.id).catch(() => null);
    if (!member || isProtected(member)) continue;
    try {
      if (config.stripRolesOnContain) {
        // Roles the bot CAN'T remove (managed/integration, or at/above the bot) must be kept;
        // everything else is parked and restored on release. Apply jail + keepers in ONE
        // set() so adding the jail role and stripping the rest can't race (an add-then-remove
        // pair would have the remove overwrite the add).
        const keep = member.roles.cache.filter(
          (r) => r.id !== guild.id && (r.managed || me.roles.highest.comparePositionTo(r) <= 0),
        );
        removed[t.id] = member.roles.cache
          .filter((r) => r.id !== guild.id && !r.managed && me.roles.highest.comparePositionTo(r) > 0)
          .map((r) => r.id);
        await member.roles.set([...keep.keys(), role.id], 'Containment: jail + isolate');
      } else {
        await member.roles.add(role, 'Containment: close failed vote');
      }
      userIds.push(t.id);
    } catch (err) {
      console.error(`Containment role swap failed for ${t.id}:`, err.message);
    }
  }

  if (userIds.length === 0) {
    await channel.delete('Containment: nobody to contain').catch(() => {});
    return null;
  }

  for (const id of userIds) mutedCooldowns.set(id, now());

  const mentions = userIds.map((id) => `<@${id}>`).join(' ');
  const arenaEndsAt = Math.floor((now() + mins(config.containmentMinutes)) / 1000); // live countdown target
  const welcomeEmbed = new EmbedBuilder()
    .setColor(messages.embeds.arenaWelcome.color)
    .setTitle(messages.embeds.arenaWelcome.title)
    .setDescription(messages.embeds.arenaWelcome.description({ mentions, arenaEndsAt }));
  // content carries the mentions so the fighters actually get pinged (embed mentions don't notify).
  await channel.send({ content: mentions, embeds: [welcomeEmbed], allowedMentions: { users: userIds } });

  const releaseAt = now() + mins(config.containmentMinutes);
  const timer = setTimeout(() => releaseContainment(channel.id), mins(config.containmentMinutes));
  activeContainments.set(channel.id, {
    channelId: channel.id,
    guildId: guild.id,
    originChannelId: vote.channelId, // where the vote happened → where the "arena ended" message goes
    userIds,
    roleId: role.id,
    removed,
    releaseAt,
    postTimeoutMinutes: config.postArenaTimeoutMinutes,
    counts: tally(vote), // vote tallies, kept for the arena-close footer
    timer,
  });
  saveContainments();
  return { channelId: channel.id, userIds };
}

/** Release a room: restore roles, remove the jail role, delete the channel, and (on a natural
 *  release) apply the post-arena timeout. A mod `/release` passes applyPostTimeout:false to pardon. */
async function releaseContainment(channelId, { applyPostTimeout = true } = {}) {
  const c = activeContainments.get(channelId);
  if (!c) return;
  activeContainments.delete(channelId);
  clearTimeout(c.timer);

  const guild = await client.guilds.fetch(c.guildId).catch(() => null);
  if (guild) {
    for (const uid of c.userIds) {
      const member = await guild.members.fetch(uid).catch(() => null);
      if (!member) continue;
      await member.roles.remove(c.roleId, 'Released from the ring').catch(() => {});
      const restore = (c.removed?.[uid] ?? []).filter((id) => guild.roles.cache.has(id));
      if (restore.length)
        await member.roles
          .add(restore, 'Released — roles restored')
          .catch((e) => console.error('role restore failed:', e.message));
    }
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (ch) await ch.delete('Released from the ring').catch(() => {});

    if (applyPostTimeout && c.postTimeoutMinutes > 0 && c.userIds.length) {
      await applyTimeoutsToIds(guild, c.userIds, c.postTimeoutMinutes, 'Post-arena timeout');
      await logMod(messages.modLog.postArena({ users: c.userIds.map((id) => `<@${id}>`).join(', '), min: c.postTimeoutMinutes }));
    }

    // Public "arena ended" announcement, back in the channel where the vote happened (natural close only).
    if (applyPostTimeout && c.userIds.length && c.originChannelId) {
      const cnt = c.counts ?? { cancel: 0, timeout: 0, arena: 0 };
      const postEndsAt = Math.floor((now() + mins(c.postTimeoutMinutes)) / 1000);
      const postLines =
        c.postTimeoutMinutes > 0
          ? c.userIds.map((id) => messages.embeds.arenaClose.line({ id, postEndsAt })).join('\n') + '\n\n'
          : '';
      const closeEmbed = new EmbedBuilder()
        .setColor(messages.embeds.arenaClose.color)
        .setTitle(messages.embeds.arenaClose.title)
        .setDescription(messages.embeds.arenaClose.description({ postLines }))
        .setFooter({ text: messages.embeds.finalFooter({ cancel: cnt.cancel, timeout: cnt.timeout, arena: cnt.arena }) });
      const originCh = await guild.channels.fetch(c.originChannelId).catch(() => null);
      if (originCh) await originCh.send({ embeds: [closeEmbed] }).catch((e) => console.error('arena-close announce failed:', e.message));
    }
  }
  saveContainments();
  if (c.userIds.length)
    await logMod(messages.modLog.arenaClosed({ users: c.userIds.map((id) => `<@${id}>`).join(', ') }));
}

/** Release a single user; if their room empties, tear it down. */
async function releaseUser(userId) {
  for (const [channelId, c] of activeContainments) {
    if (!c.userIds.includes(userId)) continue;
    const guild = await client.guilds.fetch(c.guildId).catch(() => null);
    const member = guild && (await guild.members.fetch(userId).catch(() => null));
    if (member) {
      await member.roles.remove(c.roleId, 'Released by moderator').catch(() => {});
      const restore = (c.removed?.[userId] ?? []).filter((id) => guild.roles.cache.has(id));
      if (restore.length) await member.roles.add(restore, 'Released — roles restored').catch(() => {});
    }
    c.userIds = c.userIds.filter((id) => id !== userId);
    if (c.removed) delete c.removed[userId];
    if (c.userIds.length === 0) await releaseContainment(channelId, { applyPostTimeout: false });
    else saveContainments();
    return true;
  }
  return false;
}

// ─── Events ───────────────────────────────────────────────────────────────────

// Track who's talking (for auto-nomination). Reads message metadata only — no MessageContent.
client.on(Events.MessageCreate, (message) => {
  if (message.author.bot || !message.inGuild()) return;
  if (config.allowedChannelIds.length && !config.allowedChannelIds.includes(message.channelId)) return;
  recordActivity(message);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // ── Slash commands ──
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'dumplshelp') return handleVoteCommand(interaction);
    if (interaction.commandName === 'release') return handleReleaseCommand(interaction);
    return;
  }

  // ── Vote buttons ──
  if (!interaction.isButton()) return;

  const vote = activeVote;
  if (!vote || interaction.message.id !== vote.messageId) {
    await interaction.reply({ content: messages.ephemerals.voteClosed, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const choice = { vote_timeout: 'timeout', vote_arena: 'arena', vote_cancel: 'cancel' }[interaction.customId];
  if (!choice) return;

  const uid = interaction.user.id;
  if (vote.choices.get(uid) === choice) vote.choices.delete(uid); // press your choice again to undo
  else vote.choices.set(uid, choice);

  // No mid-vote firing — the winner is the highest tally when the timer ends (resolveExpire).
  await interaction.update({ embeds: [buildEmbed(vote, 'open')], components: [buildRow(false)] }).catch(() => {});
});

// ─── Slash command handlers ───────────────────────────────────────────────────

async function handleVoteCommand(interaction) {
  if (config.allowedChannelIds.length && !config.allowedChannelIds.includes(interaction.channelId)) {
    return interaction.reply({ content: messages.ephemerals.wrongChannel, flags: MessageFlags.Ephemeral });
  }

  const invoker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

  // Access: a mod can always start; otherwise the correct passcode is required.
  // votePasscode '' = gate off (auto open to all, as before).
  const passcodeRequired = Boolean(config.votePasscode);
  const passcode = interaction.options.getString('passcode')?.trim();
  const hasAccess = !passcodeRequired || isModerator(invoker) || passcode === config.votePasscode;
  if (!hasAccess) {
    if (passcode) await logMod(messages.modLog.wrongMagicWord({ user: interaction.user.id }));
    return interaction.reply({
      content: passcode ? messages.ephemerals.wrongPasscode : messages.ephemerals.needPasscode,
      flags: MessageFlags.Ephemeral,
    });
  }

  const guard = startGuard(interaction.user.id);
  if (!guard.ok) return interaction.reply({ content: guard.reason, flags: MessageFlags.Ephemeral });

  const seedIds = [];
  for (let i = 1; i <= config.maxTargets; i++) {
    const u = interaction.options.getUser(`user${i}`);
    if (u && u.id !== client.user.id && !u.bot && !seedIds.includes(u.id)) seedIds.push(u.id);
  }

  const modPing = config.modAlertRoleId ? `<@&${config.modAlertRoleId}> ` : '';
  const modPingRoleIds = config.modAlertRoleId ? [config.modAlertRoleId] : [];

  if (seedIds.length > 0 && !isModerator(invoker)) {
    await logMod(messages.modLog.nonModHandpick({ user: interaction.user.id, ping: modPing }), { pingRoleIds: modPingRoleIds });
    return interaction.reply({ content: messages.ephemerals.handpickByNonMod, flags: MessageFlags.Ephemeral });
  }

  const result = await nominate({ guild: interaction.guild, channelId: interaction.channelId, seedIds });
  if (!result.ok) {
    if (seedIds.length === 0)
      await logMod(messages.modLog.notEnoughBloodshed({ user: interaction.user.id, ping: modPing }), { pingRoleIds: modPingRoleIds });
    return interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
  }

  await startVote({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    starterId: interaction.user.id,
    members: result.members,
    // Ack privately so "X used /dumplshelp" never shows; post the vote as a plain bot message.
    send: async (payload) => {
      await interaction.reply({ content: messages.ephemerals.votePosted, flags: MessageFlags.Ephemeral });
      return interaction.channel.send(payload);
    },
  });
}

async function handleReleaseCommand(interaction) {
  const invoker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!isModerator(invoker)) {
    return interaction.reply({ content: messages.ephemerals.releaseNonMod, flags: MessageFlags.Ephemeral });
  }
  const user = interaction.options.getUser('user', true);
  const released = await releaseUser(user.id);
  return interaction.reply({
    content: released ? messages.ephemerals.released({ id: user.id }) : messages.ephemerals.notInRoom({ id: user.id }),
    flags: MessageFlags.Ephemeral,
  });
}

// ─── Slash command registration ───────────────────────────────────────────────

const voteCommand = {
  name: 'dumplshelp',
  description: messages.commands.dumplshelp,
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'passcode',
      description: messages.commands.passcodeOption,
      required: false,
    },
    ...Array.from({ length: config.maxTargets }, (_, i) => ({
      type: ApplicationCommandOptionType.User,
      name: `user${i + 1}`,
      description: messages.commands.targetOption(i + 1),
      required: false,
    })),
  ],
};

const releaseCommand = {
  name: 'release',
  description: messages.commands.release,
  options: [
    { type: ApplicationCommandOptionType.User, name: 'user', description: messages.commands.releaseUserOption, required: true },
  ],
};

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) {
    try {
      await guild.commands.set([voteCommand, releaseCommand]);
      console.log(`Registered /dumplshelp and /release in ${guild.name}`);
    } catch (err) {
      console.error(`Command registration failed for ${guild.id}:`, err.message);
    }
  }

  // Resume containments saved before a restart, so timers continue and stripped roles
  // always come back (anything already overdue is released immediately).
  for (const saved of loadContainments()) {
    const remaining = saved.releaseAt - now();
    if (remaining <= 0) {
      activeContainments.set(saved.channelId, { ...saved, timer: null });
      await releaseContainment(saved.channelId);
    } else {
      const timer = setTimeout(() => releaseContainment(saved.channelId), remaining);
      activeContainments.set(saved.channelId, { ...saved, timer });
      console.log(`Resumed containment ${saved.channelId}; releasing in ${Math.round(remaining / 1000)}s`);
    }
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Set it as an env var or pass --env-file=.env');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
