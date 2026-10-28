'use strict';

/*
 * Logic tests: the real library.js against a FAKE NodeBB (see test/helpers/mock-nodebb.js).
 * Run with:  npm test
 * These do not prove the plugin works inside a real NodeBB. For that, see test/integration.
 */

const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const m = require('./helpers/mock-nodebb');

const { env, store, S, Z, db, sent, topicWatchers, userSettings, apiRoutes, postData, topicData, moreTopicFields, mocks } = m;
const plugin = m.loadPlugin();
const sockets = mocks['./src/socket.io/plugins'];

const call = (method, uid, data) => sockets.postFollow[method]({ uid }, data);
let r;
let st;
let edit;

before(async () => {
	await plugin.init({ router: {}, middleware: {} });
});

test('follow / state / prefs', async () => {
	r = await call('toggle', 2, { pid: 100 });
	assert.deepStrictEqual(r, { following: true, prefs: { edit: true, delete: false, restore: false, reply: false, topic: false } });
	await call('toggle', 3, { pid: 100 });
	await call('setPrefs', 3, { pid: 100, edit: false, delete: true, restore: true, reply: false, topic: false });
	await call('toggle', 4, { pid: 100 });
	await call('toggle', 5, { pid: 100 });
	await call('toggle', 1, { pid: 100 }); // the editor follows his own post
	await assert.rejects(call('setPrefs', 3, { pid: 100, edit: false, delete: false, restore: false, reply: false, topic: false }), /need-one-event/);
	await assert.rejects(call('setPrefs', 9, { pid: 100, edit: true }), /invalid-data/);
	st = await call('getStates', 3, { pids: [100, 101, 'x'] });
	assert.deepStrictEqual(st.states[100], { following: true, blocked: false, prefs: { edit: false, delete: true, restore: true, reply: false, topic: false } });
	assert.strictEqual(st.states[101].following, false);
});

test('edit notifications', async () => {
	topicWatchers.add('4');
	topicWatchers.add('5');
	userSettings[4] = {}; // default => core notifies => we skip
	userSettings[5] = { 'notificationType_post-edit': 'none' }; // core silent => we notify

	edit = (oldC, newC) => plugin.onPostEdit({
		post: { pid: 100, tid: 10, changed: oldC !== newC, oldContent: oldC, newContent: newC },
		data: { content: newC },
		uid: 1,
	});

	await edit('hello world', 'hello world!'); // 1 char, default threshold 3 => ignored
	assert.strictEqual(sent.length, 0, 'tiny edit must be ignored');
	await edit('hello world', 'hello brave new world');
	assert.strictEqual(sent.length, 1);
	assert.deepStrictEqual(sent[0].uids, ['2', '5'], 'followers: 2 (edit), 5 (watcher w/ post-edit off); not 1 (editor), not 3 (delete only), not 4 (core covers)');
	assert.strictEqual(sent[0].notification.nid, 'post-follow:edit:100');

	sent.length = 0;
	env.settingsHash = { minEditChars: '0' };
	await edit('hello world', 'hello world!');
	assert.strictEqual(sent.length, 1, 'threshold 0 notifies on every change');
	sent.length = 0;
	env.settingsHash = { minEditChars: '50' };
	await edit('a'.repeat(10), 'b'.repeat(10));
	assert.strictEqual(sent.length, 0, 'edit smaller than 50 ignored');
	env.settingsHash = {};
	await plugin.onPostEdit({ post: { pid: 100, tid: 10, changed: false }, uid: 1 });
	assert.strictEqual(sent.length, 0);
});

test('delete / restore', async () => {
	await plugin.onPostDelete({ post: { pid: 100, tid: 10 }, uid: 7 });
	assert.deepStrictEqual(sent[0].uids, ['3']);
	assert.ok(sent[0].notification.bodyShort.startsWith('post-follow:notification-deleted'));
	sent.length = 0;
	await plugin.onPostRestore({ post: { pid: 100, tid: 10 }, uid: 7 });
	assert.deepStrictEqual(sent[0].uids, ['3']);
	assert.ok(sent[0].notification.bodyShort.startsWith('post-follow:notification-restored'));
});

