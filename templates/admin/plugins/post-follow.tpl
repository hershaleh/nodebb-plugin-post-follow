<div class="acp-page-container">
	<!-- IMPORT admin/partials/settings/header.tpl -->

	<div class="row m-0">
		<div id="spy-container" class="col-12 col-md-8 px-0 mb-4" tabindex="0">
			<form role="form" class="post-follow-settings">
				<div class="mb-4">
					<h5 class="fw-bold tracking-tight settings-header">[[post-follow:admin-heading]]</h5>

					<div class="mb-3">
						<label class="form-label" for="minEditChars">[[post-follow:admin-min-edit-chars]]</label>
						<input type="number" min="0" step="1" id="minEditChars" data-key="minEditChars" class="form-control" placeholder="{defaultMinEditChars}">
						<p class="form-text">[[post-follow:admin-min-edit-chars-help]]</p>
					</div>
				</div>
			</form>
		</div>
	</div>
</div>
