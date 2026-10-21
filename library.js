'use strict';

const db = require.main.require('./src/database');
const topics = require.main.require('./src/topics');
const user = require.main.require('./src/user');
const posts = require.main.require('./src/posts');
const privileges = require.main.require('./src/privileges');
const notifications = require.main.require('./src/notifications');
const SocketPlugins = require.main.require('./src/socket.io/plugins');
const translator = require.main.require('./src/translator');

const Plugin = module.exports;

const followersKey = pid => `post-follow:pid:${pid}:followers`;
const userPostsKey = uid => `post-follow:uid:${uid}:pids`;

Plugin.init = async function () {
	SocketPlugins.postFollow = {};

	// Toggle following of a single post. Returns the new state.
	SocketPlugins.postFollow.toggle = async function (socket, data) {
		if (!socket.uid) {
			throw new Error('[[error:not-logged-in]]');
		}
		const pid = data && parseInt(data.pid, 10);
		if (!pid) {
			throw new Error('[[error:invalid-data]]');
		}
		const [exists, canRead] = await Promise.all([
			posts.exists(pid),
			privileges.posts.can('topics:read', pid, socket.uid),
		]);
		if (!exists) {
			throw new Error('[[error:no-post]]');
		}
		if (!canRead) {
			throw new Error('[[error:no-privileges]]');
		}

		const isFollowing = await db.isSetMember(followersKey(pid), socket.uid);
		if (isFollowing) {
			await Promise.all([
				db.setRemove(followersKey(pid), socket.uid),
				db.sortedSetRemove(userPostsKey(socket.uid), pid),
			]);
		} else {
			await Promise.all([
				db.setAdd(followersKey(pid), socket.uid),
				db.sortedSetAdd(userPostsKey(socket.uid), Date.now(), pid),
			]);
		}
		return { following: !isFollowing };
	};
};

// Adds the "follow this post" entry to the three-dots menu of every post.
Plugin.addPostTool = async function (data) {
	if (!data.uid || (data.post && data.post.deleted)) {
		return data;
	}
	const isFollowing = await db.isSetMember(followersKey(data.pid), data.uid);
	data.tools.push({
		action: 'post/follow-post',
		html: isFollowing ? '[[post-follow:unfollow-post]]' : '[[post-follow:follow-post]]',
		icon: isFollowing ? 'fa-bell-slash' : 'fa-bell',
	});
	return data;
};

// Notifies followers of a single post when its content was edited.
Plugin.onPostEdit = async function (hookData) {
	const { post, uid: editorUid } = hookData;
	if (!post || !post.pid || !post.changed) {
		return;
	}

	let followers = await db.getSetMembers(followersKey(post.pid));
	followers = followers.filter(followerUid => String(followerUid) !== String(editorUid));
	if (!followers.length) {
		return;
	}

	const tid = post.tid || (post.topic && post.topic.tid);
	followers = await privileges.topics.filterUids('topics:read', tid, followers);
	if (!followers.length) {
		return;
	}

	const [displayName, title] = await Promise.all([
		user.getNotificationDisplayname(editorUid),
		topics.getNotificationTitle(tid),
	]);

	const notification = await notifications.create({
		type: 'post-follow-edit',
		subject: title,
		bodyShort: translator.compile('post-follow:notification-edited', displayName, title),
		bodyLong: String(post.newContent || post.content || '').slice(0, 255),
		nid: `post-follow:edit:${post.pid}:uid:${editorUid}`,
		pid: post.pid,
		tid: tid,
		path: `/post/${encodeURIComponent(post.pid)}`,
		from: editorUid,
		topicTitle: title,
	});
	if (notification) {
		notifications.push(notification, followers);
	}
};

// Cleans up follow data of permanently deleted posts.
Plugin.onPostsPurge = async function (hookData) {
	const purged = (hookData && hookData.posts) || [];
	await Promise.all(purged.map(async (post) => {
		const followers = await db.getSetMembers(followersKey(post.pid));
		await Promise.all([
			db.delete(followersKey(post.pid)),
			...followers.map(followerUid => db.sortedSetRemove(userPostsKey(followerUid), post.pid)),
		]);
	}));
};
