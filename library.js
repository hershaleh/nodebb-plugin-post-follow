'use strict';

const validator = require.main.require('validator');
const winston = require.main.require('winston');

const db = require.main.require('./src/database');
const meta = require.main.require('./src/meta');
const topics = require.main.require('./src/topics');
const user = require.main.require('./src/user');
const posts = require.main.require('./src/posts');
const groups = require.main.require('./src/groups');
const categories = require.main.require('./src/categories');
const utils = require.main.require('./src/utils');
const privileges = require.main.require('./src/privileges');
const notifications = require.main.require('./src/notifications');
const pagination = require.main.require('./src/pagination');
const translator = require.main.require('./src/translator');
const controllerHelpers = require.main.require('./src/controllers/helpers');
const routeHelpers = require.main.require('./src/routes/helpers');
const SocketPlugins = require.main.require('./src/socket.io/plugins');
const plugins = require.main.require('./src/plugins');
const cron = require.main.require('./src/cron');

const Plugin = module.exports;

const EVENTS = ['edit', 'delete', 'restore', 'reply', 'topic'];
const DEFAULT_PREFS = Object.freeze({ edit: true, delete: false, restore: false, reply: false, topic: false });
const NOTIFICATION_KEYS = { edit: 'edited', delete: 'deleted', restore: 'restored', reply: 'replied' };
const SETTINGS_HASH = 'post-follow';
const NOTIFICATION_TYPE = 'post-follow';
const DEFAULT_MIN_EDIT_CHARS = 3;
const DEFAULT_MAX_FOLLOWED_POSTS = 500;
const DEFAULT_CLEANUP_DAYS = 30;
const MAX_PIDS_PER_QUERY = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const SORTS = ['followed', 'edited', 'posted', 'topic'];
// Core notification types that already reach topic watchers for the same event.
const CORE_TYPES = { edit: 'post-edit', reply: 'new-reply' };

// Per-user settings (stored next to the other user settings).
// own / replyTo / bookmark: when to follow a post automatically.
// The event fields: which events an automatically followed post notifies about.
const AUTO_TRIGGER_FIELDS = {
	own: 'postFollowAuto',
	replyTo: 'postFollowAutoReply',
	bookmark: 'postFollowAutoBookmark',
};
const AUTO_EVENT_FIELDS = {
	edit: 'postFollowAutoEdit',
	delete: 'postFollowAutoDelete',
	restore: 'postFollowAutoRestore',
	reply: 'postFollowAutoNotifyReply',
	topic: 'postFollowAutoNotifyTopic',
};
const AUTO_FOLLOW_FIELDS = { ...AUTO_TRIGGER_FIELDS, ...AUTO_EVENT_FIELDS };

// Data model:
//   post-follow:pid:<pid>:followers   set         uids that follow the post
//   post-follow:uid:<uid>:pids        sorted set  pids followed by the user (score = follow time)
//   post-follow:prefs:<pid>:<uid>     hash        which events the user wants: edit/delete/restore = 1|0
const followersKey = pid => `post-follow:pid:${pid}:followers`;
const userPostsKey = uid => `post-follow:uid:${uid}:pids`;
const prefsKey = (pid, uid) => `post-follow:prefs:${pid}:${uid}`;
// Global indexes, used for the admin statistics and the cleanup job:
//   post-follow:posts          sorted set  pid -> number of followers
//   post-follow:users          sorted set  uid -> last follow time (users that ever followed a post)
//   post-follow:deleted-seen   sorted set  pid -> when a followed post was first seen deleted
//   post-follow:stats          hash        counters of sent notifications
const GLOBAL_POSTS = 'post-follow:posts';
const GLOBAL_USERS = 'post-follow:users';
const DELETED_SEEN = 'post-follow:deleted-seen';
const STATS_KEY = 'post-follow:stats';
const META_KEY = 'post-follow:meta';

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

// Keeps the "followers per post" index in line with the real follower sets.
async function refreshPostCounts(pids) {
	if (!pids.length) {
		return;
	}
	const counts = await db.setsCount(pids.map(followersKey));
	const keepPids = [];
	const keepScores = [];
	const dropPids = [];
	pids.forEach((pid, i) => {
		if (counts[i] > 0) {
			keepPids.push(pid);
			keepScores.push(counts[i]);
		} else {
			dropPids.push(pid);
		}
	});
	await Promise.all([
		keepPids.length ? db.sortedSetAdd(GLOBAL_POSTS, keepScores, keepPids) : null,
		dropPids.length ? db.sortedSetRemove(GLOBAL_POSTS, dropPids) : null,
		dropPids.length ? db.sortedSetRemove(DELETED_SEEN, dropPids) : null,
	]);
}

async function followPostRaw(uid, pid, prefs) {
	await Promise.all([
		db.setAdd(followersKey(pid), uid),
		db.sortedSetAdd(userPostsKey(uid), Date.now(), pid),
		db.sortedSetAdd(GLOBAL_USERS, Date.now(), uid),
		db.setObject(prefsKey(pid, uid), serializePrefs(prefs)),
	]);
}

async function followPost(uid, pid, prefs) {
	await followPostRaw(uid, pid, prefs);
	await refreshPostCounts([pid]);
	plugins.hooks.fire('action:post-follow.follow', { uid, pid, prefs });
}

async function unfollowPost(uid, pid) {
	await Promise.all([
		db.setRemove(followersKey(pid), uid),
		db.sortedSetRemove(userPostsKey(uid), pid),
		db.delete(prefsKey(pid, uid)),
	]);
	await refreshPostCounts([pid]);
	plugins.hooks.fire('action:post-follow.unfollow', { uid, pid });
}

async function unfollowPosts(uid, pids) {
	if (!pids.length) {
		return;
	}
	await Promise.all([
		db.setsRemove(pids.map(followersKey), uid),
		db.sortedSetRemove(userPostsKey(uid), pids),
		db.deleteAll(pids.map(pid => prefsKey(pid, uid))),
	]);
	await refreshPostCounts(pids);
}

