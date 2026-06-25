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
} from 'discord.js';
import config from './config.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — enable it in the Dev Portal
  ],
});

// ─── State (in memory — a restart clears all of this) ─────────────────────────

const activity = new Map(); // channelId -> [{ userId, ts }]   rolling "who's talking"
let activeVote = null; // the single in-flight vote, or null
const starterCooldowns = new Map(); // userId -> ms timestamp of their last started vote
const mutedCooldowns = new Map(); // userId -> ms timestamp of when they were last muted
let lastPassAt = 0; // ms timestamp of the last successful timeout (global grace)

// ─── Small helpers ────────────────────────────────────────────────────────────

const now = () => Date.now();
const mins = (m) => m * 60_000;

/** Format milliseconds as M:SS. */
function fmt(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A member who must never be put up for a vote. */
function isProtected(member) {
  if (!member || member.user.bot) return true;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(PermissionFlagsBits.ModerateMembers)) return true;
  return config.protectedRoleIds.some((r) => member.roles.cache.has(r));
}

/** The bot can actually time this member out (hierarchy + perms) and they're not protected. */
function canModerate(member) {
  return Boolean(member) && member.moderatable && !isProtected(member);
}

function onMuteCooldown(userId) {
  const last = mutedCooldowns.get(userId);
  return Boolean(last) && now() - last < mins(config.userRetargetCooldownMinutes);
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

/** Pick two eligible members. Returns { ok, members } or { ok:false, reason }. */
async function nominate(message) {
  const guild = message.guild;

  // Manual seeds: explicit user mentions win over auto-selection.
  const seeds = [...message.mentions.users.values()]
    .filter((u) => u.id !== client.user.id && !u.bot)
    .slice(0, 2)
    .map((u) => u.id);

  // An explicitly named, protected/cooldown member aborts the whole vote — we
  // don't silently swap them out, because the user asked for them by name.
  for (const id of seeds) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member) return { ok: false, reason: `I couldn't find <@${id}> in this server.` };
    if (isProtected(member) || !member.moderatable)
      return { ok: false, reason: `<@${id}> can't be put up for a vote (protected or ranked above me).` };
    if (onMuteCooldown(id)) return { ok: false, reason: `<@${id}> was just timed out — on cooldown.` };
  }

  // Fill remaining slots from the most-active recent talkers.
  const chosen = [...seeds];
  for (const id of topTalkers(message.channelId)) {
    if (chosen.length === 2) break;
    if (chosen.includes(id) || onMuteCooldown(id)) continue;
    const member = await guild.members.fetch(id).catch(() => null);
    if (canModerate(member)) chosen.push(id);
  }

  if (chosen.length < 2)
    return {
      ok: false,
      reason: `Not enough recent activity to pick two people. Mention two members instead, e.g. \`${config.triggerPhrase} @userA @userB\`.`,
    };

  const members = [];
  for (const id of chosen) {
    const m = await guild.members.fetch(id).catch(() => null);
    if (m) members.push(m);
  }
  if (members.length < 2) return { ok: false, reason: 'Could not resolve both members — try again.' };

  return { ok: true, members };
}

// ─── Embed + buttons ──────────────────────────────────────────────────────────

function buildRow(disabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vote_yes').setLabel('Yes').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('vote_no').setLabel('No').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function buildEmbed(vote, state) {
  const yes = vote.yes.size;
  const no = vote.no.size;
  const net = yes - no;
  const voters = yes + no;
  const names = vote.targets.map((t) => `<@${t.id}>`).join(' and ');

  const embed = new EmbedBuilder().addFields(
    { name: '✅ Yes', value: String(yes), inline: true },
    { name: '❌ No', value: String(no), inline: true },
    { name: 'Net', value: `${net >= 0 ? '+' : ''}${net} / +${config.threshold}`, inline: true },
  );

  if (state === 'open') {
    const left = vote.createdAt + mins(config.voteWindowMinutes) - now();
    return embed
      .setColor(0x5865f2)
      .setTitle('🗳️ Community Timeout Vote')
      .setDescription(
        `Time out ${names} for **${config.durationMinutes} min**?\n` +
          'Press **Yes** or **No** below. Press your choice again to remove your vote.',
      )
      .setFooter({ text: `${voters}/${config.quorum} voters needed · ${fmt(left)} left` });
  }

  if (state === 'passed') {
    const lines = (vote.results ?? [])
      .map((r) =>
        r.ok
          ? `✅ <@${r.id}> timed out for ${config.durationMinutes} min`
          : `⚠️ <@${r.id}> — not timed out (${r.msg})`,
      )
      .join('\n');
    return embed
      .setColor(0xed4245)
      .setTitle('✅ Vote Passed')
      .setDescription(lines || `Timed out ${names}.`)
      .setFooter({ text: `Final: ${yes} yes / ${no} no` });
  }

  // failed / expired
  return embed
    .setColor(0x99aab5)
    .setTitle('❌ Vote Did Not Pass')
    .setDescription(`No timeout applied to ${names}.`)
    .setFooter({ text: `Final: ${yes} yes / ${no} no` });
}

