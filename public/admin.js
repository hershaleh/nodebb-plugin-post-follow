'use strict';

/* globals $, define */

define('admin/plugins/post-follow', ['settings', 'alerts'], function (settings, alerts) {
	const ACP = {};

	ACP.init = function () {
		const form = $('.post-follow-settings');
		settings.load('post-follow', form);

		$('#save').on('click', function () {
			settings.save('post-follow', form, function () {
				alerts.success('[[post-follow:admin-saved]]');
			});
		});
	};

	return ACP;
});