// Removes every follow of a post. Returns how many followers it had.
async function cleanupPost(pid) {
	const followers = await db.getSetMembers(followersKey(pid));
	await Promise.all([
		db.delete(followersKey(pid)),
		followers.length ? db.sortedSetsRemove(followers.map(userPostsKey), pid) : null,
		followers.length ? db.deleteAll(followers.map(uid => prefsKey(pid, uid))) : null,
		db.sortedSetRemove(GLOBAL_POSTS, pid),
		db.sortedSetRemove(DELETED_SEEN, pid),
	]);
	return followers.length;
}

async function addStat(event, count) {
	if (!count) {
		return;
	}
	await Promise.all([
		db.incrObjectFieldBy(STATS_KEY, 'sent', count),
		db.incrObjectFieldBy(STATS_KEY, `sent_${event}`, count),
	]);
}

// ---------------------------------------------------------------------------
// Admin settings
// ---------------------------------------------------------------------------

// Reads a non-negative integer setting, falling back to `fallback` when it is empty or invalid.
function toNonNegativeInt(value, fallback) {
	const number = parseInt(value, 10);
	return Number.isNaN(number) || number < 0 ? fallback : number;
}

// A multi-select is saved by the ACP as a JSON string, but accept a real array as well.
function parseGroupList(value) {
	let list = value;
	if (typeof list === 'string') {
		try {
			list = JSON.parse(list);
		} catch (err) {
			list = [];
		}
	}
	return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
}

// "1, 2 ,3" or a JSON list -> unique positive integers as strings.
function parseIdList(value) {
	const raw = Array.isArray(value) ? value.join(',') : String(value || '');
	return [...new Set(raw.split(/[^0-9]+/).filter(Boolean).map(id => String(parseInt(id, 10))).filter(id => id !== '0'))];
}

async function getAdminSettings() {
	const settings = (await meta.settings.get(SETTINGS_HASH)) || {};
	return {
		minEditChars: toNonNegativeInt(settings.minEditChars, DEFAULT_MIN_EDIT_CHARS),
		maxFollowedPosts: toNonNegativeInt(settings.maxFollowedPosts, DEFAULT_MAX_FOLLOWED_POSTS),
		cleanupDays: toNonNegativeInt(settings.cleanupDays, DEFAULT_CLEANUP_DAYS),
		exemptGroups: parseGroupList(settings.exemptGroups),
		blockedCategories: parseGroupList(settings.blockedCategories),
		blockedTopics: parseIdList(settings.blockedTopics),
		blockedPosts: parseIdList(settings.blockedPosts),
		enableApi: ['on', '1', 'true', 1, true].includes(settings.enableApi),
	};
}

function hasBlockRules(settings) {
	return !!(settings.blockedCategories.length || settings.blockedTopics.length || settings.blockedPosts.length);
}

// True when following (and notifying about) anything in this topic is switched off.
async function isTopicBlocked(tid, settings) {
	if (!hasBlockRules(settings)) {
		return false;
	}
	if (settings.blockedTopics.includes(String(tid))) {
		return true;
	}
	if (!settings.blockedCategories.length) {
		return false;
	}
	const cid = await topics.getTopicField(tid, 'cid');
	return settings.blockedCategories.includes(String(cid));
}

// Which of these posts may not be followed (blocked post, topic or category).
async function getBlockedPids(pids, settings) {
	const blocked = new Set();
	if (!hasBlockRules(settings) || !pids.length) {
		return blocked;
	}
	const needTopics = settings.blockedTopics.length || settings.blockedCategories.length;
	const postFields = needTopics ? await posts.getPostsFields(pids, ['pid', 'tid']) : [];
	const tids = [...new Set(postFields.filter(post => post && post.tid).map(post => post.tid))];
	const topicFields = tids.length && settings.blockedCategories.length ?
		await topics.getTopicsFields(tids, ['tid', 'cid']) :
		[];
	const cidByTid = {};
	topicFields.forEach((topic) => {
		if (topic && topic.tid) {
			cidByTid[topic.tid] = String(topic.cid);
		}
	});
	pids.forEach((pid, i) => {
		const tid = postFields[i] && postFields[i].tid ? String(postFields[i].tid) : null;
		if (settings.blockedPosts.includes(String(pid)) ||
			(tid && settings.blockedTopics.includes(tid)) ||
			(tid && cidByTid[tid] && settings.blockedCategories.includes(cidByTid[tid]))) {
			blocked.add(String(pid));
		}
	});
	return blocked;
}

async function isExempt(uid, settings) {
	return settings.exemptGroups.length > 0 && groups.isMemberOfAny(uid, settings.exemptGroups);
}

// True when the user may not follow another post (0 = no limit, exempt groups are never limited).
async function hasReachedFollowLimit(uid) {
	const settings = await getAdminSettings();
	if (settings.maxFollowedPosts <= 0 || await isExempt(uid, settings)) {
		return false;
	}
	return (await db.sortedSetCard(userPostsKey(uid))) >= settings.maxFollowedPosts;
}

// How many more posts the user may follow (Infinity = no limit).
async function remainingFollowSlots(uid, settings) {
	if (settings.maxFollowedPosts <= 0 || await isExempt(uid, settings)) {
		return Infinity;
	}
	const used = await db.sortedSetCard(userPostsKey(uid));
	return Math.max(0, settings.maxFollowedPosts - used);
}

// Follows a post after checking everything a user-initiated follow must satisfy.
async function followWithChecks(uid, pid, prefs) {
	const [exists, canRead, settings] = await Promise.all([
		posts.exists(pid),
		privileges.posts.can('topics:read', pid, uid),
		getAdminSettings(),
	]);
	if (!exists) {
		throw new Error('[[error:no-post]]');
	}
	if (!canRead) {
		throw new Error('[[error:no-privileges]]');
	}
	if ((await getBlockedPids([pid], settings)).has(String(pid))) {
		throw new Error('[[post-follow:follow-blocked]]');
	}
	if ((await remainingFollowSlots(uid, settings)) <= 0) {
		throw new Error(`[[post-follow:limit-reached, ${settings.maxFollowedPosts}]]`);
	}
	await followPost(uid, pid, prefs);
}

