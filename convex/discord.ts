import { WithoutSystemFields } from "convex/server";
import { Doc, Id, TableNames } from "./_generated/dataModel";
import {
  mutation,
  internalMutation,
  DatabaseWriter,
  MutationCtx,
} from "./_generated/server";
import { Channels, Messages, Threads, Users } from "./schema";
import { v } from "convex/values";
import { Channel, ThreadChannel } from "discord.js";

type DiscordRelatedTables = "users" | "channels" | "threads" | "messages";
const getOrCreate = async <TableName extends DiscordRelatedTables>(
  db: DatabaseWriter,
  table: TableName,
  doc: WithoutSystemFields<Doc<TableName>>
) => {
  const existing = await db
    .query(table)
    // types seem to bail, but all of them have an id index by other typing.
    .withIndex("id", (q) => q.eq("id", doc.id as any))
    .unique();
  if (existing) {
    return existing._id;
  }
  return await db.insert(table, doc);
};

const touchThread = async (
  { db }: { db: DatabaseWriter },
  { threadId }: { threadId: Id<"threads"> }
) => {
  // Get maximum version from any thread.
  const mostRecent = await db
    .query("threads")
    .withIndex("version")
    .order("desc")
    .first();
  const nextVersion = (mostRecent?.version ?? 0) + 1;
  await db.patch(threadId, { version: nextVersion });
};

export const addUniqueDoc = internalMutation({
  handler: async <TableName extends DiscordRelatedTables>(
    { db }: MutationCtx,
    {
      table,
      doc,
    }: {
      table: TableName;
      doc: WithoutSystemFields<Doc<TableName>>;
    }
  ) => {
    return await getOrCreate(db, table, doc);
  },
});

export const forceRefreshVersions = internalMutation({
  args: {},
  handler: async ({ db }, {}) => {
    const ids = (await db.query("threads").collect()).map((d) => d._id);
    for (const threadId of ids) {
      await touchThread({ db }, { threadId });
    }
  },
});

export const addThreadBatch = internalMutation(
  async (
    { db },
    {
      authorsAndMessagesToAdd,
    }: {
      authorsAndMessagesToAdd: [
        WithoutSystemFields<Doc<"users">>,
        WithoutSystemFields<Doc<"messages">>
      ][];
    }
  ) => {
    for (const [author, message] of authorsAndMessagesToAdd) {
      const authorId = await getOrCreate(db, "users", author);
      await getOrCreate(db, "messages", { ...message, authorId });
    }
  }
);

const {
  authorId: _,
  channelId: __,
  threadId: ___,
  ...MessageWithoutIds
} = Messages.withoutSystemFields;
const { channelId: ____, ...threadWithoutChannelId } =
  Threads.withoutSystemFields;

export const receiveMessage = mutation({
  args: {
    author: v.object(Users.withoutSystemFields),
    message: v.object(MessageWithoutIds),
    channel: v.object(Channels.withoutSystemFields),
    thread: v.object(threadWithoutChannelId),
  },
  handler: async ({ db, scheduler }, { author, message, channel, thread }) => {
    const authorId = await getOrCreate(db, "users", author);
    const channelId = await getOrCreate(db, "channels", channel);
    const dbChannel = (await db.get(channelId))!;
    let dbThread, threadId;
    if (thread) {
      threadId = await getOrCreate(db, "threads", { ...thread, channelId });
      await touchThread({ db }, { threadId });
      dbThread = (await db.get(threadId))!;
    }
    const messageId = await getOrCreate(db, "messages", {
      ...message,
      authorId,
      channelId,
      threadId,
    });

    //TODO: handle message type USER_JOIN
    if (
      // 0: DEFAULT 19: REPLY
      (message.type === 0 || message.type === 19) &&
      dbChannel.slackChannelId
    ) {
      scheduler.runAfter(0, "actions/slack:sendMessage", {
        messageId,
        threadId,
        author: {
          name: author.displayName,
          username: author.username,
          avatarUrl: author.displayAvatarURL || (author.avatarURL ?? undefined),
        },
        text: message.cleanContent,
        channel: dbChannel.slackChannelId,
        channelName: dbChannel.name,
        threadTs: dbThread?.slackThreadTs,
        title: dbThread?.name,
        linkUrl: makeLinkUrl(dbThread),
        emojis: dbThread?.appliedTags
          .map(
            (tagId) =>
              dbChannel.availableTags?.find((t) => t.id === tagId)?.emoji?.name
          )
          .filter((e) => e) as string[],
      });
    }
  },
});

