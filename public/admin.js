'use strict';

/* globals $, define, window */

define('admin/plugins/post-follow', ['settings', 'alerts', 'bootstrap'], function (settings, alerts, bootstrap) {
	const ACP = {};

	ACP.init = function () {
		const form = $('.post-follow-settings');
		settings.load('post-follow', form);

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
			settings.save('post-follow', form, function () {
				alerts.success('[[post-follow:admin-saved]]');
			});
		});
	};

	return ACP;
});
