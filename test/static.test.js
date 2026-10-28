'use strict';

/*
 * STATIC checks: no NodeBB involved, nothing is executed. They catch typos and drift
 * (missing translations, hooks pointing at methods that do not exist, missing files).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const readJson = file => JSON.parse(read(file));
const walk = (dir, out = []) => {
	for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(rel, out);
		} else {
			out.push(rel);
		}
	}
	return out;
};

const pluginJson = readJson('plugin.json');
const languages = fs.readdirSync(path.join(root, 'languages'));
const placeholders = str => (String(str).match(/%\d+/g) || []).sort().join(',');

test('every JS file passes a syntax check', () => {
	const files = ['library.js', ...walk('public'), ...walk('test').filter(f => f.endsWith('.js'))];
	for (const file of files) {
		const res = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
		assert.equal(res.status, 0, `${file}: ${res.stderr}`);
	}
});

test('plugin.json: every hook points at a method defined in library.js', () => {
	const lib = read('library.js');
	for (const { hook, method } of pluginJson.hooks) {
		assert.ok(new RegExp(`^Plugin\\.${method}\\s*=`, 'm').test(lib), `${hook} -> ${method} is not defined in library.js`);
	}
});

test('plugin.json: referenced files exist', () => {
	assert.ok(fs.existsSync(path.join(root, pluginJson.library)));
	for (const script of pluginJson.scripts) {
		assert.ok(fs.existsSync(path.join(root, script)), script);
	}
	for (const file of Object.values(pluginJson.modules)) {
		assert.ok(fs.existsSync(path.join(root, file)), file);
	}
	assert.ok(fs.existsSync(path.join(root, pluginJson.templates)));
	assert.ok(fs.existsSync(path.join(root, pluginJson.languages, pluginJson.defaultLang)));
});

test('package.json and plugin.json agree', () => {
	const pkg = readJson('package.json');
	assert.equal(pkg.name, pluginJson.id);
	assert.equal(pkg.nbbpm.compatibility, pluginJson.compatibility);
	assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test('all languages have the same files and keys as en-GB', () => {
	const base = 'en-GB';
	for (const file of fs.readdirSync(path.join(root, 'languages', base))) {
		const reference = readJson(`languages/${base}/${file}`);
		for (const lang of languages) {
			const other = readJson(`languages/${lang}/${file}`);
			assert.deepEqual(Object.keys(other).sort(), Object.keys(reference).sort(), `${lang}/${file} keys differ from ${base}`);
			for (const key of Object.keys(reference)) {
				assert.ok(String(other[key]).trim(), `${lang}/${file}: "${key}" is empty`);
				assert.equal(placeholders(other[key]), placeholders(reference[key]), `${lang}/${file}: placeholders of "${key}" differ`);
			}
		}
	}
});

test('every translation key used in the code exists', () => {
	const keys = new Set(Object.keys(readJson('languages/en-GB/post-follow.json')));
	const sources = ['library.js', ...walk('public'), ...walk('templates')];
	const missing = [];
	for (const file of sources) {
		const text = read(file);
		for (const match of text.matchAll(/(?:\[\[|tx\(["'])post-follow:([a-z0-9-]+)/g)) {
			const key = match[1];
			// a trailing "-" means the key is built at runtime (e.g. event-${name})
			const found = key.endsWith('-') ? [...keys].some(k => k.startsWith(key)) : keys.has(key);
			if (!found) {
				missing.push(`${file}: ${match[1]}`);
			}
		}
	}
	assert.deepEqual(missing, []);
});

test('the integration test file refers to existing socket methods', () => {
	const text = read('test/integration/post-follow.integration.js');
	const lib = read('library.js');
	for (const match of text.matchAll(/SocketPlugins\.postFollow\.(\w+)/g)) {
		assert.ok(new RegExp(`postFollow\\.${match[1]}\\s*=`).test(lib), `library.js has no SocketPlugins.postFollow.${match[1]}`);
	}
});