test('purge', async () => {
	sent.length = 0;
	await plugin.onPostsPurge({ posts: [{ pid: 100, tid: 10, deleted: 0 }], uid: 7 });
	assert.deepStrictEqual(sent[0].uids, ['3']);
	assert.strictEqual(sent[0].notification.path, '/topic/10');
	assert.strictEqual((await db.getSetMembers('post-follow:pid:100:followers')).length, 0);
	assert.strictEqual(await db.sortedSetCard('post-follow:uid:3:pids'), 0);
	assert.strictEqual(store.hashes['post-follow:prefs:100:3'], undefined);
	await call('toggle', 3, { pid: 200 });
	await call('setPrefs', 3, { pid: 200, edit: false, delete: true, restore: false, reply: false, topic: false });
	sent.length = 0;
	await plugin.onPostsPurge({ posts: [{ pid: 200, tid: 10, deleted: 1 }], uid: 7 });
	assert.strictEqual(sent.length, 0, 'already soft-deleted posts do not notify again on purge');
});

test('auto follow + settings', async () => {
	await plugin.onPostSave({ post: { pid: 300, uid: 8, tid: 10 } });
	assert.strictEqual(await db.isSetMember('post-follow:pid:300:followers', 8), false);
	const hook = { settings: {}, data: { postFollowAuto: 1, postFollowAutoEdit: 0, postFollowAutoDelete: 1, postFollowAutoRestore: 0 } };
	await plugin.saveCustomSettings(hook);
	assert.deepStrictEqual(hook.settings, { postFollowAuto: 1, postFollowAutoEdit: 0, postFollowAutoDelete: 1, postFollowAutoRestore: 0 });
	store.hashes['user:8:settings'] = hook.settings;
	await plugin.onPostSave({ post: { pid: 300, uid: 8, tid: 10 } });
	st = await call('getStates', 8, { pids: [300] });
	assert.deepStrictEqual(st.states[300], { following: true, blocked: false, prefs: { edit: false, delete: true, restore: false, reply: false, topic: false } });
	const none = { settings: {}, data: { postFollowAuto: 1, postFollowAutoEdit: 0, postFollowAutoDelete: 0, postFollowAutoRestore: 0 } };
	await plugin.saveCustomSettings(none);
	assert.strictEqual(none.settings.postFollowAutoEdit, 1, 'auto follow without events falls back to edits');
	await plugin.onPostSave({ post: { pid: 301, uid: 0 } }); // guest => nothing
	const html = (await plugin.addCustomSettings({ uid: 8, settings: hook.settings, customSettings: [] })).customSettings[0].content;
	assert.ok(html.includes('T(he:setting-auto-follow)') && !html.includes('[[post-follow'), 'settings HTML is translated server-side');
	assert.ok(/id="postFollowAuto"[^>]*checked/.test(html) && /id="postFollowAutoDelete"[^>]*checked/.test(html) && !/id="postFollowAutoEdit"[^>]*checked/.test(html));
});

test('unread suppression', async () => {
	env.trackUnread = true;
	sent.length = 0;
	await call('toggle', 50, { pid: 800 });
	await plugin.onPostEdit({ post: { pid: 800, tid: 10, changed: true, oldContent: 'a', newContent: 'a long new text' }, uid: 1 });
	assert.strictEqual(sent.length, 1);
	await plugin.onPostEdit({ post: { pid: 800, tid: 10, changed: true, oldContent: 'a', newContent: 'another long text' }, uid: 9 });
	assert.strictEqual(sent.length, 1, 'no second notification while the first is unread');
	Z('uid:50:notifications:unread').delete('post-follow:edit:800'); // user read it
	await plugin.onPostEdit({ post: { pid: 800, tid: 10, changed: true, oldContent: 'a', newContent: 'yet another long text' }, uid: 1 });
	assert.strictEqual(sent.length, 2, 'notified again after reading');
	env.trackUnread = false;
});