function makeLinkUrl(dbThread: Doc<"threads"> | undefined) {
  return dbThread
    ? `https://discord.com/channels/${dbThread.guildId}/${dbThread.id}`
    : undefined;
}

export const updateMessage = mutation({
  args: {
    previous: v.object(MessageWithoutIds),
    message: v.object(MessageWithoutIds),
  },
  handler: async ({ db, scheduler }, { previous, message }) => {
    const existing = await db
      .query("messages")
      .withIndex("id", (q) => q.eq("id", previous.id ?? message.id))
      .unique();
    if (!existing) return;
    const { authorId, channelId, threadId } = existing;
    let dbThread;
    if (threadId) {
      await touchThread({ db }, { threadId });
      dbThread = await db.get(threadId);
      if (!dbThread) {
        throw new Error("Thread not found:" + threadId);
      }
    }
    // Overwrite authorId & channelId
    await db.patch(existing._id, { ...message, authorId, channelId });
    const channel = await db.get(channelId);
    const author = await db.get(authorId);
    if (!channel || !author) {
      throw new Error("Channel or author not found:" + channelId + authorId);
    }
    if (channel.slackChannelId && existing.slackTs) {
      scheduler.runAfter(0, "actions/slack:updateMessage", {
        messageTs: existing.slackTs,
        channel: channel.slackChannelId,
        text: message.cleanContent,
        author: {
          name: author.displayName,
          username: author.username,
          avatarUrl: (author.displayAvatarURL || author.avatarURL) ?? undefined,
        },
      });
    }
  },
});

export const deleteMessage = mutation({
  args: MessageWithoutIds,
  handler: async ({ db, scheduler }, message) => {
    const existing = await db
      .query("messages")
      .withIndex("id", (q) => q.eq("id", message.id))
      .unique();
    if (!existing) return;
    await db.patch(existing._id, { deleted: true });
    const { threadId } = existing;
    if (threadId) {
      await touchThread({ db }, { threadId });
    }
    const channel = await db.get(existing.channelId);
    if (!channel) throw new Error("Channel not found:" + existing.channelId);
    if (channel.slackChannelId && existing.slackTs) {
      scheduler.runAfter(0, "actions/slack:deleteMessage", {
        messageTs: existing.slackTs,
        channel: channel.slackChannelId,
      });
    }
  },
});

export const updateThread = mutation({
  args: {
    previous: v.object(threadWithoutChannelId),
    thread: v.object(threadWithoutChannelId),
  },
  handler: async ({ db, scheduler }, { previous, thread }) => {
    const existing = await db
      .query("threads")
      .withIndex("id", (q) => q.eq("id", previous.id ?? thread.id))
      .unique();
    if (!existing) return;
    await touchThread({ db }, { threadId: existing._id });
    await db.patch(existing._id, thread);
    const channel = await db.get(existing.channelId);
    if (!channel) throw new Error("Channel not found:" + existing.channelId);
    if (channel.slackChannelId && existing.slackThreadTs) {
      scheduler.runAfter(0, "actions/slack:updateThread", {
        channel: channel.slackChannelId,
        threadTs: existing.slackThreadTs,
        title: thread.name,
        linkUrl: makeLinkUrl(existing),
        channelName: channel.name,
        emojis:
          (thread.appliedTags
            ?.map(
              (tagId) =>
                channel.availableTags?.find((t) => t.id === tagId)?.emoji?.name
            )
            .filter((e) => e) as string[]) ?? [],
      });
    }
  },
});

// TODO: make generic and look up dynamically
const ResolvedTagId = "1088163249410818230";

export const resolveThread = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async ({ db, scheduler }, { threadId }) => {
    const thread = await db.get(threadId);
    if (!thread) {
      throw "Not a thread";
    }
    if (thread.appliedTags.indexOf(ResolvedTagId) !== -1) {
      console.log("Tag already applied, refusing to apply");
      return;
    }
    if (!thread.channelId) {
      throw "No channel associated with the thread";
    }
    const channel = await db.get(thread.channelId);
    if (!channel) throw new Error("Channel not found:" + thread.channelId);
    if (!channel.availableTags?.find((t) => t.id === ResolvedTagId)) {
      console.log("Tag not found, refusing to apply");
      return;
    }
    const tags = [...thread.appliedTags, ResolvedTagId];
    await db.patch(threadId, {
      appliedTags: tags,
    });
    await touchThread({ db }, { threadId });
    scheduler.runAfter(0, "actions/discord:applyTags", {
      threadId: thread.id,
      tags,
    });
  },
});
