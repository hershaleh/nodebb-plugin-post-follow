'use strict';

/*
 * FAKE NodeBB, for the logic tests only.
 *
 * Everything the plugin gets from NodeBB (database, notifications, privileges, topics, posts,
 * users, groups, categories, translator, routes, cron...) is replaced here by small in-memory
 * stand-ins written for this repository. The plugin code itself (library.js) is the real file.
 *
 * What this can show: the plugin's own logic behaves as intended under the assumptions made here.
 * What it can NOT show: that the plugin works inside a real NodeBB (real hook payloads, real
 * database, real privileges, real notification delivery, templates, browser code, ACP).
 * That is what test/integration is for.
 */

const path = require('path');


const store = { sets: {}, zsets: {}, hashes: {} };
const S = k => (store.sets[k] = store.sets[k] || new Set());
const Z = k => (store.zsets[k] = store.zsets[k] || new Map());

const db = {
	setAdd: async (k, v) => { S(k).add(String(v)); },
	setRemove: async (k, v) => { S(k).delete(String(v)); },
	setsRemove: async (keys, v) => { keys.forEach(k => S(k).delete(String(v))); },
	isSetMember: async (k, v) => S(k).has(String(v)),
	isMemberOfSets: async (keys, v) => keys.map(k => S(k).has(String(v))),
	getSetMembers: async k => [...S(k)],
	setObject: async (k, o) => { store.hashes[k] = { ...(store.hashes[k] || {}), ...o }; },
	getObjects: async keys => keys.map(k => store.hashes[k] || null),
	getObjectFields: async (k, fields) => {
		const h = store.hashes[k];
		if (!h) return null;
		const out = {};
		fields.forEach((f) => { out[f] = h[f] === undefined ? null : h[f]; });
		return out;
	},
	sortedSetAdd: async (k, s, v) => {
		if (Array.isArray(v)) { v.forEach((x, i) => Z(k).set(String(x), Array.isArray(s) ? s[i] : s)); } else { Z(k).set(String(v), s); }
	},
	setsCount: async keys => keys.map(k => S(k).size),
	setCount: async k => S(k).size,
	getSetsMembers: async keys => keys.map(k => [...S(k)]),
	sortedSetScores: async (k, vs) => vs.map(v => (Z(k).has(String(v)) ? Z(k).get(String(v)) : null)),
	sortedSetsCard: async keys => keys.map(k => Z(k).size),
	getSortedSetRevRangeWithScores: async (k, a, b) => [...Z(k).entries()].sort((x, y) => y[1] - x[1]).slice(a, b === -1 ? undefined : b + 1).map(([value, score]) => ({ value, score })),
	getObject: async k => store.hashes[k] || null,
	getObjectField: async (k, f) => (store.hashes[k] || {})[f] ?? null,
	setObjectField: async (k, f, v) => { store.hashes[k] = { ...(store.hashes[k] || {}), [f]: v }; },
	incrObjectFieldBy: async (k, f, n) => { store.hashes[k] = store.hashes[k] || {}; store.hashes[k][f] = (parseInt(store.hashes[k][f], 10) || 0) + n; },
	sortedSetRemove: async (k, v) => { [].concat(v).forEach(x => Z(k).delete(String(x))); },
	sortedSetsScore: async (keys, v) => keys.map(k => (Z(k).has(String(v)) ? Z(k).get(String(v)) : null)),
	getSortedSetRevRange: async k => [...Z(k).keys()].reverse(),
	sortedSetsRemove: async (keys, v) => { keys.forEach(k => Z(k).delete(String(v))); },
	getSortedSetRange: async k => [...Z(k).keys()],
	sortedSetCard: async k => Z(k).size,
	delete: async (k) => { delete store.sets[k]; delete store.zsets[k]; delete store.hashes[k]; },
	deleteAll: async (keys) => { for (const k of keys) { await db.delete(k); } },
};

const env = {
	settingsHash: {}, // what meta.settings.get('post-follow') returns (the ACP settings)
	trackUnread: false, // let the fake notifications.push mark notifications as unread
	memberOf: new Set(), // uids that count as members of any group
	existingTopics: new Set([10]),
};
const sent = [];
const topicWatchers = new Set();
const userSettings = {};
const apiRoutes = [];
const postData = {}; const topicData = {};
const moreTopicFields = {};