async function getFollowState(uid, pid) {
	const following = await db.isSetMember(followersKey(pid), uid);
	const prefs = following ? parsePrefs(await db.getObject(prefsKey(pid, uid))) : { ...DEFAULT_PREFS };
	return { following, prefs };
}

function readPrefsFromData(data, fallback) {
	const given = EVENTS.some(event => data && data[event] !== undefined);
	if (!given) {
		return { ...fallback };
	}
	const prefs = {};
	EVENTS.forEach((event) => {
		prefs[event] = readBooleanFlag(data[event]);
	});
	return prefs;
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

	// Periodic cleanup of follows that point to deleted or missing posts (daily, 04:15).
	if (typeof cron.hasJob !== 'function' || !cron.hasJob('post-follow:cleanup')) {
		await cron.addJob({
			name: 'post-follow:cleanup',
			cronTime: '15 4 * * *',
			onTick: runCleanup,
		});
	}

	// Build the global indexes for follows created before they existed (runs once).
	buildIndexes().catch(err => winston.warn(`[plugin/post-follow] index build failed: ${err.message}`));
};

function requireUid(socket) {
	if (!socket.uid) {
		throw new Error('[[error:not-logged-in]]');
	}
	return socket.uid;
}

// Older versions did not keep the global indexes; fill them in once.
async function buildIndexes() {
	if (typeof db.scan !== 'function') {
		return;
	}
	if (parseInt(await db.getObjectField(META_KEY, 'indexVersion'), 10) >= 1) {
		return;
	}
	const keys = await db.scan({ match: 'post-follow:uid:*:pids' });
	for (const key of keys) {
		const uid = parseInt(String(key).split(':')[2], 10);
		// eslint-disable-next-line no-await-in-loop
		const pids = uid ? await db.getSortedSetRange(key, 0, -1) : [];
		if (pids.length) {
			// eslint-disable-next-line no-await-in-loop
			await db.sortedSetAdd(GLOBAL_USERS, Date.now(), uid);
			// eslint-disable-next-line no-await-in-loop
			await refreshPostCounts(pids);
		}
	}
	await db.setObjectField(META_KEY, 'indexVersion', 1);
}

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
		const [prefsList, blocked] = await Promise.all([
			followedPids.length ? db.getObjects(followedPids.map(pid => prefsKey(pid, uid))) : [],
			getAdminSettings().then(settings => getBlockedPids(pids, settings)),
		]);

		const prefsByPid = {};
		followedPids.forEach((pid, i) => {
			prefsByPid[pid] = parsePrefs(prefsList[i]);
		});
		pids.forEach((pid, i) => {
			states[pid] = {
				following: !!following[i],
				prefs: following[i] ? prefsByPid[pid] : { ...DEFAULT_PREFS },
				blocked: blocked.has(String(pid)),
			};
		});
		return { states };
	};

	// Follow / unfollow a single post.
	SocketPlugins.postFollow.toggle = async function (socket, data) {
		const uid = requireUid(socket);
		const pid = parsePid(data && data.pid);
		if (!pid) {
			throw new Error('[[error:invalid-data]]');
		}

		if (await db.isSetMember(followersKey(pid), uid)) {
			// Always allowed, so users can clean up posts they can no longer read.
			await unfollowPost(uid, pid);
			return { following: false, prefs: { ...DEFAULT_PREFS } };
		}
		const prefs = { ...DEFAULT_PREFS };
		await followWithChecks(uid, pid, prefs);
		return { following: true, prefs };
	};

	// Choose which events of a followed post notify the user.
	SocketPlugins.postFollow.setPrefs = async function (socket, data) {
		const uid = requireUid(socket);
		const pid = parsePid(data && data.pid);
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

		if (!await db.isSetMember(followersKey(pid), uid)) {
			throw new Error('[[error:invalid-data]]');
		}
		await db.setObject(prefsKey(pid, uid), serializePrefs(prefs));
		return { following: true, prefs };
	};

	// Follow many posts of one topic at once: my posts, the posts of one author, or all posts.
	SocketPlugins.postFollow.followBulk = async function (socket, data) {
		const uid = requireUid(socket);
		const pid = parsePid(data && data.pid);
		const scope = data && data.scope;
		if (!pid || !['mine', 'author', 'all'].includes(scope)) {
			throw new Error('[[error:invalid-data]]');
		}
		const prefs = readPrefsFromData(data, DEFAULT_PREFS);
		if (!EVENTS.some(event => prefs[event])) {
			throw new Error('[[post-follow:need-one-event]]');
		}
		return await followBulk(uid, pid, scope, prefs);
	};

	// Stop following every post.
	SocketPlugins.postFollow.unfollowAll = async function (socket) {
		const uid = requireUid(socket);
		const pids = await db.getSortedSetRange(userPostsKey(uid), 0, -1);
		await unfollowPosts(uid, pids);
		return { count: pids.length };
	};

	// Stop following posts that were deleted, or whose topic was deleted or locked.
	SocketPlugins.postFollow.unfollowUnavailable = async function (socket) {
		const uid = requireUid(socket);
		const pids = await db.getSortedSetRange(userPostsKey(uid), 0, -1);
		const info = await loadPostInfo(pids);
		const unavailable = info
			.filter(entry => !entry.exists || entry.deleted || entry.topicDeleted || entry.topicLocked)
			.map(entry => entry.pid);
		await unfollowPosts(uid, unavailable);
		return { count: unavailable.length };
	};

	// Admin: run the cleanup right now.
	SocketPlugins.postFollow.runCleanup = async function (socket) {
		const uid = requireUid(socket);
		if (!await user.isAdministrator(uid)) {
			throw new Error('[[error:no-privileges]]');
		}
		return await runCleanup();
	};
}

