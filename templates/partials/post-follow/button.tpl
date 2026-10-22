<div component="post-follow/widget" class="btn-group post-follow-widget" data-pid="{./pid}" data-title-follow="{{tx("post-follow:follow-post")}}" data-title-unfollow="{{tx("post-follow:unfollow-post")}}">
	<a component="post-follow/toggle" href="#" role="button" class="btn btn-ghost btn-sm" aria-pressed="{{{ if ./pfFollowing }}}true{{{ else }}}false{{{ end }}}" title="{{{ if ./pfFollowing }}}{{tx("post-follow:unfollow-post")}}{{{ else }}}{{tx("post-follow:follow-post")}}{{{ end }}}">
		<i class="fa-fw text-primary {{{ if ./pfFollowing }}}fa-solid{{{ else }}}fa-regular{{{ end }}} fa-bell"></i>
	</a>
	<a component="post-follow/options" href="#" role="button" class="btn btn-ghost btn-sm px-1 {{{ if !./pfFollowing }}}hidden{{{ end }}}" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-haspopup="true" aria-expanded="false" title="{{tx("post-follow:options")}}" aria-label="{{tx("post-follow:options")}}">
		<i class="fa-solid fa-chevron-down text-primary" style="font-size: 0.65em;"></i>
	</a>
	<ul component="post-follow/menu" class="dropdown-menu dropdown-menu-end p-2" style="min-width: 12rem;">
		<li class="px-2 pb-1 text-xs text-muted">{{tx("post-follow:options")}}</li>
		<li>
			<label class="dropdown-item rounded-1 d-flex align-items-center gap-2 mb-0">
				<input type="checkbox" class="form-check-input mt-0" data-event="edit" {{{ if ./pfEdit }}}checked{{{ end }}}>
				<span>{{tx("post-follow:event-edit")}}</span>
			</label>
		</li>
		<li>
			<label class="dropdown-item rounded-1 d-flex align-items-center gap-2 mb-0">
				<input type="checkbox" class="form-check-input mt-0" data-event="delete" {{{ if ./pfDelete }}}checked{{{ end }}}>
				<span>{{tx("post-follow:event-delete")}}</span>
			</label>
		</li>
		<li>
			<label class="dropdown-item rounded-1 d-flex align-items-center gap-2 mb-0">
				<input type="checkbox" class="form-check-input mt-0" data-event="restore" {{{ if ./pfRestore }}}checked{{{ end }}}>
				<span>{{tx("post-follow:event-restore")}}</span>
			</label>
		</li>
	</ul>
</div>