test('reply / bookmark auto-follow', async () => {
	store.hashes['user:60:settings'] = { postFollowAutoReply: 1, postFollowAutoBookmark: 0, postFollowAutoDelete: 1 };
	await plugin.onPostSave({ post: { pid: 901, uid: 60, tid: 10, toPid: 900 } });
	st = await call('getStates', 60, { pids: [900, 901] });
	assert.strictEqual(st.states[900].following, true, 'replied-to post followed');
	assert.deepStrictEqual(st.states[900].prefs, { edit: false, delete: true, restore: false, reply: false, topic: false });
	assert.strictEqual(st.states[901].following, false, 'own-post trigger is off');
	await plugin.onPostBookmark({ pid: 910, uid: 60 });
	assert.strictEqual(await db.isSetMember('post-follow:pid:910:followers', 60), false);
	store.hashes['user:60:settings'].postFollowAutoBookmark = 1;
	await plugin.onPostBookmark({ pid: 910, uid: 60 });
	assert.strictEqual(await db.isSetMember('post-follow:pid:910:followers', 60), true);
	await call('setPrefs', 60, { pid: 910, edit: true, delete: false, restore: true, reply: false, topic: false });
	await plugin.onPostBookmark({ pid: 910, uid: 60 });
	st = await call('getStates', 60, { pids: [910] });
	assert.deepStrictEqual(st.states[910].prefs, { edit: true, delete: false, restore: true, reply: false, topic: false }, 'existing choices are kept');
});

test('exempt groups', async () => {
	env.settingsHash = { maxFollowedPosts: '1', exemptGroups: JSON.stringify(['vip']) };
	await call('toggle', 70, { pid: 1 });
	await assert.rejects(call('toggle', 70, { pid: 2 }), /limit-reached/);
	env.memberOf = new Set(['70']);
	await call('toggle', 70, { pid: 2 });
	await call('toggle', 70, { pid: 3 });
	env.memberOf = new Set();
	env.settingsHash = {};
});

test('bulk unfollow & followed page', async () => {
	for (const pid of [1001, 1002, 1003, 1004, 1005]) await call('toggle', 80, { pid });
	topicData[10] = { tid: 10, cid: 1, title: 'Open topic', deleted: 0, locked: 0 };
	topicData[11] = { tid: 11, cid: 2, title: 'Locked topic', deleted: 0, locked: 1 };
	topicData[12] = { tid: 12, cid: 2, title: 'Gone topic', deleted: 1, locked: 0 };
	postData[1001] = { pid: 1001, tid: 10, deleted: 0 };
	postData[1002] = { pid: 1002, tid: 10, deleted: 1 };
	postData[1003] = { pid: 1003, tid: 11, deleted: 0 };
	postData[1004] = { pid: 1004, tid: 12, deleted: 0 };
	// 1005 has no post data => missing
	let rendered;
	const req = { uid: 80, query: { cid: '2' } };
	const res = { locals: { userData: { uid: 80, userslug: 'u', username: 'u' } }, render: (t, d) => { rendered = d; } };
	const renderPage = async (query) => {
		const f = plugin.__renderFollowedPostsForTest; // set below if exposed
		return f({ uid: 80, query }, res);
	};
	if (plugin.__renderFollowedPostsForTest) {
		await renderPage({ cid: '2' });
		assert.deepStrictEqual(rendered.posts.map(p => Number(p.pid)).sort(), [1003, 1004]);
		assert.strictEqual(rendered.posts.find(p => p.pid === 1003).pfTopicLocked, true);
		assert.strictEqual(rendered.posts.find(p => p.pid === 1004).pfTopicDeleted, true);
		await renderPage({ q: 'open' });
		assert.deepStrictEqual(rendered.posts.map(p => Number(p.pid)).sort(), [1001, 1002]);
		assert.strictEqual(rendered.posts.find(p => p.pid === 1002).pfPostDeleted, true);
		assert.strictEqual(rendered.pfTotalFollowed, 5);
	}
	r = await call('unfollowUnavailable', 80, {});
	assert.strictEqual(r.count, 4, 'deleted post, locked topic, deleted topic and missing post');
	assert.strictEqual(await db.sortedSetCard('post-follow:uid:80:pids'), 1);
	r = await call('unfollowAll', 80, {});
	assert.strictEqual(r.count, 1);
	assert.strictEqual(await db.sortedSetCard('post-follow:uid:80:pids'), 0);
	assert.strictEqual((await db.getSetMembers('post-follow:pid:1001:followers')).length, 0);
});

