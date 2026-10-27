'use strict';

/* globals $, define, window, socket */

define('admin/plugins/post-follow', ['settings', 'alerts', 'bootstrap'], function (settings, alerts, bootstrap) {
	const ACP = {};

	ACP.init = function () {
		const form = $('.post-follow-settings');
		const lists = form.find('.pf-checklist');

		// Check-lists (groups, categories) are stored as a JSON list in a hidden field.
		function syncFromHidden() {
			lists.each(function () {
				const hidden = form.find('#' + $(this).attr('data-target'));
				let list = [];
				try {
					list = JSON.parse(hidden.val() || '[]');
				} catch (e) {
					list = [];
				}
				if (!Array.isArray(list)) {
					list = [];
				}
				list = list.map(String);
				$(this).find('.pf-check').each(function () {
					$(this).prop('checked', list.indexOf(String(this.value)) !== -1);
				});
			});
		}
		function syncToHidden() {
			lists.each(function () {
				const hidden = form.find('#' + $(this).attr('data-target'));
				const chosen = $(this).find('.pf-check:checked').map(function () { return this.value; }).get();
				hidden.val(JSON.stringify(chosen));
			});
		}
		lists.on('change', '.pf-check', syncToHidden);

		settings.load('post-follow', form, syncFromHidden);

		// Question-mark help bubbles: opened by hovering (mouse) or by tapping (touch devices).
		// A tap focuses the button, which opens the bubble; tapping elsewhere closes it.
		const touchOnly = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
		form.find('[data-bs-toggle="popover"]').each(function () {
			bootstrap.Popover.getOrCreateInstance(this, {
				trigger: touchOnly ? 'focus' : 'hover focus',
				placement: 'top',
				container: 'body',
			});
		});

		$('#save').on('click', function () {
			syncToHidden();
			// The settings module serializes every checkbox in the form (and would store the
			// list boxes as "off"), so lift the lists out of the form while it saves.
			const stash = [];
			lists.each(function () {
				const placeholder = $('<span></span>');
				$(this).before(placeholder);
				stash.push([placeholder, $(this).detach()]);
			});
			settings.save('post-follow', form, function () {
				alerts.success('[[post-follow:admin-saved]]');
			});
			stash.forEach(function (pair) {
				pair[0].replaceWith(pair[1]);
			});
		});

		$('#pf-run-cleanup').on('click', function () {
			socket.emit('plugins.postFollow.runCleanup', {}, function (err, res) {
				if (err) {
					return alerts.error(err);
				}
				alerts.success('[[post-follow:admin-cleanup-done, ' + res.posts + ', ' + res.follows + ']]');
			});
		});
	};

	return ACP;
});
