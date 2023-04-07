# Discord Slack Bridge with Convex

Sync messages & threads from Discord into Slack.
It will keep Discord threads in Slack

## Installation

### 1. Convex backend

To run it against your own backend, `rm convex.json` first.
```
npx convex init
npx convex deploy
```
Copy the deployment URL for later (it should end with ".convex.cloud").

### 2. Discord Bot

1. Create a bot and authorize it, adding it to your server / guild.
2. Copy the token and save it in the environment variables in the dashboard
 with the key TOKEN. `npx convex dashboard` to get there.

### 3. Slack Bot

1. Create a slack bot and install it into your workspace.
2. Copy the bot oauth token and save it in the convex environment variables as
 SLACK_TOKEN.

### 4. discordBot.js on fly.io

Deploy the discordBot.js to fly.io:

1. Install flyctl, e.g. `brew install flyctl`
2. Deploy it the first time with `fly launch`, then `fly deploy` after.

3. Set the environment variables for it with:
flyctl secrets set TOKEN=<discord-token>
flyctl secrets set CONVEX_URL=<deployment-URL>

I just chose one instance in sjc, on the smallest (free) tier.
I did have to enter my CC info, but it hasn't been charged.

### 5. Mapping Discord channels to Slack

Once messages are coming in, you'll see the channels listed in the Convex
dashboard. You can edit a given channel and add `slackChannelId: "C0123456ABC"`
for your corresponding slack channel IDs. Then, new messages will get posted to
Slack. Hooray!

## Backfill

You can backfill a discord channel by copying the channel ID and going to the
Convex dashboard, going to the "functions" section, and finding
actions / discord / backfillDiscordChannel .
Run it with a single parameter: `{ discordId: "1111111111111111111" }`
replacing the 1's with your discord ID.

Tip: In discord you can right-click various things and click "Copy ID"

## Debugging

- You can look at your discordBot.js logs in the fly.io dashboard under monitoring.
- You can see your convex functions in the convex dashboard under Logs
- You might run into issues where your bots need extra permissions and you need
to re-install them into the workspace / guild to get the right oauth token.
- The discord bot doesn't catch updates to messages sent before it started
up, but going forward, message updates / deletes should be sent along to slack.
There's a `discord-logs` npm package that adds more events we could listen to
in discordBot.js, maybe `unhandledMessageUpdate` would be useful?
If you do that, send a PR please 🙏.

## Extras

It has some code to handle slash commands, interactions, etc.
To do this, set the URL in slack to be
"https://<project-slug>.convex.site/slack/slash" for slash commands, or
"https://<project-slug>.convex.site/slack/interactivity" for interactions.
The slug is the part of the url in your deployment URL before `convex.cloud`.
E.g. https://happy-iguana-123.convex.site/slack/slash .
Notice the `.convex.site`! This is the http handlers, defined in convex/http.js.

Currently I have two shortcuts configured from slack: resolve & reply,
configured as "message" shortcuts. So you can right-click a message and send a
reply to Discord.

- For resolve, you'll need to update the code to pass the
right Tag ID. For us, we have a tag in our support channel for "Resolved".
- For reply, you can add your `slackUserId: "U01234ABCDE",` in the `users`
table. It won't reply as you, but it'll tag you in the reply.

Tip: you can get all your slack users & ids by running:
```
$ node

const token = <your slack token>;
const {WebClient} = require('@slack/web-api');
const web = new WebClient(token);
const users = await web.users.list();
users.members.map(m => `${m.real_name || m.name}: ${m.id}`)
```

There isn't bidirectional syncing - sending slack messages don't go to Discord.
They could, but we find it's better to chat in slack between coworkers, and
then go and message in Discord directly (which gets synced to slack).