# nodebb-plugin-post-follow

Follow a **single post** instead of a whole topic, and get a notification only when that post is edited.

## How it works

- Adds a **"Follow this post"** item (Hebrew: "עקוב אחר פוסט זה") to the three-dots menu of every post.
- When the item is toggled, the menu label switches to **"Unfollow this post"**.
- When a followed post's content is edited, every follower gets a notification linking straight to that post.
- The editor never notifies themselves, and followers who can no longer read the topic are skipped.
- Follow data is removed when a post is permanently deleted.

Unlike topic watching, you are not notified about replies or about edits to other posts in the topic.

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

Written for NodeBB 4.x (tested against the 4.16 source).

## Languages

`en-GB` and `he` are included. Other languages fall back to English.

## License

MIT
