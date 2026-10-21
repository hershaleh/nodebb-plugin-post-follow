'use strict';

const validator = require.main.require('validator');
const winston = require.main.require('winston');

const db = require.main.require('./src/database');
const meta = require.main.require('./src/meta');
const topics = require.main.require('./src/topics');
const user = require.main.require('./src/user');
const posts = require.main.require('./src/posts');
const utils = require.main.require('./src/utils');
const privileges = require.main.require('./src/privileges');
const notifications = require.main.require('./src/notifications');
const pagination = require.main.require('./src/pagination');
const translator = require.main.require('./src/translator');
const controllerHelpers = require.main.require('./src/controllers/helpers');
const routeHelpers = require.main.require('./src/routes/helpers');
const SocketPlugins = require.main.require('./src/socket.io/plugins');

const Plugin = module.exports;

const EVENTS = ['edit', 'delete', 'restore'];
const DEFAULT_PREFS = Object.freeze({ edit: true, delete: false, restore: false });
const NOTIFICATION_KEYS = { edit: 'edited', delete: 'deleted', restore: 'restored' };
const SETTINGS_HASH = 'post-follow';
const NOTIFICATION_TYPE = 'post-follow';
const DEFAULT_MIN_EDIT_CHARS = 3;
const DEFAULT_MAX_FOLLOWED_POSTS = 500;
const MAX_PIDS_PER_QUERY = 200;

const AUTO_FOLLOW_FIELDS = {
	enabled: 'postFollowAuto',
	edit: 'postFollowAutoEdit',
	delete: 'postFollowAutoDelete',
	restore: 'postFollowAutoRestore',
};

// Data model:
//   post-follow:pid:<pid>:followers   set         uids that follow the post
//   post-follow:uid:<uid>:pids        sorted set  pids followed by the user (score = follow time)
//   post-follow:prefs:<pid>:<uid>     hash        which events the user wants: edit/delete/restore = 1|0
const followersKey = pid => `post-follow:pid:${pid}:followers`;
const userPostsKey = uid => `post-follow:uid:${uid}:pids`;
const prefsKey = (pid, uid) => `post-follow:prefs:${pid}:${uid}`;

// ---------------------------------------------------------------------------
// Preference helpers
// ---------------------------------------------------------------------------

function parsePrefs(raw) {
	if (!raw || !EVENTS.some(event => raw[event] !== undefined && raw[event] !== null)) {
		return { ...DEFAULT_PREFS };
	}
	const prefs = {};
	EVENTS.forEach((event) => {
		prefs[event] = parseInt(raw[event], 10) === 1;
	});
	return prefs;
}

function serializePrefs(prefs) {
	const out = {};
	EVENTS.forEach((event) => {
		out[event] = prefs[event] ? 1 : 0;
	});
	return out;
}

function readBooleanFlag(value) {
	return value === true || value === 1 || value === '1' || value === 'true';
}