test('admin page', async () => {
	let adminData;
	plugin.__renderAdminPageForTest && await plugin.__renderAdminPageForTest({}, { render: (t, d) => { adminData = d; } });
	if (adminData) assert.deepStrictEqual(adminData.groups.map(g => g.name), ['vip']);
});

test('direct reply notifications', async () => {
	postData[500] = { pid: 500, tid: 10, uid: 1, deleted: 0, timestamp: 1000, edited: 0 };
	topicData[10] = { tid: 10, cid: 1, title: 'Open topic', deleted: 0, locked: 0 };
	await call('toggle', 100, { pid: 500 });
	await call('setPrefs', 100, { pid: 500, edit: true, reply: true, topic: true });
	await call('toggle', 101, { pid: 500 }); // edits only
	sent.length = 0;
	await plugin.onPostSave({ post: { pid: 501, uid: 7, tid: 10, toPid: 500 } });
	assert.strictEqual(sent.length, 1);
	assert.deepStrictEqual(sent[0].uids, ['100'], 'only followers who chose replies');
	assert.strictEqual(sent[0].notification.path, '/post/501');
	assert.strictEqual(sent[0].notification.nid, 'post-follow:reply:500');
	assert.ok(sent[0].notification.bodyShort.startsWith('post-follow:notification-replied'));
	topicWatchers.add('100'); userSettings[100] = {}; sent.length = 0;
	await plugin.onPostSave({ post: { pid: 502, uid: 7, tid: 10, toPid: 500 } });
	assert.strictEqual(sent.length, 0, 'topic watchers already get core new-reply notifications');
	userSettings[100] = { 'notificationType_new-reply': 'none' };
	await plugin.onPostSave({ post: { pid: 503, uid: 7, tid: 10, toPid: 500 } });
	assert.strictEqual(sent.length, 1, 'watcher with new-reply off still gets ours');
	topicWatchers.delete('100');
	await plugin.onPostSave({ post: { pid: 504, uid: 100, tid: 10, toPid: 500 } }); // own reply: no self notification
	assert.strictEqual(sent.length, 1);
});

test('topic level notifications', async () => {
	moreTopicFields[10] = { mainPid: 400 };
	postData[400] = { pid: 400, tid: 10, uid: 1, deleted: 0, timestamp: 500, edited: 0 };
	[500, 501, 502].forEach(pid => Z('tid:10:posts').set(String(pid), 1));
	await call('toggle', 102, { pid: 400 });
	await call('setPrefs', 102, { pid: 400, edit: true, topic: true });
	await call('toggle', 103, { pid: 500 }); // no topic option
	sent.length = 0;
	await plugin.onTopicLock({ topic: { tid: 10, locked: true }, uid: 7 });
	assert.deepStrictEqual(sent[0].uids, ['100', '102']);
	assert.strictEqual(sent[0].notification.nid, 'post-follow:topic-locked:10');
	assert.strictEqual(sent[0].notification.path, '/topic/10');
	sent.length = 0;
	await plugin.onTopicLock({ topic: { tid: 10, locked: true }, uid: 100 });
	assert.deepStrictEqual(sent[0].uids, ['102'], 'the actor is not notified');
	sent.length = 0;
	await plugin.onTopicPin({ topic: { tid: 10, pinned: false }, uid: 7 });
	assert.ok(sent[0].notification.bodyShort.startsWith('post-follow:notification-topic-unpinned'));
	sent.length = 0;
	await plugin.onTopicMove({ tid: 10, fromCid: 1, toCid: 2, uid: 7 });
	assert.ok(sent[0].notification.bodyShort.endsWith('|cat2'), 'names the new category');
	sent.length = 0;
	await plugin.onTopicMove({ tid: 10, fromCid: 2, toCid: 2, uid: 7 });
	assert.strictEqual(sent.length, 0, 'same category is no move');
	await plugin.onTopicEdit({ topic: { tid: 10, mainPid: 400, title: 'New', oldTitle: 'New' }, uid: 7 });
	assert.strictEqual(sent.length, 0, 'unchanged title');
	await plugin.onTopicEdit({ topic: { tid: 10, mainPid: 400, title: 'New', oldTitle: 'Old' }, uid: 7 });
	assert.deepStrictEqual(sent[0].uids, ['102'], 'title change only reaches followers of the first post');
	assert.ok(sent[0].notification.bodyShort.includes('Old'));
});