// All pids of a topic (replies plus the main post).
async function getTopicPids(tid) {
	const [pids, mainPid] = await Promise.all([
		db.getSortedSetRange(`tid:${tid}:posts`, 0, -1),
		topics.getTopicField(tid, 'mainPid'),
	]);
	const all = pids.map(String);
	if (mainPid && !all.includes(String(mainPid))) {
		all.unshift(String(mainPid));
	}
	return all;
}

async function followBulk(uid, pid, scope, prefs) {
	const post = await posts.getPostFields(pid, ['pid', 'tid', 'uid']);
	if (!post || !post.pid) {
		throw new Error('[[error:no-post]]');
	}
	const tid = post.tid;
	const settings = await getAdminSettings();
	if (!await privileges.topics.can('topics:read', tid, uid)) {
		throw new Error('[[error:no-privileges]]');
	}
	if (await isTopicBlocked(tid, settings)) {
		throw new Error('[[post-follow:follow-blocked]]');
	}

	const allPids = await getTopicPids(tid);
	const fields = await posts.getPostsFields(allPids, ['pid', 'uid', 'deleted']);
	const wantedUid = scope === 'mine' ? uid : post.uid;
	let candidates = allPids.filter((p, i) => {
		const f = fields[i];
		if (!f || !f.pid || parseInt(f.deleted, 10) === 1) {
			return false;
		}
		return scope === 'all' || String(f.uid) === String(wantedUid);
	});
	const already = candidates.length ? await db.isMemberOfSets(candidates.map(followersKey), uid) : [];
	candidates = candidates.filter((p, i) => !already[i]);
	const blocked = await getBlockedPids(candidates, settings);
	candidates = candidates.filter(p => !blocked.has(String(p)));
	if (!candidates.length) {
		return { count: 0, skipped: 0 };
	}

	const slots = await remainingFollowSlots(uid, settings);
	if (slots <= 0) {
		throw new Error(`[[post-follow:limit-reached, ${settings.maxFollowedPosts}]]`);
	}
	const chosen = candidates.slice(0, slots === Infinity ? candidates.length : slots);
	for (let i = 0; i < chosen.length; i += 50) {
		// eslint-disable-next-line no-await-in-loop
		await Promise.all(chosen.slice(i, i + 50).map(p => followPostRaw(uid, p, prefs)));
	}
	await refreshPostCounts(chosen);
	return { count: chosen.length, skipped: candidates.length - chosen.length };
}

// ---------------------------------------------------------------------------
// Cleanup of follows on deleted / missing posts
// ---------------------------------------------------------------------------

// Removes follows of posts that no longer exist. Follows of deleted posts (or posts in deleted
// topics) are removed once they have been deleted for `cleanupDays` days (0 = keep them).
async function runCleanup() {
	const { cleanupDays } = await getAdminSettings();
	const result = { posts: 0, follows: 0 };
	const now = Date.now();
	const allPids = await db.getSortedSetRange(GLOBAL_POSTS, 0, -1);

	for (let i = 0; i < allPids.length; i += 200) {
		const chunk = allPids.slice(i, i + 200);
		// eslint-disable-next-line no-await-in-loop
		const info = await loadPostInfo(chunk);
		// eslint-disable-next-line no-await-in-loop
		const seen = await db.sortedSetScores(DELETED_SEEN, chunk);
		const alive = [];
		const newlySeen = [];
		for (let j = 0; j < info.length; j += 1) {
			const entry = info[j];
			const dead = entry.exists && (entry.deleted || entry.topicDeleted);
			let remove = !entry.exists;
			if (dead) {
				if (seen[j] === null || seen[j] === undefined) {
					newlySeen.push(entry.pid);
				} else if (cleanupDays > 0 && now - seen[j] > cleanupDays * DAY_MS) {
					remove = true;
				}
			} else if (entry.exists) {
				alive.push(entry.pid);
			}
			if (remove) {
				// eslint-disable-next-line no-await-in-loop
				result.follows += await cleanupPost(entry.pid);
				result.posts += 1;
			}
		}
		if (newlySeen.length) {
			// eslint-disable-next-line no-await-in-loop
			await db.sortedSetAdd(DELETED_SEEN, newlySeen.map(() => now), newlySeen);
		}
		if (alive.length) {
			// eslint-disable-next-line no-await-in-loop
			await db.sortedSetRemove(DELETED_SEEN, alive);
		}
	}
	return result;
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

// NodeBB core already notifies users who watch the whole topic about edits and replies,
// as long as their matching notification type ("post-edit" / "new-reply") is not set to "none".
// Skip those users to avoid duplicates. A topic watcher who turned that type off
// still gets ours, because they explicitly followed this post.
async function skipUsersCoveredByCore(tid, uids, coreType) {
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
		const setting = userSettings[`notificationType_${coreType}`] || 'notification';
		if (setting !== 'none') {
			covered.add(String(userSettings.uid));
		}
	});
	return uids.filter(uid => !covered.has(String(uid)));
}

// A follower who still has an unread notification with the same id
// is not notified again until they have read it (reading moves it out of the unread list).
async function skipUsersWithUnreadNotification(uids, nid) {
	if (!uids.length) {
		return uids;
	}
	const scores = await db.sortedSetsScore(uids.map(uid => `uid:${uid}:notifications:unread`), nid);
	return uids.filter((uid, i) => scores[i] === null || scores[i] === undefined);
}

function safeText(value) {
	return validator.escape(validator.unescape(utils.stripHTMLTags(String(value || ''))));
}