function parsePid(value) {
	const pid = parseInt(value, 10);
	return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

// ---------------------------------------------------------------------------
// Follow / unfollow primitives
// ---------------------------------------------------------------------------

async function followPost(uid, pid, prefs) {
	await Promise.all([
		db.setAdd(followersKey(pid), uid),
		db.sortedSetAdd(userPostsKey(uid), Date.now(), pid),
		db.setObject(prefsKey(pid, uid), serializePrefs(prefs)),
	]);
}

async function unfollowPost(uid, pid) {
	await Promise.all([
		db.setRemove(followersKey(pid), uid),
		db.sortedSetRemove(userPostsKey(uid), pid),
		db.delete(prefsKey(pid, uid)),
	]);
}

async function cleanupPost(pid) {
	const followers = await db.getSetMembers(followersKey(pid));
	await Promise.all([
		db.delete(followersKey(pid)),
		followers.length ? db.sortedSetsRemove(followers.map(userPostsKey), pid) : null,
		followers.length ? db.deleteAll(followers.map(uid => prefsKey(pid, uid))) : null,
	]);
}

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

Plugin.init = async function (params) {
	const { router, middleware } = params;

	registerSocketMethods();

	// "Followed posts" page inside the user profile.
	routeHelpers.setupPageRoute(router, '/user/:userslug/followed-posts', [
		middleware.exposeUid,
		middleware.canViewUsers,
		middleware.buildAccountData,
		middleware.ensureLoggedIn,
		middleware.checkAccountPermissions,
	], renderFollowedPosts);

	// Admin settings page.
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/post-follow', renderAdminPage);
};

function registerSocketMethods() {
	SocketPlugins.postFollow = {};

	// Returns the follow state of the current user for a batch of posts.
	SocketPlugins.postFollow.getStates = async function (socket, data) {
		const uid = socket.uid;
		const states = {};
		if (!uid) {
			return { states };
		}
		const pids = [...new Set(((data && data.pids) || []).map(parsePid).filter(Boolean))].slice(0, MAX_PIDS_PER_QUERY);
		if (!pids.length) {
			return { states };
		}

		const following = await db.isMemberOfSets(pids.map(followersKey), uid);
		const followedPids = pids.filter((pid, i) => following[i]);
		const prefsList = followedPids.length ?
			await db.getObjects(followedPids.map(pid => prefsKey(pid, uid))) :
			[];

		const prefsByPid = {};
		followedPids.forEach((pid, i) => {
			prefsByPid[pid] = parsePrefs(prefsList[i]);
		});
		pids.forEach((pid, i) => {
			states[pid] = {
				following: !!following[i],
				prefs: following[i] ? prefsByPid[pid] : { ...DEFAULT_PREFS },
			};
		});
		return { states };
	};

	// Follow / unfollow a single post.
	SocketPlugins.postFollow.toggle = async function (socket, data) {
		const uid = socket.uid;
		const pid = parsePid(data && data.pid);
		if (!uid) {
			throw new Error('[[error:not-logged-in]]');
		}
		if (!pid) {
			throw new Error('[[error:invalid-data]]');
		}

		const isFollowing = await db.isSetMember(followersKey(pid), uid);
		if (isFollowing) {
			// Always allowed, so users can clean up posts they can no longer read.
			await unfollowPost(uid, pid);
			return { following: false, prefs: { ...DEFAULT_PREFS } };
		}

		const [exists, canRead] = await Promise.all([
			posts.exists(pid),
			privileges.posts.can('topics:read', pid, uid),
		]);
		if (!exists) {
			throw new Error('[[error:no-post]]');
		}
		if (!canRead) {
			throw new Error('[[error:no-privileges]]');
		}
		if (await hasReachedFollowLimit(uid)) {
			const { maxFollowedPosts } = await getAdminSettings();
			throw new Error(`[[post-follow:limit-reached, ${maxFollowedPosts}]]`);
		}

		const prefs = { ...DEFAULT_PREFS };
		await followPost(uid, pid, prefs);
		return { following: true, prefs };
	};

	// Choose which events (edit / delete / restore) of a followed post notify the user.
	SocketPlugins.postFollow.setPrefs = async function (socket, data) {
		const uid = socket.uid;
		const pid = parsePid(data && data.pid);
		if (!uid) {
			throw new Error('[[error:not-logged-in]]');
		}
		if (!pid) {
			throw new Error('[[error:invalid-data]]');
		}

		const prefs = {};
		EVENTS.forEach((event) => {
			prefs[event] = readBooleanFlag(data[event]);
		});
		if (!EVENTS.some(event => prefs[event])) {
			throw new Error('[[post-follow:need-one-event]]');
		}

		const isFollowing = await db.isSetMember(followersKey(pid), uid);
		if (!isFollowing) {
			throw new Error('[[error:invalid-data]]');
		}
		await db.setObject(prefsKey(pid, uid), serializePrefs(prefs));
		return { following: true, prefs };
	};
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

// Number of characters that differ between two texts (common prefix and suffix are ignored).
function changeSize(oldText, newText) {
	const a = String(oldText);
	const b = String(newText);
	const max = Math.min(a.length, b.length);
	let start = 0;
	while (start < max && a[start] === b[start]) {
		start += 1;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA -= 1;
		endB -= 1;
	}
	return Math.max(endA - start, endB - start);
}

// Reads a non-negative integer setting, falling back to `fallback` when it is empty or invalid.
function toNonNegativeInt(value, fallback) {
	const number = parseInt(value, 10);
	return Number.isNaN(number) || number < 0 ? fallback : number;
}

async function getAdminSettings() {
	const settings = (await meta.settings.get(SETTINGS_HASH)) || {};
	return {
		minEditChars: toNonNegativeInt(settings.minEditChars, DEFAULT_MIN_EDIT_CHARS),
		maxFollowedPosts: toNonNegativeInt(settings.maxFollowedPosts, DEFAULT_MAX_FOLLOWED_POSTS),
	};
}

// True when the user may not follow another post (0 = no limit).
async function hasReachedFollowLimit(uid) {
	const { maxFollowedPosts } = await getAdminSettings();
	if (maxFollowedPosts <= 0) {
		return false;
	}
	return (await db.sortedSetCard(userPostsKey(uid))) >= maxFollowedPosts;
}

// NodeBB core already sends an edit notification to users who watch the whole topic,
// as long as their "post-edit" notification type is not set to "none".
// Skip those users to avoid duplicates. A topic watcher who turned post-edit
// notifications off still gets ours, because they explicitly followed this post.
async function skipUsersCoveredByCore(tid, uids) {
	if (!uids.length) {
		return uids;
	}
	const topicFollowers = new Set((await topics.getFollowers(tid)).map(String));
	const watchers = uids.filter(uid => topicFollowers.has(String(uid)));
	if (!watchers.length) {
		return uids;
	}

	const settings = await user.getMultipleUserSettings(watchers);
	const covered = new Set();
	settings.forEach((userSettings) => {
		const setting = userSettings['notificationType_post-edit'] || 'notification';
		if (setting !== 'none') {
			covered.add(String(userSettings.uid));
		}
	});
	return uids.filter(uid => !covered.has(String(uid)));
}

// Sends a notification about `event` to every follower of the post that asked for it.
async function notifyFollowers({ pid, tid, event, actorUid, path }) {
	if (!pid || !tid) {
		return;
	}

	let followers = await db.getSetMembers(followersKey(pid));
	followers = followers.filter(uid => String(uid) !== String(actorUid));
	if (!followers.length) {
		return;
	}

	const prefsList = await db.getObjects(followers.map(uid => prefsKey(pid, uid)));
	followers = followers.filter((uid, i) => parsePrefs(prefsList[i])[event]);
	if (!followers.length) {
		return;
	}

	followers = await privileges.topics.filterUids('topics:read', tid, followers);
	if (event === 'edit') {
		followers = await skipUsersCoveredByCore(tid, followers);
	}
	if (!followers.length) {
		return;
	}

	const [displayName, title] = await Promise.all([
		user.getNotificationDisplayname(actorUid),
		topics.getNotificationTitle(tid),
	]);

	const notification = await notifications.create({
		type: NOTIFICATION_TYPE,
		subject: title,
		bodyShort: translator.compile(`post-follow:notification-${NOTIFICATION_KEYS[event]}`, displayName, title),
		nid: `post-follow:${event}:${pid}:uid:${actorUid}`,
		pid: pid,
		tid: tid,
		path: path || `/post/${encodeURIComponent(pid)}`,
		from: actorUid,
		topicTitle: title,
	});
	if (notification) {
		notifications.push(notification, followers);
	}
}

Plugin.onPostEdit = async function (hookData) {
	const { post, uid: editorUid, data } = hookData || {};
	if (!post || !post.pid || !post.changed) {
		return;
	}
	const tid = post.tid || (post.topic && post.topic.tid);

	// Ignore tiny edits (typo fixes etc.), according to the threshold set in the ACP.
	const { minEditChars: minChars } = await getAdminSettings();
	if (minChars > 0 && post.oldContent !== undefined && post.oldContent !== null) {
		let newContent = post.newContent;
		if (newContent === undefined || newContent === null) {
			newContent = data && data.content;
		}
		if (newContent !== undefined && newContent !== null && changeSize(post.oldContent, newContent) < minChars) {
			return;
		}
	}

	await notifyFollowers({ pid: post.pid, tid, event: 'edit', actorUid: editorUid });
};

Plugin.onPostDelete = async function (hookData) {
	const post = hookData && hookData.post;
	if (!post || !post.pid) {
		return;
	}
	await notifyFollowers({ pid: post.pid, tid: post.tid, event: 'delete', actorUid: hookData.uid });
};

Plugin.onPostRestore = async function (hookData) {
	const post = hookData && hookData.post;
	if (!post || !post.pid) {
		return;
	}
	await notifyFollowers({ pid: post.pid, tid: post.tid, event: 'restore', actorUid: hookData.uid });
};

// A permanent deletion counts as "deleted" too, unless the post was already soft-deleted
// (its followers were notified back then). Follow data is always cleaned up.
Plugin.onPostsPurge = async function (hookData) {
	const purged = (hookData && hookData.posts) || [];
	for (const post of purged) {
		try {
			const alreadyDeleted = parseInt(post.deleted, 10) === 1;
			// eslint-disable-next-line no-await-in-loop
			if (!alreadyDeleted && await topics.exists(post.tid)) {
				// eslint-disable-next-line no-await-in-loop
				await notifyFollowers({
					pid: post.pid,
					tid: post.tid,
					event: 'delete',
					actorUid: hookData.uid,
					path: `/topic/${post.tid}`,
				});
			}
		} catch (err) {
			winston.warn(`[plugin/post-follow] could not notify about purged post ${post.pid}: ${err.message}`);
		}
		// eslint-disable-next-line no-await-in-loop
		await cleanupPost(post.pid);
	}
};

// Removes the follow data of a deleted user.
Plugin.onUserDelete = async function (hookData) {
	const uid = hookData && hookData.uid;
	if (!uid) {
		return;
	}
	const pids = await db.getSortedSetRange(userPostsKey(uid), 0, -1);
	if (pids.length) {
		await Promise.all([
			db.setsRemove(pids.map(followersKey), uid),
			db.deleteAll(pids.map(pid => prefsKey(pid, uid))),
		]);
	}
	await db.delete(userPostsKey(uid));
};

// ---------------------------------------------------------------------------
// Automatically follow own posts (user setting)
// ---------------------------------------------------------------------------

function prefsFromSettings(settings) {
	const prefs = {};
	EVENTS.forEach((event) => {
		prefs[event] = parseInt(settings[AUTO_FOLLOW_FIELDS[event]], 10) === 1;
	});
	const anyDefined = EVENTS.some(event => settings[AUTO_FOLLOW_FIELDS[event]] !== undefined &&
		settings[AUTO_FOLLOW_FIELDS[event]] !== null);
	if (!anyDefined || !EVENTS.some(event => prefs[event])) {
		return { ...DEFAULT_PREFS };
	}
	return prefs;
}

Plugin.onPostSave = async function (hookData) {
	const post = hookData && hookData.post;
	const uid = post && parseInt(post.uid, 10);
	if (!post || !post.pid || !uid || uid <= 0) {
		return;
	}
	const settings = await db.getObjectFields(`user:${uid}:settings`, Object.values(AUTO_FOLLOW_FIELDS));
	if (!settings || parseInt(settings[AUTO_FOLLOW_FIELDS.enabled], 10) !== 1) {
		return;
	}
	// Automatic following silently stops once the limit is reached.
	if (await hasReachedFollowLimit(uid)) {
		return;
	}
	await followPost(uid, post.pid, prefsFromSettings(settings));
};

function renderAutoFollowSettings(settings) {
	const enabled = parseInt(settings[AUTO_FOLLOW_FIELDS.enabled], 10) === 1;
	const prefs = prefsFromSettings(settings);
	const checked = value => (value ? ' checked' : '');
	const eventRow = event => `
		<div class="form-check">
			<input class="form-check-input" type="checkbox" id="${AUTO_FOLLOW_FIELDS[event]}" data-property="${AUTO_FOLLOW_FIELDS[event]}"${checked(prefs[event])}>
			<label class="form-check-label" for="${AUTO_FOLLOW_FIELDS[event]}">[[post-follow:event-${event}]]</label>
		</div>`;

	return `
<div class="form-check form-switch mb-2">
	<input class="form-check-input" type="checkbox" id="${AUTO_FOLLOW_FIELDS.enabled}" data-property="${AUTO_FOLLOW_FIELDS.enabled}"${checked(enabled)}>
	<label class="form-check-label" for="${AUTO_FOLLOW_FIELDS.enabled}">[[post-follow:setting-auto-follow]]</label>
</div>
<div class="ms-4 mb-3">
	<div class="form-text mb-1">[[post-follow:setting-auto-events]]</div>
	${EVENTS.map(eventRow).join('')}
</div>`;
}

Plugin.addCustomSettings = async function (data) {
	data.customSettings.push({
		title: '[[post-follow:settings-title]]',
		content: renderAutoFollowSettings(data.settings || {}),
	});
	return data;
};

// Persist the custom fields next to the other user settings.
Plugin.saveCustomSettings = async function (hookData) {
	const { settings, data } = hookData;
	Object.values(AUTO_FOLLOW_FIELDS).forEach((field) => {
		if (data && Object.hasOwn(data, field)) {
			settings[field] = readBooleanFlag(data[field]) ? 1 : 0;
		}
	});
	// Automatic following needs at least one event, otherwise it would be pointless.
	if (parseInt(settings[AUTO_FOLLOW_FIELDS.enabled], 10) === 1 &&
		!EVENTS.some(event => parseInt(settings[AUTO_FOLLOW_FIELDS[event]], 10) === 1)) {
		settings[AUTO_FOLLOW_FIELDS.edit] = 1;
	}
	return hookData;
};

// ---------------------------------------------------------------------------
// "Followed posts" profile page
// ---------------------------------------------------------------------------

Plugin.addProfileMenu = async function (data) {
	data.links.push({
		id: 'followed-posts',
		route: 'followed-posts',
		name: '[[post-follow:profile-menu]]',
		icon: 'fa-bell',
		visibility: {
			self: true,
			other: false,
			moderator: false,
			globalMod: false,
			admin: false,
			canViewInfo: false,
		},
	});
	return data;
};

function toSnippet(html) {
	const text = validator.unescape(utils.stripHTMLTags(String(html || ''))).replace(/\s+/g, ' ').trim();
	return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

async function renderFollowedPosts(req, res) {
	const payload = res.locals.userData;
	const page = Math.max(1, parseInt(req.query.page, 10) || 1);
	const settings = await user.getSettings(req.uid);
	const itemsPerPage = settings.postsPerPage;
	const start = (page - 1) * itemsPerPage;
	const stop = start + itemsPerPage - 1;
	const key = userPostsKey(payload.uid);

	const [result, itemCount] = await Promise.all([
		posts.getPostSummariesFromSet(key, req.uid, start, stop),
		db.sortedSetCard(key),
	]);

	const items = result.posts || [];
	const prefsList = items.length ? await db.getObjects(items.map(p => prefsKey(p.pid, payload.uid))) : [];
	items.forEach((item, i) => {
		const prefs = parsePrefs(prefsList[i]);
		item.pfFollowing = true;
		item.pfEdit = prefs.edit;
		item.pfDelete = prefs.delete;
		item.pfRestore = prefs.restore;
		item.snippet = toSnippet(item.content);
	});

	payload.posts = items;
	payload.pagination = pagination.create(page, Math.ceil(itemCount / itemsPerPage), req.query);
	payload.title = '[[post-follow:page-title]]';
	payload.breadcrumbs = controllerHelpers.buildBreadcrumbs([
		{ text: payload.username, url: `/user/${payload.userslug}` },
		{ text: '[[post-follow:profile-menu]]' },
	]);

	res.render('account/followed-posts', payload);
}

// ---------------------------------------------------------------------------
// Admin page
// ---------------------------------------------------------------------------

Plugin.addAdminNav = async function (header) {
	header.plugins.push({
		route: '/plugins/post-follow',
		icon: 'fa-bell',
		name: 'Post Follow',
	});
	return header;
};

function renderAdminPage(req, res) {
	res.render('admin/plugins/post-follow', {
		title: '[[post-follow:admin-title]]',
		defaultMinEditChars: DEFAULT_MIN_EDIT_CHARS,
		defaultMaxFollowedPosts: DEFAULT_MAX_FOLLOWED_POSTS,
	});
}

// ---------------------------------------------------------------------------
// Separate notification type (shows up in the user's notification settings)
// ---------------------------------------------------------------------------

Plugin.addNotificationType = async function (data) {
	data.types.push(`notificationType_${NOTIFICATION_TYPE}`);
	return data;
};