test('blocklist', async () => {
	env.settingsHash = { blockedCategories: '["1"]' };
	await assert.rejects(call('toggle', 110, { pid: 500 }), /follow-blocked/);
	st = await call('getStates', 110, { pids: [500] });
	assert.strictEqual(st.states[500].blocked, true);
	sent.length = 0;
	await plugin.onTopicLock({ topic: { tid: 10, locked: true }, uid: 7 });
	await plugin.onPostSave({ post: { pid: 505, uid: 7, tid: 10, toPid: 500 } });
	assert.strictEqual(sent.length, 0, 'no notifications in blocked categories');
	env.settingsHash = { blockedTopics: '9, 10' };
	await assert.rejects(call('toggle', 110, { pid: 500 }), /follow-blocked/);
	env.settingsHash = { blockedPosts: '500' };
	await assert.rejects(call('toggle', 110, { pid: 500 }), /follow-blocked/);
	await call('toggle', 110, { pid: 400 }); // other posts are fine
	env.settingsHash = {};
});

test('bulk follow', async () => {
	[[600, 120, 0], [601, 121, 0], [602, 120, 0], [603, 120, 1]].forEach(([pid, uid, deleted]) => {
		postData[pid] = { pid, tid: 10, uid, deleted, timestamp: 100, edited: 0 };
		Z('tid:10:posts').set(String(pid), 1);
	});
	r = await call('followBulk', 120, { pid: 601, scope: 'mine', edit: true, topic: true });
	assert.strictEqual(r.count, 2, 'my two live posts (the deleted one is skipped)');
	st = await call('getStates', 120, { pids: [600, 603] });
	assert.strictEqual(st.states[600].following, true);
	assert.strictEqual(st.states[600].prefs.topic, true);
	assert.strictEqual(st.states[603].following, false);
	r = await call('followBulk', 122, { pid: 600, scope: 'author' });
	assert.strictEqual(r.count, 2, "all live posts of that post's author");
	r = await call('followBulk', 122, { pid: 600, scope: 'author' });
	assert.strictEqual(r.count, 0, 'already followed posts are not touched again');
	r = await call('followBulk', 123, { pid: 600, scope: 'all' });
	assert.ok(r.count >= 5, 'all live posts of the topic');
	env.settingsHash = { maxFollowedPosts: '2' };
	r = await call('followBulk', 124, { pid: 600, scope: 'all' });
	assert.strictEqual(r.count, 2);
	assert.ok(r.skipped > 0, 'the limit is respected and reported');
	await assert.rejects(call('followBulk', 124, { pid: 600, scope: 'all' }), /limit-reached/);
	env.settingsHash = {};
	await assert.rejects(call('followBulk', 124, { pid: 600, scope: 'nope' }), /invalid-data/);
});

test('sorting', async () => {
	postData[700] = { pid: 700, tid: 10, uid: 1, deleted: 0, timestamp: 300, edited: 0 };
	postData[701] = { pid: 701, tid: 11, uid: 1, deleted: 0, timestamp: 100, edited: 500 };
	topicData[11] = { tid: 11, cid: 2, title: 'Locked topic', deleted: 0, locked: 1 };
	await call('toggle', 130, { pid: 700 });
	await call('toggle', 130, { pid: 701 });
	let sortRes;
	const sortedFor = async (sort) => {
		await plugin.__renderFollowedPostsForTest({ uid: 130, query: { sort } }, { locals: { userData: { uid: 130, userslug: 'u', username: 'u' } }, render: (t, d) => { sortRes = d; } });
		return sortRes.posts.map(x => Number(x.pid));
	};
	assert.deepStrictEqual(await sortedFor('followed'), [701, 700], 'most recently followed first');
	assert.deepStrictEqual(await sortedFor('edited'), [701, 700], 'edited posts first, never edited last');
	assert.deepStrictEqual(await sortedFor('posted'), [700, 701], 'newest post first');
	assert.deepStrictEqual(await sortedFor('topic'), [701, 700], 'topic title A-Z');
	assert.strictEqual(sortRes.pfSortTopic, true);
	assert.deepStrictEqual(await sortedFor('bogus'), [701, 700]);
});

