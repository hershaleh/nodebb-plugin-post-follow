'use strict';

/* globals $, define, window */

define('admin/plugins/post-follow', ['settings', 'alerts'], function (settings, alerts) {
	const ACP = {};

	ACP.init = function () {
		const form = $('.post-follow-settings');
		settings.load('post-follow', form);

		// Question-mark help bubbles: shown on hover (desktop) or on tap/focus (touch devices).
		if (window.bootstrap && window.bootstrap.Popover) {
			form.find('[data-bs-toggle="popover"]').each(function () {
				window.bootstrap.Popover.getOrCreateInstance(this);
			});
		}

		$('#save').on('click', function () {
			settings.save('post-follow', form, function () {
				alerts.success('[[post-follow:admin-saved]]');
			});
		});
	};

	return ACP;
});
