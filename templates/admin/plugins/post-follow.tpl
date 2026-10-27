<div class="acp-page-container">
	<!-- IMPORT admin/partials/settings/header.tpl -->

	<div class="row m-0">
		<div id="spy-container" class="col-12 col-md-8 px-0 mb-4" tabindex="0">

			<div class="mb-4">
				<h5 class="fw-bold tracking-tight settings-header">{{tx("post-follow:stats-heading")}}</h5>
				<div class="row g-2 mb-3">
					<div class="col-6 col-md-3"><div class="border rounded p-2 text-center"><div class="fs-4 fw-semibold">{stats.totalFollows}</div><div class="text-xs text-muted">{{tx("post-follow:stats-follows")}}</div></div></div>
					<div class="col-6 col-md-3"><div class="border rounded p-2 text-center"><div class="fs-4 fw-semibold">{stats.distinctPosts}</div><div class="text-xs text-muted">{{tx("post-follow:stats-posts")}}</div></div></div>
					<div class="col-6 col-md-3"><div class="border rounded p-2 text-center"><div class="fs-4 fw-semibold">{stats.usersFollowing}</div><div class="text-xs text-muted">{{tx("post-follow:stats-users")}}</div></div></div>
					<div class="col-6 col-md-3"><div class="border rounded p-2 text-center"><div class="fs-4 fw-semibold">{stats.sent.total}</div><div class="text-xs text-muted">{{tx("post-follow:stats-sent")}}</div></div></div>
				</div>
				<p class="text-xs text-muted mb-3">
					{{tx("post-follow:event-edit")}}: {stats.sent.edit} &middot;
					{{tx("post-follow:event-delete")}}: {stats.sent.delete} &middot;
					{{tx("post-follow:event-restore")}}: {stats.sent.restore} &middot;
					{{tx("post-follow:event-reply")}}: {stats.sent.reply} &middot;
					{{tx("post-follow:event-topic")}}: {stats.sent.topic}
				</p>

				<h6 class="fw-semibold">{{tx("post-follow:stats-top")}}</h6>
				{{{ if !stats.topPosts.length }}}
				<p class="text-muted text-sm">{{tx("post-follow:stats-none")}}</p>
				{{{ else }}}
				<ol class="text-sm ps-3">
					{{{ each stats.topPosts }}}
					<li><a href="{config.relative_path}/post/{./pid}" target="_blank" rel="noopener">{{{ if ./title }}}{./title}{{{ else }}}#{./pid}{{{ end }}}</a> <span class="text-muted">&mdash; {./followers}</span></li>
					{{{ end }}}
				</ol>
				{{{ end }}}
			</div>

			<form role="form" class="post-follow-settings">
				<div class="mb-4">
					<h5 class="fw-bold tracking-tight settings-header">{{tx("post-follow:admin-heading")}}</h5>

					<div class="mb-3">
						<label class="form-label" for="minEditChars">{{tx("post-follow:admin-min-edit-chars")}}</label>
						<input type="number" min="0" step="1" id="minEditChars" name="minEditChars" data-key="minEditChars" class="form-control" placeholder="{defaultMinEditChars}">
						<p class="form-text">{{tx("post-follow:admin-min-edit-chars-help")}}</p>
					</div>

					<div class="mb-3">
						<div class="d-flex align-items-center gap-1 mb-2">
							<label class="form-label mb-0" for="maxFollowedPosts">{{tx("post-follow:admin-max-followed")}}</label>
							<button type="button" class="btn btn-link p-0 text-decoration-none lh-1" data-bs-toggle="popover" data-bs-trigger="hover focus" data-bs-placement="top" data-bs-title="{{tx("post-follow:admin-max-followed-why-title")}}" data-bs-content="{{tx("post-follow:admin-max-followed-why")}}" aria-label="{{tx("post-follow:admin-max-followed-why-title")}}">
								<i class="fa-regular fa-circle-question"></i>
							</button>
						</div>
						<input type="number" min="0" step="1" id="maxFollowedPosts" name="maxFollowedPosts" data-key="maxFollowedPosts" class="form-control" placeholder="{defaultMaxFollowedPosts}">
						<p class="form-text">{{tx("post-follow:admin-max-followed-help")}}</p>
					</div>

					<div class="mb-3">
						<label class="form-label">{{tx("post-follow:admin-exempt-groups")}}</label>
						<input type="hidden" id="exemptGroups" name="exemptGroups" data-key="exemptGroups">
						<div class="pf-checklist border rounded p-2" data-target="exemptGroups" style="max-height: 220px; overflow-y: auto;">
							{{{ each groups }}}
							<div class="form-check">
								<input class="form-check-input pf-check" type="checkbox" id="pf-group-{@index}" value="{./name}">
								<label class="form-check-label" for="pf-group-{@index}">{./displayName}</label>
							</div>
							{{{ end }}}
						</div>
						<p class="form-text">{{tx("post-follow:admin-exempt-groups-help")}}</p>
					</div>

					<h5 class="fw-bold tracking-tight settings-header mt-4">{{tx("post-follow:admin-blocklist-heading")}}</h5>

					<div class="mb-3">
						<label class="form-label">{{tx("post-follow:admin-blocked-categories")}}</label>
						<input type="hidden" id="blockedCategories" name="blockedCategories" data-key="blockedCategories">
						<div class="pf-checklist border rounded p-2" data-target="blockedCategories" style="max-height: 220px; overflow-y: auto;">
							{{{ each categories }}}
							<div class="form-check">
								<input class="form-check-input pf-check" type="checkbox" id="pf-cat-{@index}" value="{./cid}">
								<label class="form-check-label" for="pf-cat-{@index}">{./name}</label>
							</div>
							{{{ end }}}
						</div>
						<p class="form-text">{{tx("post-follow:admin-blocked-categories-help")}}</p>
					</div>

					<div class="mb-3">
						<label class="form-label" for="blockedTopics">{{tx("post-follow:admin-blocked-topics")}}</label>
						<input type="text" id="blockedTopics" name="blockedTopics" data-key="blockedTopics" class="form-control" placeholder="12, 345">
						<p class="form-text">{{tx("post-follow:admin-blocked-topics-help")}}</p>
					</div>

					<div class="mb-3">
						<label class="form-label" for="blockedPosts">{{tx("post-follow:admin-blocked-posts")}}</label>
						<input type="text" id="blockedPosts" name="blockedPosts" data-key="blockedPosts" class="form-control" placeholder="101, 202">
						<p class="form-text">{{tx("post-follow:admin-blocked-posts-help")}}</p>
					</div>

					<h5 class="fw-bold tracking-tight settings-header mt-4">{{tx("post-follow:admin-cleanup-heading")}}</h5>

					<div class="mb-3">
						<label class="form-label" for="cleanupDays">{{tx("post-follow:admin-cleanup-days")}}</label>
						<input type="number" min="0" step="1" id="cleanupDays" name="cleanupDays" data-key="cleanupDays" class="form-control" placeholder="{defaultCleanupDays}">
						<p class="form-text">{{tx("post-follow:admin-cleanup-days-help")}}</p>
						<button type="button" id="pf-run-cleanup" class="btn btn-sm btn-outline-secondary">{{tx("post-follow:admin-cleanup-run")}}</button>
					</div>

					<h5 class="fw-bold tracking-tight settings-header mt-4">{{tx("post-follow:admin-api-heading")}}</h5>

					<div class="mb-3">
						<div class="form-check form-switch d-flex align-items-center gap-2">
							<input class="form-check-input" type="checkbox" id="enableApi" name="enableApi" data-key="enableApi">
							<label class="form-check-label" for="enableApi">{{tx("post-follow:admin-api-enable")}}</label>
							<button type="button" class="btn btn-link p-0 text-decoration-none lh-1" data-bs-toggle="popover" data-bs-trigger="hover focus" data-bs-placement="top" data-bs-title="{{tx("post-follow:admin-api-why-title")}}" data-bs-content="{{tx("post-follow:admin-api-why")}}" aria-label="{{tx("post-follow:admin-api-why-title")}}">
								<i class="fa-regular fa-circle-question"></i>
							</button>
						</div>
						<p class="form-text">{{tx("post-follow:admin-api-help")}}</p>
					</div>
				</div>
			</form>
		</div>
	</div>
</div>
