'use strict';

/* globals $, app, socket, ajaxify, require */

$(document).ready(function () {
	require(['hooks', 'alerts'], function (hooks, alerts) {
		const EVENTS = ['edit', 'delete', 'restore'];
		const DEFAULT_PREFS = { edit: true, delete: false, restore: false };

		// ---- widget state -------------------------------------------------

		function applyState(widget, state) {
			const following = !!state.following;
			const toggle = widget.find('[component="post-follow/toggle"]');

			toggle.attr('aria-pressed', following ? 'true' : 'false');
			toggle.attr('title', widget.attr(following ? 'data-title-unfollow' : 'data-title-follow'));
			toggle.find('i')
				.toggleClass('fa-solid', following)
				.toggleClass('fa-regular', !following);

			widget.find('[component="post-follow/options"]').toggleClass('hidden', !following);
			if (!following) {
				widget.find('[component="post-follow/menu"]').removeClass('show');
			}

			const prefs = state.prefs || DEFAULT_PREFS;
			EVENTS.forEach(function (event) {
				widget.find('input[data-event="' + event + '"]').prop('checked', !!prefs[event]);
			});
		}

		function readPrefs(widget) {
			const prefs = {};
			EVENTS.forEach(function (event) {
				prefs[event] = widget.find('input[data-event="' + event + '"]').is(':checked');
			});
			return prefs;
		}

		// ---- injecting the bell next to the reply button ------------------

		async function renderWidget(postEl, state) {
			postEl = $(postEl);
			postEl.attr('data-post-follow', 'done');

			const actions = postEl.find('[component="post/actions"]').first();
			if (!actions.length || actions.find('[component="post-follow/widget"]').length) {
				return;
			}

			const prefs = state.prefs || DEFAULT_PREFS;
			const html = await app.parseAndTranslate('partials/post-follow/wrap', {
				posts: [{
					pid: postEl.attr('data-pid'),
					pfFollowing: !!state.following,
					pfEdit: !!prefs.edit,
					pfDelete: !!prefs.delete,
					pfRestore: !!prefs.restore,
				}],
			});

			const reply = actions.find('[component="post/reply"]').first();
			if (reply.length) {
				reply.after(html);
			} else {
				actions.prepend(html);
			}
		}

		function scan() {
			if (!app.user || !app.user.uid) {
				return;
			}
			const postEls = $('[component="topic"] [component="post"][data-pid]').filter(function () {
				return !$(this).attr('data-post-follow');
			}).toArray();
			if (!postEls.length) {
				return;
			}
			postEls.forEach(function (el) {
				$(el).attr('data-post-follow', 'pending');
			});

			const pids = postEls.map(function (el) {
				return $(el).attr('data-pid');
			});
			socket.emit('plugins.postFollow.getStates', { pids: pids }, function (err, res) {
				if (err) {
					// Allow a retry on the next scan.
					postEls.forEach(function (el) {
						$(el).removeAttr('data-post-follow');
					});
					return;
				}
				postEls.forEach(function (el) {
					const state = (res.states && res.states[$(el).attr('data-pid')]) ||
						{ following: false, prefs: DEFAULT_PREFS };
					renderWidget(el, state);
				});
			});
		}

		// ---- profile sidebar: put the link between "watched categories" and "watched tags" ----

		function placeProfileLink() {
			const link = $('a#followed-posts.plugin-link').first();
			if (!link.length || link.attr('data-pf-placed')) {
				return;
			}
			const categories = link.siblings('a[href$="/categories"]').first();
			if (!categories.length) {
				return; // a theme without this sidebar: keep the default position
			}

			const onPage = !!(ajaxify.data && ajaxify.data.template && ajaxify.data.template['account/followed-posts']);
			const count = ajaxify.data && ajaxify.data.counts ? ajaxify.data.counts.followedPosts : undefined;
			const label = $.trim(link.find('div').first().text());

			link.attr('class', categories.attr('class').replace(/\bactive\b/g, '').trim());
			link.toggleClass('active', onPage);
			link.empty()
				.append($('<div class="flex-grow-1"></div>').text(label))
				.append(count === undefined ? '' : $('<span class="flex-shrink-0 text-xs"></span>').attr('title', count).text(count));
			link.attr('data-pf-placed', '1');
			link.insertAfter(categories);
		}

		hooks.on('action:ajaxify.end', scan);
		hooks.on('action:ajaxify.end', placeProfileLink);
		hooks.on('action:posts.loaded', scan);
		scan();
		placeProfileLink();

		// ---- interactions ---------------------------------------------------

		// Bell: follow / unfollow. Only a toast is shown, nothing is added to the notifications list.
		$(document).on('click', '[component="post-follow/toggle"]', function (e) {
			e.preventDefault();
			const widget = $(this).closest('[component="post-follow/widget"]');
			socket.emit('plugins.postFollow.toggle', { pid: widget.attr('data-pid') }, function (err, res) {
				if (err) {
					return alerts.error(err);
				}
				applyState(widget, res);
				alerts.success(res.following ? '[[post-follow:now-following]]' : '[[post-follow:stopped-following]]', 3000);
			});
		});

		// Arrow: choose which events to follow (at least one).
		$(document).on('click', '[component="post-follow/options"]', function (e) {
			e.preventDefault();
		});

		$(document).on('change', '[component="post-follow/menu"] input[data-event]', function () {
			const input = $(this);
			const widget = input.closest('[component="post-follow/widget"]');
			const prefs = readPrefs(widget);

			if (!EVENTS.some(function (event) { return prefs[event]; })) {
				input.prop('checked', true);
				return alerts.warning('[[post-follow:need-one-event]]', 4000);
			}

			socket.emit('plugins.postFollow.setPrefs', Object.assign({ pid: widget.attr('data-pid') }, prefs), function (err, res) {
				if (err) {
					input.prop('checked', !input.is(':checked'));
					return alerts.error(err);
				}
				applyState(widget, res);
			});
		});
	});
});
