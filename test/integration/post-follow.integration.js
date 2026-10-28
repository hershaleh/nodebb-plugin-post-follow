'use strict';

/*
 * INTEGRATION tests: the plugin running inside a REAL NodeBB (real database, real hooks,
 * real notifications, real HTTP routes). Nothing is faked.
 *
 * This file is a mocha test and is meant to be started by test/integration/run.js, which
 * expects a prepared NodeBB checkout (see the README, "Running the tests").
 *
 * It uses NodeBB's own test mock (test/mocks/databasemock.js), which switches NodeBB to the
 * `test_database` from config.json and EMPTIES that database before it starts.
 */

const path = require('path');
const assert = require('node:assert/strict');

const NODEBB_DIR = process.env.NODEBB_DIR;
if (!NODEBB_DIR) {
	throw new Error('NODEBB_DIR is not set. Start these tests with: NODEBB_DIR=/path/to/nodebb npm run test:integration');
}
const nb = file => require(path.join(NODEBB_DIR, file));

const db = nb('test/mocks/databasemock');
const nconf = require(path.join(NODEBB_DIR, 'node_modules/nconf'));
const helpers = nb('test/helpers');
const request = nb('src/request');
const User = nb('src/user');
const Groups = nb('src/groups');
const Categories = nb('src/categories');
const Topics = nb('src/topics');
const Posts = nb('src/posts');
const meta = nb('src/meta');
const plugins = nb('src/plugins');
const apiPosts = nb('src/api/posts');
const SocketPlugins = nb('src/socket.io/plugins');

const PLUGIN_ID = 'nodebb-plugin-post-follow';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const unreadNids = uid => db.getSortedSetRange(`uid:${uid}:notifications:unread`, 0, -1);
const clearUnread = uids => Promise.all([].concat(uids).map(uid => db.delete(`uid:${uid}:notifications:unread`)));

// NodeBB delivers notifications with a short delay, so poll for them.
async function waitForNotification(uid, nid, timeout = 12000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		// eslint-disable-next-line no-await-in-loop
		if ((await unreadNids(uid)).includes(nid)) {
			return true;
		}
		// eslint-disable-next-line no-await-in-loop
		await sleep(250);
	}
	return false;
}

async function assertNoNotification(uid, nid) {
	await sleep(2000); // longer than NodeBB's delivery delay
	assert.ok(!(await unreadNids(uid)).includes(nid), `uid ${uid} should NOT have ${nid}`);
}

const follow = (uid, pid) => SocketPlugins.postFollow.toggle({ uid }, { pid });
const setPrefs = (uid, pid, prefs) => SocketPlugins.postFollow.setPrefs({ uid }, { pid, ...prefs });
const ALL = { edit: true, delete: true, restore: true, reply: true, topic: true };

async function setAdminSettings(values) {
	await db.delete('settings:post-follow');
	if (Object.keys(values).length) {
		await meta.settings.set('post-follow', values);
	}
}

