'use strict';

/* globals $, define, window */

define('admin/plugins/post-follow', ['settings', 'alerts', 'bootstrap'], function (settings, alerts, bootstrap) {
	const ACP = {};

	ACP.init = function () {
		const form = $('.post-follow-settings');
		const hidden = form.find('#exemptGroups');
		const boxes = form.find('.pf-exempt-group');

		// Groups exempt from the limit: checkboxes, stored as a JSON list in a hidden field.
		function syncFromHidden() {
			let list = [];
			try {
				list = JSON.parse(hidden.val() || '[]');
			} catch (e) {
				list = [];
			}
			if (!Array.isArray(list)) {
				list = [];
			}
			boxes.each(function () {
				$(this).prop('checked', list.indexOf(this.value) !== -1);
			});
		}
		function syncToHidden() {
			const list = boxes.filter(':checked').map(function () { return this.value; }).get();
			hidden.val(JSON.stringify(list));
		}
		boxes.on('change', syncToHidden);

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
			settings.save('post-follow', form, function () {
				alerts.success('[[post-follow:admin-saved]]');
			});
		});
	};

	return ACP;
});