// ─── Mod log ──────────────────────────────────────────────────────────────────

async function logMod(text) {
  if (!config.modLogChannelId) return;
  try {
    const ch = await client.channels.fetch(config.modLogChannelId);
    await ch.send({ content: text, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('mod-log failed:', err.message);
  }
}

// ─── Vote lifecycle ───────────────────────────────────────────────────────────

async function startVote(message, members) {
  const vote = {
    channelId: message.channelId,
    guildId: message.guildId,
    targets: members.map((m) => ({ id: m.id, tag: m.user.tag })),
    yes: new Set(),
    no: new Set(),
    startedBy: message.author.id,
    createdAt: now(),
    timer: null,
  };

  const sent = await message.channel.send({
    embeds: [buildEmbed(vote, 'open')],
    components: [buildRow(false)],
  });
  vote.messageId = sent.id;
  vote.message = sent;
  vote.timer = setTimeout(() => resolveExpire(vote), mins(config.voteWindowMinutes));
  activeVote = vote;

  await logMod(
    `🗳️ Vote started by <@${message.author.id}> on ${vote.targets.map((t) => `<@${t.id}>`).join(' & ')}.`,
  );
}

async function applyTimeouts(vote) {
  const guild = await client.guilds.fetch(vote.guildId);
  const reason = `Community vote (${vote.yes.size} yes / ${vote.no.size} no)`;
  const results = [];
  for (const t of vote.targets) {
    try {
      const member = await guild.members.fetch(t.id);
      if (!canModerate(member)) {
        results.push({ id: t.id, ok: false, msg: 'no longer moderatable' });
        continue;
      }
      await member.timeout(mins(config.durationMinutes), reason);
      mutedCooldowns.set(t.id, now());
      results.push({ id: t.id, ok: true });
    } catch (err) {
      results.push({ id: t.id, ok: false, msg: err.message });
    }
  }
  return results;
}

async function resolveExpire(vote) {
  if (activeVote !== vote) return; // already resolved by a passing vote
  activeVote = null;
  await vote.message
    .edit({ embeds: [buildEmbed(vote, 'failed')], components: [buildRow(true)] })
    .catch(() => {});
  await logMod(
    `🕊️ Vote on ${vote.targets.map((t) => `<@${t.id}>`).join(' & ')} expired (${vote.yes.size} yes / ${vote.no.size} no).`,
  );
}

// ─── Events ───────────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild()) return;
  if (config.allowedChannelIds.length && !config.allowedChannelIds.includes(message.channelId)) return;

  recordActivity(message);

  if (!message.content.toLowerCase().includes(config.triggerPhrase.toLowerCase())) return;

  if (activeVote) {
    await message.reply('A timeout vote is already in progress.').catch(() => {});
    return;
  }
  if (now() - lastPassAt < mins(config.retargetCooldownMinutes)) return; // post-pass grace
  const last = starterCooldowns.get(message.author.id);
  if (last && now() - last < mins(config.starterCooldownMinutes)) return; // per-starter cooldown

  const result = await nominate(message);
  if (!result.ok) {
    await message.reply({ content: result.reason, allowedMentions: { parse: [] } }).catch(() => {});
    return;
  }

  starterCooldowns.set(message.author.id, now());
  await startVote(message, result.members);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const vote = activeVote;
  if (!vote || interaction.message.id !== vote.messageId) {
    await interaction.reply({ content: 'This vote is already closed.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const uid = interaction.user.id;
  if (interaction.customId === 'vote_yes') {
    if (vote.yes.has(uid)) vote.yes.delete(uid);
    else {
      vote.yes.add(uid);
      vote.no.delete(uid);
    }
  } else if (interaction.customId === 'vote_no') {
    if (vote.no.has(uid)) vote.no.delete(uid);
    else {
      vote.no.add(uid);
      vote.yes.delete(uid);
    }
  } else {
    return;
  }

  const yes = vote.yes.size;
  const no = vote.no.size;
  const pass = yes - no >= config.threshold && yes + no >= config.quorum;

  if (!pass) {
    await interaction.update({ embeds: [buildEmbed(vote, 'open')], components: [buildRow(false)] }).catch(() => {});
    return;
  }

  // Passed — close synchronously *before* any await so a second click that's
  // already queued sees a closed vote and can't double-fire the timeouts.
  clearTimeout(vote.timer);
  activeVote = null;
  lastPassAt = now();

  await interaction.update({ embeds: [buildEmbed(vote, 'open')], components: [buildRow(true)] }).catch(() => {});
  vote.results = await applyTimeouts(vote);
  await vote.message.edit({ embeds: [buildEmbed(vote, 'passed')], components: [buildRow(true)] }).catch(() => {});

  const summary = vote.results
    .map((r) => (r.ok ? `timed out <@${r.id}>` : `failed on <@${r.id}> (${r.msg})`))
    .join(', ');
  await logMod(`🔨 Vote passed (${yes} yes / ${no} no) — ${summary}.`);
});

client.once(Events.ClientReady, (c) => console.log(`Logged in as ${c.user.tag}`));

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Set it as an env var or pass --env-file=.env');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
