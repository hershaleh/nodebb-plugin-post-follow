<div align="right">

**English** | [עברית](README.he.md)

</div>

# nodebb-plugin-post-follow

Follow a **single post** instead of a whole topic, and get notified only when that post is edited.

## How it works

- Adds a **"Follow this post"** item to the three-dots menu of every post. Once followed, the item becomes **"Unfollow this post"**.
- When a followed post's content is edited, every follower gets a notification that links straight to that post.
- The editor never notifies themselves, and followers who can no longer read the topic are skipped.
- Follow data is removed when a post is permanently deleted.

Unlike topic watching, you are not notified about replies or about edits to other posts in the topic.

### Interaction with topic watching

NodeBB core already sends an edit notification to everyone who watches the whole topic. To avoid duplicates, this plugin skips users who:

- watch the topic **and**
- have the core "When a post is edited in a watched topic" notification type enabled.

A user who watches the topic but turned that notification type off, or who does not watch the topic at all, still receives the notifications of this plugin for the posts they explicitly follow. This is what makes "all replies in the topic, plus edits of this one post" possible.

## Installation

```bash
npm install nodebb-plugin-post-follow
```

Or, from a git checkout:

```bash
cd /path/to/nodebb
npm install /path/to/nodebb-plugin-post-follow
```

Then activate the plugin in the ACP (Extend → Plugins) and rebuild/restart NodeBB.

## Compatibility

Written for NodeBB 4.x (checked against the 4.16 source).

## Languages

`en-GB` and `he` are included. Other languages fall back to English.

## License

MIT
