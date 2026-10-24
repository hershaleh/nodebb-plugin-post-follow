<div align="right">

**English** | [עברית](README.he.md)

</div>

# nodebb-plugin-post-follow

Follow a **single post** instead of a whole topic, and get notified only when that post is edited, deleted or restored.

## Features

- **Bell button next to the reply button** of every post (icon only). Click it to follow or unfollow the post. A short toast confirms the change; nothing is added to the notifications list.
- **Per-post settings.** While a post is followed, a small arrow appears next to the bell. It opens a menu where you choose any combination of: *Follow edits*, *Follow deletion*, *Follow restoration* (at least one must stay selected; new follows start with edits only).
- **"Posts I follow" page** in your profile (visible only to you), with the same bell and settings on every item.
- **Follow automatically**, from your account settings: posts you write, posts you reply to or quote, and posts you bookmark, with a choice of events.
- **Manage your list.** Filter the followed-posts page by category or topic title, see which posts were deleted or whose topic is deleted or locked, and use *Unfollow all* or *Unfollow deleted / locked*.
- **No notification pile-up.** While a notification about the same post and event is still unread, no new one is sent to that user.
- **Separate notification type.** Users get a "When a post I follow is edited, deleted or restored" row in their notification settings, where they can choose on-site, email, both or none.
- **Follow limit.** Admins cap how many posts one user can follow (default: 500, 0 = unlimited) in *ACP → Plugins → Post Follow*; a question-mark bubble next to the setting explains why. Groups can be exempted from the limit. Existing follows are never removed.
- **Ignore tiny edits.** Admins set a minimum edit size in *ACP → Plugins → Post Follow*. Edits that change fewer characters (default: 3) do not notify followers. Set 0 to notify about every edit.

The editor never notifies themselves, and followers who can no longer read the topic are skipped. Follow data is removed when a post is permanently deleted or when the user is deleted.

Unlike topic watching, you are not notified about replies or about other posts in the topic.

### Interaction with topic watching

NodeBB core already sends an edit notification to everyone who watches the whole topic. To avoid duplicates, this plugin skips *edit* notifications for users who:

- watch the topic **and**
- have the core "When a post is edited in a watched topic" notification type enabled.

A user who watches the topic but turned that notification type off, or who does not watch the topic at all, still receives this plugin's notifications for the posts they explicitly follow. This is what makes "all replies in the topic, plus edits of this one post" possible. Deletion and restoration notifications are only sent by this plugin, so they are never skipped.

## Installation

The plugin is not published on npm. Install it straight from GitHub:

```bash
cd /path/to/nodebb
npm install github:hershaleh/nodebb-plugin-post-follow
```

Then activate it in the ACP (Extend → Plugins) and rebuild and restart NodeBB:

```bash
./nodebb build
./nodebb restart
```

## Compatibility

Written for NodeBB 4.x (checked against the 4.16 source) and the Bootstrap 5 based default theme (Harmony). The bell button is added to the post actions bar next to the reply button.

## Languages

`en-GB` and `he` are included. Other languages fall back to English.

## License

MIT
