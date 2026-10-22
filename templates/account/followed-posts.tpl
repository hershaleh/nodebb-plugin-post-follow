<!-- IMPORT partials/account/header.tpl -->

<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
	<h3 class="fw-semibold fs-5 mb-0">{{tx("post-follow:page-title")}}</h3>
</div>

{{{ if !posts.length }}}
<div class="alert alert-warning text-center">{{tx("post-follow:no-followed-posts")}}</div>
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
		</div>

		<div class="content text-sm text-break">{./snippet}</div>
	</li>
	{{{ end }}}
</ul>

{{{ if pagination.pages.length }}}
<!-- IMPORT partials/paginator.tpl -->
{{{ end }}}

<!-- IMPORT partials/account/footer.tpl -->
