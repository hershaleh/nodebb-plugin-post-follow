'use strict';

/* globals $, socket, require */

$(document).ready(function () {
	$(document).on('click', '[component="post/follow-post"]', function (e) {
		e.preventDefault();
		const pid = $(this).parents('[data-pid]').attr('data-pid');
		if (!pid) {
			return;
		}

		socket.emit('plugins.postFollow.toggle', { pid: pid }, function (err, res) {
			require(['alerts'], function (alerts) {
				if (err) {
					return alerts.error(err);
				}
				alerts.success(res.following ?
					'[[post-follow:now-following]]' :
					'[[post-follow:stopped-following]]');
			});

			// Force the three-dots menu to reload so the label reflects the new state.
			$('[data-pid="' + pid + '"] [component="post/tools"] .dropdown-menu')
				.removeAttr('data-loaded').html('');
		});
	});
});