// Creates and pushes one notification to `uids` (after the read-privilege and unread checks).
async function sendNotification({ uids, tid, event, nid, key, args, path, from, pid }) {
	let recipients = await privileges.topics.filterUids('topics:read', tid, uids);
	recipients = await skipUsersWithUnreadNotification(recipients, nid);
	if (CORE_TYPES[event]) {
		recipients = await skipUsersCoveredByCore(tid, recipients, CORE_TYPES[event]);
	}
	if (!recipients.length) {
		return;
	}

	const [displayName, title] = await Promise.all([
		user.getNotificationDisplayname(from),
		topics.getNotificationTitle(tid),
	]);
	const extra = typeof args === 'function' ? await args() : [];

	const notification = await notifications.create({
		type: NOTIFICATION_TYPE,
		subject: title,
		bodyShort: translator.compile(`post-follow:${key}`, displayName, title, ...extra),
		nid: nid,
		pid: pid,
		tid: tid,
		path: path,
		from: from,
		topicTitle: title,
	});
	if (notification) {
		notifications.push(notification, recipients);
		await addStat(event, recipients.length);
	}
}

// Sends a notification about `event` to every follower of the post that asked for it.
// `linkPid` is the post the notification opens (the reply, for reply notifications).
async function notifyFollowers({ pid, tid, event, actorUid, path, linkPid }) {
	if (!pid || !tid) {
		return;
	}
	if (await isTopicBlocked(tid, await getAdminSettings())) {
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

	const target = linkPid || pid;
	await sendNotification({
		uids: followers,
		tid: tid,
		event: event,
		// One notification per post and event, whoever caused it.
		nid: `post-follow:${event}:${pid}`,
		key: `notification-${NOTIFICATION_KEYS[event]}`,
		path: path || `/post/${encodeURIComponent(target)}`,
		from: actorUid,
		pid: target,
	});
}

// Users that follow any post of the topic (or any of `onlyPids`) and asked for topic changes.
async function getTopicFollowers(tid, onlyPids) {
	const pids = onlyPids || await getTopicPids(tid);
	const wanted = new Set();
	for (let i = 0; i < pids.length; i += 500) {
		const chunk = pids.slice(i, i + 500);
		// eslint-disable-next-line no-await-in-loop
		const lists = await db.getSetsMembers(chunk.map(followersKey));
		const pairs = [];
		chunk.forEach((pid, j) => {
			(lists[j] || []).forEach(uid => pairs.push([pid, uid]));
		});
		if (pairs.length) {
			// eslint-disable-next-line no-await-in-loop
			const prefsList = await db.getObjects(pairs.map(([pid, uid]) => prefsKey(pid, uid)));
			pairs.forEach(([, uid], j) => {
				if (parsePrefs(prefsList[j]).topic) {
					wanted.add(String(uid));
				}
			});
		}
	}
	return [...wanted];
}

// kind: moved | locked | unlocked | pinned | unpinned | renamed
async function notifyTopicChange({ tid, kind, actorUid, onlyPids, args }) {
	if (!tid || await isTopicBlocked(tid, await getAdminSettings())) {
		return;
	}
	let followers = (await getTopicFollowers(tid, onlyPids)).filter(uid => uid !== String(actorUid));
	if (!followers.length) {
		return;
	}
	await sendNotification({
		uids: followers,
		tid: tid,
		event: 'topic',
		nid: `post-follow:topic-${kind}:${tid}`,
		key: `notification-topic-${kind}`,
		args: args,
		path: `/topic/${tid}`,
		from: actorUid,
	});
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
	if ((await db.setCount(followersKey(post.pid))) > 0) {
		await db.sortedSetAdd(DELETED_SEEN, Date.now(), post.pid);
	}
	await notifyFollowers({ pid: post.pid, tid: post.tid, event: 'delete', actorUid: hookData.uid });
};

Plugin.onPostRestore = async function (hookData) {
	const post = hookData && hookData.post;
	if (!post || !post.pid) {
		return;
	}
	await db.sortedSetRemove(DELETED_SEEN, post.pid);
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

// ---- topic level events -------------------------------------------------------

Plugin.onTopicLock = async function (hookData) {
	const topic = hookData && hookData.topic;
	if (!topic || !topic.tid) {
		return;
	}
	const locked = topic.locked === true || parseInt(topic.locked, 10) === 1;
	await notifyTopicChange({ tid: topic.tid, kind: locked ? 'locked' : 'unlocked', actorUid: hookData.uid });
};

Plugin.onTopicPin = async function (hookData) {
	const topic = hookData && hookData.topic;
	if (!topic || !topic.tid) {
		return;
	}
	const pinned = topic.pinned === true || parseInt(topic.pinned, 10) === 1;
	await notifyTopicChange({ tid: topic.tid, kind: pinned ? 'pinned' : 'unpinned', actorUid: hookData.uid });
};

Plugin.onTopicMove = async function (hookData) {
	if (!hookData || !hookData.tid || String(hookData.fromCid) === String(hookData.toCid)) {
		return;
	}
	await notifyTopicChange({
		tid: hookData.tid,
		kind: 'moved',
		actorUid: hookData.uid,
		args: async () => [safeText(await categories.getCategoryField(hookData.toCid, 'name'))],
	});
};

// The title of a topic belongs to its first post: only followers of that post are told.
Plugin.onTopicEdit = async function (hookData) {
	const topic = hookData && hookData.topic;
	if (!topic || !topic.tid || topic.title === undefined || topic.title === topic.oldTitle) {
		return;
	}
	const mainPid = topic.mainPid || await topics.getTopicField(topic.tid, 'mainPid');
	if (!mainPid) {
		return;
	}
	await notifyTopicChange({
		tid: topic.tid,
		kind: 'renamed',
		actorUid: hookData.uid,
		onlyPids: [String(mainPid)],
		args: async () => [safeText(topic.oldTitle)],
	});
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
		await refreshPostCounts(pids);
	}
	await Promise.all([
		db.delete(userPostsKey(uid)),
		db.sortedSetRemove(GLOBAL_USERS, uid),
	]);
};

// ---------------------------------------------------------------------------
// Automatic following (user settings)
// ---------------------------------------------------------------------------

function prefsFromSettings(settings) {
	const prefs = {};
	EVENTS.forEach((event) => {
		prefs[event] = parseInt(settings[AUTO_EVENT_FIELDS[event]], 10) === 1;
	});
	const anyDefined = EVENTS.some(event => settings[AUTO_EVENT_FIELDS[event]] !== undefined &&
		settings[AUTO_EVENT_FIELDS[event]] !== null);
	if (!anyDefined || !EVENTS.some(event => prefs[event])) {
		return { ...DEFAULT_PREFS };
	}
	return prefs;
}

// Follows `pid` for `uid` when the user enabled the given automatic trigger
// (own = posts I write, replyTo = posts I reply to or quote, bookmark = posts I bookmark).
async function autoFollow(rawUid, rawPid, trigger) {
	const uid = parseInt(rawUid, 10);
	const pid = parsePid(rawPid);
	if (!uid || uid <= 0 || !pid) {
		return;
	}
	const settings = await db.getObjectFields(`user:${uid}:settings`, Object.values(AUTO_FOLLOW_FIELDS));
	if (!settings || parseInt(settings[AUTO_TRIGGER_FIELDS[trigger]], 10) !== 1) {
		return;
	}
	// Never overwrite the choices of a post that is already followed.
	if (await db.isSetMember(followersKey(pid), uid)) {
		return;
	}
	const adminSettings = await getAdminSettings();
	// Automatic following silently stops once the limit is reached, and skips blocked places.
	if ((await remainingFollowSlots(uid, adminSettings)) <= 0) {
		return;
	}
	if ((await getBlockedPids([pid], adminSettings)).has(String(pid))) {
		return;
	}
	await followPost(uid, pid, prefsFromSettings(settings));
}

Plugin.onPostSave = async function (hookData) {
	const post = hookData && hookData.post;
	if (!post || !post.pid) {
		return;
	}
	await autoFollow(post.uid, post.pid, 'own');
	if (post.toPid) {
		// A direct reply (or quote) notifies the followers of the post it answers...
		const toPid = parsePid(post.toPid);
		if (toPid && post.tid) {
			await notifyFollowers({
				pid: toPid,
				tid: post.tid,
				event: 'reply',
				actorUid: post.uid,
				linkPid: post.pid,
			});
		}
		// ...and, if the author asked for it, makes the author follow it.
		await autoFollow(post.uid, post.toPid, 'replyTo');
	}
};

Plugin.onPostBookmark = async function (hookData) {
	if (!hookData || !hookData.pid) {
		return;
	}
	await autoFollow(hookData.uid, hookData.pid, 'bookmark');
};

function renderAutoFollowSettings(settings) {
	const prefs = prefsFromSettings(settings);
	const checked = value => (value ? ' checked' : '');
	const isOn = field => parseInt(settings[field], 10) === 1;

	const switchRow = (trigger, labelKey) => `
<div class="form-check form-switch mb-2">
	<input class="form-check-input" type="checkbox" id="${AUTO_TRIGGER_FIELDS[trigger]}" data-property="${AUTO_TRIGGER_FIELDS[trigger]}"${checked(isOn(AUTO_TRIGGER_FIELDS[trigger]))}>
	<label class="form-check-label" for="${AUTO_TRIGGER_FIELDS[trigger]}">[[post-follow:${labelKey}]]</label>
</div>`;
	const eventRow = event => `
	<div class="form-check">
		<input class="form-check-input" type="checkbox" id="${AUTO_EVENT_FIELDS[event]}" data-property="${AUTO_EVENT_FIELDS[event]}"${checked(prefs[event])}>
		<label class="form-check-label" for="${AUTO_EVENT_FIELDS[event]}">[[post-follow:event-${event}]]</label>
	</div>`;

	return `${switchRow('own', 'setting-auto-follow')}
${switchRow('replyTo', 'setting-auto-follow-reply')}
${switchRow('bookmark', 'setting-auto-follow-bookmark')}
<div class="ms-4 mb-3">
	<div class="form-text mb-1">[[post-follow:setting-auto-events]]</div>
	${EVENTS.map(eventRow).join('')}
</div>`;
}

Plugin.addCustomSettings = async function (data) {
	// The content is raw HTML that NodeBB does not translate, so translate it here
	// in the language of the user who is viewing the page.
	const viewerSettings = await user.getSettings(data.uid);
	const language = (viewerSettings && viewerSettings.userLang) || meta.config.defaultLang || 'en-GB';
	data.customSettings.push({
		title: '[[post-follow:settings-title]]',
		content: await translator.translate(renderAutoFollowSettings(data.settings || {}), language),
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
	const anyTrigger = Object.values(AUTO_TRIGGER_FIELDS).some(field => parseInt(settings[field], 10) === 1);
	if (anyTrigger && !Object.values(AUTO_EVENT_FIELDS).some(field => parseInt(settings[field], 10) === 1)) {
		settings[AUTO_EVENT_FIELDS.edit] = 1;
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

// Lets the profile sidebar show the number of followed posts (own profile only).
Plugin.addProfileCounts = async function (hookData) {
	const { userData, callerUID } = hookData;
	if (userData && parseInt(callerUID, 10) > 0 && parseInt(callerUID, 10) === parseInt(userData.uid, 10)) {
		userData.counts = userData.counts || {};
		userData.counts.followedPosts = await db.sortedSetCard(userPostsKey(userData.uid));
	}
	return hookData;
};

function toSnippet(html) {
	const text = validator.unescape(utils.stripHTMLTags(String(html || ''))).replace(/\s+/g, ' ').trim();
	return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

// Loads, for each pid, whether the post exists / is deleted and the state of its topic.
async function loadPostInfo(pids) {
	if (!pids.length) {
		return [];
	}
	const postFields = await posts.getPostsFields(pids, ['pid', 'tid', 'deleted', 'timestamp', 'edited']);
	const tids = [...new Set(postFields.filter(post => post && post.tid).map(post => post.tid))];
	const topicFields = tids.length ?
		await topics.getTopicsFields(tids, ['tid', 'cid', 'title', 'deleted', 'locked']) :
		[];
	const topicByTid = {};
	topicFields.forEach((topic) => {
		if (topic && topic.tid) {
			topicByTid[topic.tid] = topic;
		}
	});

	return pids.map((pid, i) => {
		const post = postFields[i];
		const exists = !!(post && post.pid);
		const topic = exists && post.tid ? topicByTid[post.tid] || null : null;
		return {
			pid: pid,
			exists: exists,
			deleted: exists && parseInt(post.deleted, 10) === 1,
			timestamp: exists ? parseInt(post.timestamp, 10) || 0 : 0,
			edited: exists ? parseInt(post.edited, 10) || 0 : 0,
			topic: topic,
			topicDeleted: !!topic && parseInt(topic.deleted, 10) === 1,
			topicLocked: !!topic && parseInt(topic.locked, 10) === 1,
		};
	});
}

async function renderFollowedPosts(req, res) {
	const payload = res.locals.userData;
	const page = Math.max(1, parseInt(req.query.page, 10) || 1);
	const settings = await user.getSettings(req.uid);
	const itemsPerPage = settings.postsPerPage;

	const filterCid = parseInt(req.query.cid, 10) || 0;
	const filterText = String(req.query.q || '').trim().slice(0, 100);
	const sort = SORTS.includes(req.query.sort) ? req.query.sort : 'followed';

	// Everything the user follows and may still read, newest follow first.
	let pids = await db.getSortedSetRevRange(userPostsKey(payload.uid), 0, -1);
	pids = await privileges.posts.filter('topics:read', pids, req.uid);
	const info = await loadPostInfo(pids);

	// Categories that appear in the list, for the filter drop-down.
	const cids = [...new Set(info.filter(entry => entry.topic).map(entry => String(entry.topic.cid)))];
	const categoryData = cids.length ? await categories.getCategoriesFields(cids, ['cid', 'name']) : [];
	const pfCategories = categoryData
		.filter(category => category && category.cid)
		.map(category => ({
			cid: category.cid,
			name: category.name,
			selected: parseInt(category.cid, 10) === filterCid,
		}));

	const needle = filterText.toLowerCase();
	const matching = info.filter((entry) => {
		if (filterCid && !(entry.topic && parseInt(entry.topic.cid, 10) === filterCid)) {
			return false;
		}
		if (needle && !(entry.topic && String(entry.topic.title || '').toLowerCase().includes(needle))) {
			return false;
		}
		return true;
	});

	// "followed" keeps the order of the list (most recently followed first).
	if (sort === 'edited') {
		matching.sort((a, b) => b.edited - a.edited);
	} else if (sort === 'posted') {
		matching.sort((a, b) => b.timestamp - a.timestamp);
	} else if (sort === 'topic') {
		const titleOf = entry => String((entry.topic && entry.topic.title) || '');
		matching.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
	}

	const start = (page - 1) * itemsPerPage;
	const pageEntries = matching.slice(start, start + itemsPerPage);
	const infoByPid = {};
	pageEntries.forEach((entry) => {
		infoByPid[entry.pid] = entry;
	});

	const items = pageEntries.length ?
		await posts.getPostSummaryByPids(pageEntries.map(entry => entry.pid), req.uid, { stripTags: false }) :
		[];
	const prefsList = items.length ? await db.getObjects(items.map(p => prefsKey(p.pid, payload.uid))) : [];
	items.forEach((item, i) => {
		const prefs = parsePrefs(prefsList[i]);
		const entry = infoByPid[item.pid] || {};
		item.pfFollowing = true;
		item.pfEdit = prefs.edit;
		item.pfDelete = prefs.delete;
		item.pfRestore = prefs.restore;
		item.pfReply = prefs.reply;
		item.pfTopic = prefs.topic;
		item.pfAuthorUid = item.user ? item.user.uid : 0;
		item.pfAuthorName = item.user ? item.user.username : '';
		item.pfOwn = String(item.pfAuthorUid) === String(req.uid);
		item.pfPostDeleted = !!entry.deleted;
		item.pfTopicDeleted = !!entry.topicDeleted;
		item.pfTopicLocked = !!entry.topicLocked;
		item.snippet = toSnippet(item.content);
	});

	payload.posts = items;
	payload.pfCategories = pfCategories;
	payload.pfQuery = filterText;
	payload.pfFiltered = !!(filterCid || filterText);
	payload.pfSortFollowed = sort === 'followed';
	payload.pfSortEdited = sort === 'edited';
	payload.pfSortPosted = sort === 'posted';
	payload.pfSortTopic = sort === 'topic';
	payload.pfTotalFollowed = info.length;
	payload.pagination = pagination.create(page, Math.ceil(matching.length / itemsPerPage), req.query);
	payload.title = '[[post-follow:page-title]]';
	payload.breadcrumbs = controllerHelpers.buildBreadcrumbs([
		{ text: payload.username, url: `/user/${payload.userslug}` },
		{ text: '[[post-follow:profile-menu]]' },
	]);

	res.render('account/followed-posts', payload);
}

// Exposed only so the simulation tests can reach the page renderers.
Plugin.__renderFollowedPostsForTest = renderFollowedPosts;

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

// Numbers shown at the top of the admin page.
async function collectStats() {
	const userIds = await db.getSortedSetRange(GLOBAL_USERS, 0, 4999);
	const cards = userIds.length ? await db.sortedSetsCard(userIds.map(userPostsKey)) : [];
	const stats = (await db.getObject(STATS_KEY)) || {};
	const [distinctPosts, topScores] = await Promise.all([
		db.sortedSetCard(GLOBAL_POSTS),
		db.getSortedSetRevRangeWithScores(GLOBAL_POSTS, 0, 9),
	]);
	const topInfo = await loadPostInfo(topScores.map(entry => entry.value));
	const sent = key => parseInt(stats[key], 10) || 0;

	return {
		totalFollows: cards.reduce((sum, card) => sum + card, 0),
		usersFollowing: cards.filter(card => card > 0).length,
		distinctPosts: distinctPosts,
		topPosts: topScores.map((entry, i) => ({
			pid: entry.value,
			followers: entry.score,
			title: topInfo[i] && topInfo[i].topic ? validator.unescape(String(topInfo[i].topic.title || '')) : '',
		})),
		sent: {
			total: sent('sent'),
			edit: sent('sent_edit'),
			delete: sent('sent_delete'),
			restore: sent('sent_restore'),
			reply: sent('sent_reply'),
			topic: sent('sent_topic'),
		},
	};
}

async function renderAdminPage(req, res) {
	const [groupsData, categoriesData, stats] = await Promise.all([
		groups.getNonPrivilegeGroups('groups:createtime', 0, -1),
		categories.getAllCategoryFields(['cid', 'name']),
		collectStats(),
	]);
	res.render('admin/plugins/post-follow', {
		title: '[[post-follow:admin-title]]',
		defaultMinEditChars: DEFAULT_MIN_EDIT_CHARS,
		defaultMaxFollowedPosts: DEFAULT_MAX_FOLLOWED_POSTS,
		defaultCleanupDays: DEFAULT_CLEANUP_DAYS,
		groups: groupsData
			.filter(group => group && group.name && !['guests', 'spiders'].includes(group.name))
			.map(group => ({ name: group.name, displayName: group.displayName || group.name })),
		categories: categoriesData
			.filter(category => category && category.cid)
			.map(category => ({ cid: category.cid, name: validator.unescape(String(category.name || '')) })),
		stats: stats,
	});
}

// ---------------------------------------------------------------------------
// REST API (/api/v3/plugins/post-follow) and a small JS API for other plugins
// ---------------------------------------------------------------------------

Plugin.addApiRoutes = async function ({ router, middleware, helpers }) {
	const enabled = async (req, res, next) => {
		if (!(await getAdminSettings()).enableApi) {
			return helpers.formatApiResponse(404, res);
		}
		next();
	};
	const guards = [middleware.ensureLoggedIn, enabled];
	const base = '/post-follow/posts';
	const pidOf = (req) => {
		const pid = parsePid(req.params.pid);
		if (!pid) {
			throw new Error('[[error:invalid-data]]');
		}
		return pid;
	};

	// List the posts the caller follows.
	routeHelpers.setupApiRoute(router, 'get', base, guards, async (req, res) => {
		const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
		const start = Math.max(0, parseInt(req.query.start, 10) || 0);
		const entries = await db.getSortedSetRevRangeWithScores(userPostsKey(req.uid), start, start + limit - 1);
		const prefsList = entries.length ? await db.getObjects(entries.map(e => prefsKey(e.value, req.uid))) : [];
		helpers.formatApiResponse(200, res, {
			count: await db.sortedSetCard(userPostsKey(req.uid)),
			posts: entries.map((entry, i) => ({
				pid: parseInt(entry.value, 10),
				followedAt: entry.score,
				prefs: parsePrefs(prefsList[i]),
			})),
		});
	});

	routeHelpers.setupApiRoute(router, 'get', `${base}/:pid`, guards, async (req, res) => {
		helpers.formatApiResponse(200, res, await getFollowState(req.uid, pidOf(req)));
	});

	// Follow a post, or change which events notify the caller. Body: { edit, delete, restore, reply, topic }.
	routeHelpers.setupApiRoute(router, 'put', `${base}/:pid`, guards, async (req, res) => {
		helpers.formatApiResponse(200, res, await Plugin.api.follow(req.uid, pidOf(req), req.body));
	});

	routeHelpers.setupApiRoute(router, 'delete', `${base}/:pid`, guards, async (req, res) => {
		helpers.formatApiResponse(200, res, await Plugin.api.unfollow(req.uid, pidOf(req)));
	});
};

// For other plugins:  const postFollow = require.main.require('nodebb-plugin-post-follow');
//                     await postFollow.api.follow(uid, pid, { edit: true, reply: true });
// Follows made through it obey the same privilege, limit and blocklist rules as the UI.
Plugin.api = {
	// Follows `pid` for `uid`; with `prefs` it also (re)sets the chosen events.
	async follow(uid, pid, prefs) {
		uid = parseInt(uid, 10);
		pid = parsePid(pid);
		if (!uid || uid <= 0 || !pid) {
			throw new Error('[[error:invalid-data]]');
		}
		const state = await getFollowState(uid, pid);
		const chosen = readPrefsFromData(prefs, state.prefs);
		if (!EVENTS.some(event => chosen[event])) {
			throw new Error('[[post-follow:need-one-event]]');
		}
		if (state.following) {
			await db.setObject(prefsKey(pid, uid), serializePrefs(chosen));
		} else {
			await followWithChecks(uid, pid, chosen);
		}
		return { following: true, prefs: chosen };
	},
	async unfollow(uid, pid) {
		uid = parseInt(uid, 10);
		pid = parsePid(pid);
		if (!uid || uid <= 0 || !pid) {
			throw new Error('[[error:invalid-data]]');
		}
		await unfollowPost(uid, pid);
		return { following: false, prefs: { ...DEFAULT_PREFS } };
	},
	async isFollowing(uid, pid) {
		return (await getFollowState(parseInt(uid, 10), parsePid(pid))).following;
	},
	async getFollowedPids(uid, start = 0, stop = -1) {
		return (await db.getSortedSetRevRange(userPostsKey(parseInt(uid, 10)), start, stop)).map(Number);
	},
};

// ---------------------------------------------------------------------------
// Separate notification type (shows up in the user's notification settings)
// ---------------------------------------------------------------------------

Plugin.addNotificationType = async function (data) {
	data.types.push(`notificationType_${NOTIFICATION_TYPE}`);
	return data;
};

Plugin.__renderAdminPageForTest = renderAdminPage;
Plugin.__runCleanupForTest = runCleanup;