const mocks = {
	validator: { unescape: s => s, escape: s => s },
	winston: { warn: () => {}, error: console.error },
	'./src/database': db,
	'./src/meta': { config: { defaultLang: 'en-GB' }, settings: { get: async () => env.settingsHash } },
	'./src/topics': {
		getFollowers: async () => [...topicWatchers],
		getNotificationTitle: async () => 'Topic title',
		exists: async tid => env.existingTopics.has(tid),
		getTopicsFields: async tids => tids.map(t => topicData[t] || {}),
		getTopicField: async (tid, f) => ({ ...(topicData[tid] || {}), ...(moreTopicFields[tid] || {}) })[f],
	},
	'./src/user': {
		getNotificationDisplayname: async uid => `user${uid}`,
		getMultipleUserSettings: async uids => uids.map(uid => ({ uid, ...(userSettings[uid] || {}) })),
		getSettings: async () => ({ postsPerPage: 20, userLang: 'he' }),
		isAdministrator: async uid => uid === 999,
	},
	'./src/posts': { exists: async () => true, getPostSummariesFromSet: async () => ({ posts: [] }), getPostsFields: async pids => pids.map(p => postData[p] || {}), getPostFields: async pid => postData[pid] || null, getPostSummaryByPids: async pids => pids.map(pid => ({ pid: Number(pid), content: '<b>x</b>' })) },
	'./src/groups': { isMemberOfAny: async (uid, names) => env.memberOf.has(String(uid)), getNonPrivilegeGroups: async () => [{ name: 'vip', displayName: 'VIP' }, { name: 'guests' }] },
	'./src/categories': { getCategoriesFields: async cids => cids.map(cid => ({ cid, name: `cat${cid}` })), getCategoryField: async cid => `cat${cid}`, getAllCategoryFields: async () => [{ cid: 1, name: 'General' }, { cid: 2, name: 'Other' }] },
	'./src/plugins': { hooks: { fire: () => {} } },
	'./src/cron': { hasJob: () => false, addJob: async () => {} },
	'./src/utils': { stripHTMLTags: s => String(s).replace(/<[^>]+>/g, '') },
	'./src/privileges': {
		posts: { can: async () => true, filter: async (p, pids) => pids },
		topics: { filterUids: async (p, tid, uids) => uids, can: async () => true },
	},
	'./src/notifications': {
		create: async data => data,
		push: (notification, uids) => { if (env.trackUnread) uids.forEach(u => Z(`uid:${u}:notifications:unread`).set(notification.nid, 1)); return sent.push({ notification, uids: uids.map(String).sort() }); },
	},
	'./src/pagination': { create: () => ({}) },
	'./src/translator': { compile: (...a) => a.join('|'), translate: async (str, lang) => str.replace(/\[\[post-follow:([a-z-]+)\]\]/g, (m, k) => `T(${lang}:${k})`) },
	'./src/controllers/helpers': { buildBreadcrumbs: c => c },
	'./src/routes/helpers': { setupPageRoute: () => {}, setupAdminPageRoute: () => {}, setupApiRoute: (router, verb, name, mws, ctrl) => apiRoutes.push({ verb, name, mws, ctrl }) },
	'./src/socket.io/plugins': {},
};

const originalRequire = require.main.require.bind(require.main);

// Load the REAL plugin file with `require.main.require` pointing at the fakes above.
function loadPlugin() {
	require.main.require = (name) => {
		if (Object.hasOwn(mocks, name)) {
			return mocks[name];
		}
		if (path.isAbsolute(name)) {
			return originalRequire(name);
		}
		throw new Error(`module ${name} is not faked in test/helpers/mock-nodebb.js`);
	};
	return require(path.join(__dirname, '..', '..', 'library.js'));
}

module.exports = {
	env, store, S, Z, db, sent, topicWatchers, userSettings, apiRoutes,
	postData, topicData, moreTopicFields, mocks, loadPlugin,
};