describe('nodebb-plugin-post-follow inside a real NodeBB', function () {
	this.timeout(60000);

	let adminUid; let authorUid; let fanUid; let bystanderUid; let watcherUid; let quietUid; let replierUid;
	let cid; let cid2; let tid; let mainPid; let pid;
	const password = 'Passw0rd!x';

	before(async () => {
		const names = ['pfadmin', 'pfauthor', 'pffan', 'pfbystander', 'pfwatcher', 'pfquiet', 'pfreplier'];
		const uids = [];
		for (const username of names) {
			// eslint-disable-next-line no-await-in-loop
			uids.push(await User.create({ username, password }));
		}
		[adminUid, authorUid, fanUid, bystanderUid, watcherUid, quietUid, replierUid] = uids;
		await Groups.join('administrators', adminUid);

		({ cid } = await Categories.create({ name: 'Post follow test', description: 'x' }));
		({ cid: cid2 } = await Categories.create({ name: 'Post follow target', description: 'x' }));
		const topic = await Topics.post({ uid: authorUid, cid, title: 'Post follow integration topic', content: 'The first post of the topic.' });
		tid = topic.topicData.tid;
		mainPid = topic.postData.pid;
		const reply = await Topics.reply({ uid: authorUid, tid, content: 'A reply that people will follow.' });
		pid = reply.pid;
	});

	beforeEach(async () => {
		await setAdminSettings({});
	});

	it('is installed, active and has registered its hooks and socket methods', async () => {
		assert.equal(await plugins.isActive(PLUGIN_ID), true, `${PLUGIN_ID} is not active: is it in config.json "test_plugins" and in node_modules?`);
		assert.equal(typeof SocketPlugins.postFollow.toggle, 'function');
		assert.equal(typeof SocketPlugins.postFollow.followBulk, 'function');
	});

	it('follows and unfollows a post (stored in the real database)', async () => {
		const res = await follow(fanUid, pid);
		assert.equal(res.following, true);
		assert.equal(await db.isSetMember(`post-follow:pid:${pid}:followers`, fanUid), true);
		assert.equal(await db.isSortedSetMember(`post-follow:uid:${fanUid}:pids`, pid), true);
		const unfollowed = await follow(bystanderUid, pid).then(() => follow(bystanderUid, pid));
		assert.equal(unfollowed.following, false);
		assert.equal(await db.isSetMember(`post-follow:pid:${pid}:followers`, bystanderUid), false);
	});

	it('notifies followers (and only them) about a real edit', async () => {
		await clearUnread([fanUid, bystanderUid, adminUid]);
		await apiPosts.edit({ uid: adminUid }, { pid, content: 'A reply that people will follow, now edited by an admin.' });
		assert.equal(await waitForNotification(fanUid, `post-follow:edit:${pid}`), true, 'follower was not notified');
		assert.ok(!(await unreadNids(bystanderUid)).includes(`post-follow:edit:${pid}`));
		assert.ok(!(await unreadNids(adminUid)).includes(`post-follow:edit:${pid}`), 'the editor must not notify themselves');

		const notification = await db.getObject(`notifications:post-follow:edit:${pid}`);
		assert.equal(notification.type, 'post-follow');
		assert.equal(String(notification.pid), String(pid));
		assert.ok(String(notification.path).includes(`/post/${pid}`));
	});

	it('ignores tiny edits (ACP threshold)', async () => {
		await clearUnread(fanUid);
		await apiPosts.edit({ uid: adminUid }, { pid, content: 'A reply that people will follow, now edited by an admin!' });
		await assertNoNotification(fanUid, `post-follow:edit:${pid}`);
	});

	it('does not send a second notification while the first one is unread, and does after it was read', async () => {
		await clearUnread(fanUid);
		await apiPosts.edit({ uid: adminUid }, { pid, content: 'Completely different words for the unread test.' });
		assert.equal(await waitForNotification(fanUid, `post-follow:edit:${pid}`), true);
		const before = await db.getSortedSetRangeWithScores(`uid:${fanUid}:notifications:unread`, 0, -1);
		await apiPosts.edit({ uid: adminUid }, { pid, content: 'Yet another long rewrite of the same post text.' });
		await sleep(2000);
		const after = await db.getSortedSetRangeWithScores(`uid:${fanUid}:notifications:unread`, 0, -1);
		assert.deepEqual(after, before, 'the unread notification must not be refreshed');
	});

	it('de-duplicates against the core edit notification for topic watchers', async () => {
		await follow(watcherUid, pid);
		await follow(quietUid, pid);
		await Topics.follow(tid, watcherUid);
		await Topics.follow(tid, quietUid);
		await User.setSetting(quietUid, 'notificationType_post-edit', 'none');
		await clearUnread([watcherUid, quietUid, fanUid]);

		await apiPosts.edit({ uid: adminUid }, { pid, content: 'A fourth, very different text for the watchers.' });
		assert.equal(await waitForNotification(quietUid, `post-follow:edit:${pid}`), true, 'watcher with post-edit turned off must still be notified');
		assert.ok(!(await unreadNids(watcherUid)).includes(`post-follow:edit:${pid}`), 'core already notifies this watcher');
	});

	it('notifies about deletion and restoration only when chosen', async () => {
		await setPrefs(fanUid, pid, { edit: true, delete: false, restore: false });
		await follow(replierUid, pid);
		await setPrefs(replierUid, pid, { edit: false, delete: true, restore: true });
		await clearUnread([fanUid, replierUid]);

		await apiPosts.delete({ uid: adminUid }, { pid, tid });
		assert.equal(await waitForNotification(replierUid, `post-follow:delete:${pid}`), true);
		assert.ok(!(await unreadNids(fanUid)).includes(`post-follow:delete:${pid}`));

		await clearUnread(replierUid);
		await apiPosts.restore({ uid: adminUid }, { pid, tid });
		assert.equal(await waitForNotification(replierUid, `post-follow:restore:${pid}`), true);
	});

	it('notifies about a direct reply', async () => {
		await setPrefs(fanUid, pid, ALL);
		await clearUnread(fanUid);
		const reply = await Topics.reply({ uid: replierUid, tid, content: 'Replying directly to the followed post.', toPid: pid });
		assert.equal(await waitForNotification(fanUid, `post-follow:reply:${pid}`), true);
		const notification = await db.getObject(`notifications:post-follow:reply:${pid}`);
		assert.ok(String(notification.path).includes(`/post/${reply.pid}`));
	});

	it('notifies about a topic being locked, pinned and moved', async () => {
		await setPrefs(fanUid, pid, ALL);
		await clearUnread(fanUid);
		await Topics.tools.lock(tid, adminUid);
		assert.equal(await waitForNotification(fanUid, `post-follow:topic-locked:${tid}`), true, 'lock');
		await Topics.tools.pin(tid, adminUid);
		assert.equal(await waitForNotification(fanUid, `post-follow:topic-pinned:${tid}`), true, 'pin');
		await Topics.tools.move(tid, { cid: cid2, uid: adminUid });
		assert.equal(await waitForNotification(fanUid, `post-follow:topic-moved:${tid}`), true, 'move');
		await Topics.tools.unlock(tid, adminUid);
		await Topics.tools.unpin(tid, adminUid);
	});

	it('notifies followers of the first post when the topic is renamed', async () => {
		await follow(fanUid, mainPid);
		await setPrefs(fanUid, mainPid, ALL);
		await clearUnread(fanUid);
		await apiPosts.edit({ uid: adminUid }, { pid: mainPid, content: 'The first post of the topic.', title: 'A renamed integration topic' });
		assert.equal(await waitForNotification(fanUid, `post-follow:topic-renamed:${tid}`), true);
	});

	it('enforces the follow limit and the exempt groups', async () => {
		await setAdminSettings({ maxFollowedPosts: '1' });
		await follow(bystanderUid, pid);
		await assert.rejects(follow(bystanderUid, mainPid), /limit-reached|post-follow/);
		await setAdminSettings({ maxFollowedPosts: '1', exemptGroups: JSON.stringify(['administrators']) });
		await follow(adminUid, pid);
		await follow(adminUid, mainPid);
		assert.equal(await db.sortedSetCard(`post-follow:uid:${adminUid}:pids`), 2);
		await follow(adminUid, pid);
		await follow(adminUid, mainPid);
		await follow(bystanderUid, pid);
	});

	it('refuses to follow in blocked categories', async () => {
		await setAdminSettings({ blockedCategories: JSON.stringify([String(cid2)]) });
		await assert.rejects(follow(bystanderUid, pid), /follow-blocked/);
	});

	it('follows many posts of a topic at once', async () => {
		const res = await SocketPlugins.postFollow.followBulk({ uid: bystanderUid }, { pid, scope: 'all', edit: true });
		assert.ok(res.count >= 1, 'at least one more post followed');
		assert.equal(await db.isSetMember(`post-follow:pid:${mainPid}:followers`, bystanderUid), true);
	});

	it('serves the REST API only when enabled, as the logged-in user', async () => {
		const { jar } = await helpers.loginUser('pffan', password);
		const url = `/api/v3/plugins/post-follow/posts/${pid}`;

		let res = await helpers.request('get', url, { jar });
		assert.equal(res.response.status, 404, 'API must be off by default');

		await setAdminSettings({ enableApi: 'on' });
		res = await helpers.request('put', url, { jar, body: { edit: true, reply: true } });
		assert.equal(res.response.status, 200);
		assert.equal(res.body.response.following, true);
		assert.equal(res.body.response.prefs.reply, true);

		res = await helpers.request('get', '/api/v3/plugins/post-follow/posts', { jar });
		assert.ok(res.body.response.posts.some(p => p.pid === pid));

		res = await helpers.request('delete', url, { jar });
		assert.equal(res.body.response.following, false);
		await follow(fanUid, pid).then(r => (r.following ? null : follow(fanUid, pid)));
	});

	it('renders the "posts I follow" page for its owner', async () => {
		const { jar } = await helpers.loginUser('pffan', password);
		const slug = await User.getUserField(fanUid, 'userslug');
		const { response, body } = await request.get(`${nconf.get('url')}/api/user/${slug}/followed-posts`, { jar });
		assert.equal(response.status, 200);
		assert.ok(Array.isArray(body.posts));
		assert.ok(body.posts.length >= 1);
	});

	it('removes follow data when a post is permanently deleted, and counts it in the statistics', async () => {
		const extra = await Topics.reply({ uid: authorUid, tid, content: 'A post that will be purged.' });
		await follow(fanUid, extra.pid);
		assert.equal(await db.isSetMember(`post-follow:pid:${extra.pid}:followers`, fanUid), true);
		await Posts.tools.delete(adminUid, extra.pid);
		await Posts.tools.purge(extra.pid, adminUid);
		assert.equal(await db.isSetMember(`post-follow:pid:${extra.pid}:followers`, fanUid), false);
		assert.equal(await db.isSortedSetMember(`post-follow:uid:${fanUid}:pids`, extra.pid), false);

		const result = await SocketPlugins.postFollow.runCleanup({ uid: adminUid });
		assert.equal(typeof result.posts, 'number');
		await assert.rejects(SocketPlugins.postFollow.runCleanup({ uid: fanUid }), /no-privileges/);
		const stats = await db.getObject('post-follow:stats');
		assert.ok(parseInt(stats.sent, 10) > 0, 'notifications were counted');
	});
});
