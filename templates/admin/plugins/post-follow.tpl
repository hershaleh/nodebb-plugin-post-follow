<div class="acp-page-container">
	<!-- IMPORT admin/partials/settings/header.tpl -->

	<div class="row m-0">
		<div id="spy-container" class="col-12 col-md-8 px-0 mb-4" tabindex="0">
			<form role="form" class="post-follow-settings">
				<div class="mb-4">
					<h5 class="fw-bold tracking-tight settings-header">{{tx("post-follow:admin-heading")}}</h5>

					<div class="mb-3">
						<label class="form-label" for="minEditChars">{{tx("post-follow:admin-min-edit-chars")}}</label>
						<input type="number" min="0" step="1" id="minEditChars" data-key="minEditChars" class="form-control" placeholder="{defaultMinEditChars}">
						<p class="form-text">{{tx("post-follow:admin-min-edit-chars-help")}}</p>
					</div>

					<div class="mb-3">
						<label class="form-label" for="maxFollowedPosts">
							{{tx("post-follow:admin-max-followed")}}
							<button type="button" class="btn btn-link p-0 ms-1 align-baseline text-decoration-none" data-bs-toggle="popover" data-bs-trigger="hover focus" data-bs-placement="top" data-bs-title="{{tx("post-follow:admin-max-followed-why-title")}}" data-bs-content="{{tx("post-follow:admin-max-followed-why")}}" aria-label="{{tx("post-follow:admin-max-followed-why-title")}}">
								<i class="fa-regular fa-circle-question"></i>
							</button>
						</label>
						<input type="number" min="0" step="1" id="maxFollowedPosts" data-key="maxFollowedPosts" class="form-control" placeholder="{defaultMaxFollowedPosts}">
						<p class="form-text">{{tx("post-follow:admin-max-followed-help")}}</p>
					</div>
				</div>
			</form>
		</div>
	</div>
</div>
