#!/usr/bin/env node
'use strict';

/*
 * Starts the integration tests with NodeBB's own mocha, inside a real NodeBB checkout.
 *
 *   NODEBB_DIR=/path/to/nodebb npm run test:integration
 *
 * What NODEBB_DIR must look like (the GitHub workflow in .github/workflows/test.yml does all of it):
 *   - NodeBB installed (npm install) and set up once (node app --setup=... --ci=...), so config.json exists
 *   - config.json has a "test_database" section (a separate database: it is EMPTIED by the tests)
 *   - config.json has "test_plugins": ["nodebb-plugin-post-follow"]
 *   - this plugin is installed in NODEBB_DIR/node_modules (npm install /path/to/this/plugin)
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const fail = (message) => {
	console.error(`\nIntegration tests cannot start: ${message}\n`);
	process.exit(2);
};

const dir = process.env.NODEBB_DIR && path.resolve(process.env.NODEBB_DIR);
if (!dir) {
	fail('set NODEBB_DIR to a NodeBB checkout, e.g.  NODEBB_DIR=~/nodebb npm run test:integration');
}
if (!fs.existsSync(path.join(dir, 'app.js'))) {
	fail(`${dir} does not look like a NodeBB checkout (no app.js).`);
}
const mocha = path.join(dir, 'node_modules', '.bin', 'mocha');
if (!fs.existsSync(mocha)) {
	fail('mocha is missing. In the NodeBB folder run: npm install');
}

let config;
try {
	config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
} catch (err) {
	fail('NodeBB has no readable config.json. Run the NodeBB setup first (node app --setup ...).');
}
if (!config.test_database) {
	fail('config.json has no "test_database" section. The tests need a separate database (it gets emptied).');
}
if (!Array.isArray(config.test_plugins) || !config.test_plugins.includes('nodebb-plugin-post-follow')) {
	fail('add "test_plugins": ["nodebb-plugin-post-follow"] to config.json so the plugin is activated for the tests.');
}
if (!fs.existsSync(path.join(dir, 'node_modules', 'nodebb-plugin-post-follow', 'library.js'))) {
	fail('the plugin is not installed in NodeBB. In the NodeBB folder run: npm install /path/to/nodebb-plugin-post-follow');
}

const testFile = path.join(__dirname, 'post-follow.integration.js');
const result = spawnSync(mocha, ['--exit', '--timeout', '60000', testFile], {
	cwd: dir,
	stdio: 'inherit',
	env: { ...process.env, NODEBB_DIR: dir },
});
process.exit(result.status === null ? 1 : result.status);