test('cleanup job + admin statistics', async () => {
	await call('toggle', 140, { pid: 800 }); // no post data => the post vanished
	postData[801] = { pid: 801, tid: 10, uid: 1, deleted: 1, timestamp: 1, edited: 0 };
	await call('toggle', 140, { pid: 801 });
	env.settingsHash = { cleanupDays: '1' };
	r = await plugin.__runCleanupForTest();
	assert.ok(r.posts >= 1 && (await db.getSetMembers('post-follow:pid:800:followers')).length === 0, 'vanished posts are cleaned');
	assert.strictEqual((await db.getSetMembers('post-follow:pid:801:followers')).length, 1, 'recently deleted posts are kept');
	assert.ok(Z('post-follow:deleted-seen').has('801'), 'first sighting recorded');
	Z('post-follow:deleted-seen').set('801', Date.now() - 2 * 86400000);
	await plugin.__runCleanupForTest();
	assert.strictEqual((await db.getSetMembers('post-follow:pid:801:followers')).length, 0, 'deleted for longer than the grace period: removed');
	assert.strictEqual(await db.sortedSetCard('post-follow:uid:140:pids'), 0);
	env.settingsHash = {};
	await assert.rejects(call('runCleanup', 5, {}), /no-privileges/);
	assert.ok(typeof (await call('runCleanup', 999, {})).posts === 'number');
	let adminStats;
	await plugin.__renderAdminPageForTest({}, { render: (t, d) => { adminStats = d; } });
	assert.ok(adminStats.stats.totalFollows > 10 && adminStats.stats.usersFollowing > 5 && adminStats.stats.distinctPosts > 5);
	assert.ok(adminStats.stats.sent.total > 0 && adminStats.stats.sent.reply >= 2 && adminStats.stats.sent.topic >= 3);
	assert.ok(adminStats.stats.topPosts.length > 0 && adminStats.stats.topPosts[0].followers >= adminStats.stats.topPosts[1].followers);
	assert.deepStrictEqual(adminStats.categories.map(c => c.cid), [1, 2]);
});

test('REST + JS API', async () => {
	const apiRes = () => ({ status: null, payload: null });
	const helpersMock = { formatApiResponse: (code, res, payload) => { res.status = code; res.payload = payload; } };
	await plugin.addApiRoutes({ router: {}, middleware: { ensureLoggedIn: () => {} }, helpers: helpersMock });
	const route = (verb, name) => apiRoutes.find(x => x.verb === verb && x.name === name);
	const guard = route('put', '/post-follow/posts/:pid').mws[1];
	let res404 = apiRes(); let nextCalled = false;
	await guard({}, res404, () => { nextCalled = true; });
	assert.strictEqual(res404.status, 404);
	assert.strictEqual(nextCalled, false, 'API is off by default');
	env.settingsHash = { enableApi: 'on' };
	await guard({}, apiRes(), () => { nextCalled = true; });
	assert.strictEqual(nextCalled, true);
	let out = apiRes();
	await route('put', '/post-follow/posts/:pid').ctrl({ uid: 150, params: { pid: '900' }, body: { edit: true, reply: true } }, out);
	assert.deepStrictEqual(out.payload, { following: true, prefs: { edit: true, delete: false, restore: false, reply: true, topic: false } });
	out = apiRes();
	await route('get', '/post-follow/posts/:pid').ctrl({ uid: 150, params: { pid: '900' } }, out);
	assert.strictEqual(out.payload.following, true);
	out = apiRes();
	await route('get', '/post-follow/posts').ctrl({ uid: 150, query: {} }, out);
	assert.strictEqual(out.payload.count, 1);
	assert.strictEqual(out.payload.posts[0].pid, 900);
	await route('put', '/post-follow/posts/:pid').ctrl({ uid: 150, params: { pid: '900' }, body: { edit: false, delete: true } }, apiRes());
	assert.strictEqual((await plugin.api.isFollowing(150, 900)), true);
	st = await call('getStates', 150, { pids: [900] });
	assert.deepStrictEqual(st.states[900].prefs, { edit: false, delete: true, restore: false, reply: false, topic: false });
	await assert.rejects(plugin.api.follow(150, 901, { edit: false, delete: false }), /need-one-event/);
	await assert.rejects(plugin.api.follow(0, 901, {}), /invalid-data/);
	out = apiRes();
	await route('delete', '/post-follow/posts/:pid').ctrl({ uid: 150, params: { pid: '900' } }, out);
	assert.strictEqual(out.payload.following, false);
	assert.deepStrictEqual(await plugin.api.getFollowedPids(150), []);
	env.settingsHash = {};
});

