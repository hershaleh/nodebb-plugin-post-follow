<!-- IMPORT partials/account/header.tpl -->

<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
	<h3 class="fw-semibold fs-5 mb-0">{{tx("post-follow:page-title")}}</h3>
	{{{ if pfTotalFollowed }}}
	<div class="d-flex flex-wrap gap-2">
		<button type="button" class="btn btn-sm btn-outline-secondary" component="post-follow/unfollow-unavailable">{{tx("post-follow:unfollow-unavailable")}}</button>
		<button type="button" class="btn btn-sm btn-outline-danger" component="post-follow/unfollow-all" data-count="{pfTotalFollowed}">{{tx("post-follow:unfollow-all")}}</button>
	</div>
	{{{ end }}}
</div>

{{{ if pfTotalFollowed }}}
<form class="d-flex flex-wrap gap-2 mb-3" method="get" action="">
	<select name="cid" class="form-select form-select-sm w-auto">
		<option value="">{{tx("post-follow:filter-all-categories")}}</option>
		{{{ each pfCategories }}}
		<option value="{./cid}" {{{ if ./selected }}}selected{{{ end }}}>{./name}</option>
		{{{ end }}}
	</select>
	<input type="text" name="q" value="{pfQuery}" class="form-control form-control-sm w-auto" placeholder="{{tx("post-follow:filter-topic-placeholder")}}">
	<button type="submit" class="btn btn-sm btn-primary">{{tx("post-follow:filter-apply")}}</button>
	{{{ if pfFiltered }}}
	<a class="btn btn-sm btn-outline-secondary" href="{config.relative_path}/user/{userslug}/followed-posts">{{tx("post-follow:filter-clear")}}</a>
	{{{ end }}}
</form>
{{{ end }}}

{{{ if !posts.length }}}
<div class="alert alert-warning text-center">
	{{{ if pfFiltered }}}{{tx("post-follow:filter-no-results")}}{{{ else }}}{{tx("post-follow:no-followed-posts")}}{{{ end }}}
</div>
{{{ end }}}

<ul component="posts" class="posts-list list-unstyled">
	{{{ each posts }}}
	<li component="post" class="posts-list-item {{{ if ./deleted }}}deleted{{{ end }}}" data-pid="{./pid}" data-uid="{./uid}">
		<hr/>
		<div class="d-flex justify-content-between align-items-start gap-2">
			<a class="fw-semibold fs-5 text-reset text-break" href="{config.relative_path}/post/{encodeURIComponent(./pid)}">{./topic.title}</a>
			<!-- IMPORT partials/post-follow/button.tpl -->
		</div>

		<div class="d-flex flex-wrap gap-2 text-sm align-items-center my-2">
			<a class="fw-semibold" href="{config.relative_path}/user/{./user.userslug}">{./user.username}</a>
			<span class="timeago text-muted" title="{./timestampISO}"></span>
			{{{ if ./category }}}
			<a class="text-muted" href="{config.relative_path}/category/{./category.slug}">{./category.name}</a>
			{{{ end }}}
			{{{ if ./pfPostDeleted }}}<span class="badge bg-danger">{{tx("post-follow:badge-post-deleted")}}</span>{{{ end }}}
			{{{ if ./pfTopicDeleted }}}<span class="badge bg-danger">{{tx("post-follow:badge-topic-deleted")}}</span>{{{ end }}}
			{{{ if ./pfTopicLocked }}}<span class="badge bg-warning text-dark">{{tx("post-follow:badge-topic-locked")}}</span>{{{ end }}}
		</div>

		<div class="content text-sm text-break">{./snippet}</div>
	</li>
	{{{ end }}}
</ul>

{{{ if pagination.pages.length }}}
<!-- IMPORT partials/paginator.tpl -->
{{{ end }}}

<!-- IMPORT partials/account/footer.tpl -->