test('settings UI covers the new events', async () => {
	const settingsHtml = (await plugin.addCustomSettings({ uid: 8, settings: {}, customSettings: [] })).customSettings[0].content;
	assert.ok(settingsHtml.includes('postFollowAutoNotifyReply') && settingsHtml.includes('postFollowAutoNotifyTopic') && settingsHtml.includes('postFollowAutoReply'));
});

test('user deletion', async () => {
	await plugin.onUserDelete({ uid: 8 });
	assert.strictEqual((await db.getSetMembers('post-follow:pid:300:followers')).length, 0);
});

test('follow limit', async () => {
	env.settingsHash = { maxFollowedPosts: '2' };
	await call('toggle', 20, { pid: 1 });
	await call('toggle', 20, { pid: 2 });
	await assert.rejects(call('toggle', 20, { pid: 3 }), /limit-reached, 2/);
	await call('toggle', 20, { pid: 1 }); // unfollowing always works
	await call('toggle', 20, { pid: 3 }); // and frees a slot
	store.hashes['user:21:settings'] = { postFollowAuto: 1, postFollowAutoEdit: 1 };
	await call('toggle', 21, { pid: 1 });
	await call('toggle', 21, { pid: 2 });
	await plugin.onPostSave({ post: { pid: 400, uid: 21, tid: 10 } });
	assert.strictEqual(await db.isSetMember('post-follow:pid:400:followers', 21), false, 'auto-follow stops at the limit');
	env.settingsHash = { maxFollowedPosts: '0' };
	await call('toggle', 20, { pid: 4 });
	await call('toggle', 20, { pid: 5 });
	await call('toggle', 20, { pid: 6 }); // 0 = unlimited
	env.settingsHash = {};
	assert.strictEqual(await db.sortedSetCard('post-follow:uid:20:pids'), 5);
});

test('notification type', async () => {
	const types = await plugin.addNotificationType({ types: ['notificationType_upvote'], privilegedTypes: [] });
	assert.ok(types.types.includes('notificationType_post-follow'));
	sent.length = 0;
	await plugin.onPostDelete({ post: { pid: 200, tid: 10 }, uid: 7 });
	await call('toggle', 30, { pid: 600 });
	await call('setPrefs', 30, { pid: 600, edit: true, delete: true, restore: false, reply: false, topic: false });
	await plugin.onPostDelete({ post: { pid: 600, tid: 10 }, uid: 7 });
	assert.strictEqual(sent[sent.length - 1].notification.type, 'post-follow');
});

test('profile counts', async () => {
	await call('toggle', 40, { pid: 700 });
	const own = await plugin.addProfileCounts({ userData: { uid: 40, counts: {} }, callerUID: 40 });
	assert.strictEqual(own.userData.counts.followedPosts, 1);
	const other = await plugin.addProfileCounts({ userData: { uid: 40, counts: {} }, callerUID: 41 });
	assert.strictEqual(other.userData.counts.followedPosts, undefined, 'count only on own profile');
});

test('profile menu', async () => {
	const menu = await plugin.addProfileMenu({ links: [] });
	assert.strictEqual(menu.links[0].route, 'followed-posts');
});
