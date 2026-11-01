// lint и bundle через Redocly. Версия зафиксирована, в проект ничего не ставится.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';

const REDOCLY = '@redocly/cli@2.72.1';
const specs = readdirSync('openapi').filter((f) => f.endsWith('.yaml'));

function redocly(args) {
	// Одной строкой: на Windows npx — .cmd, и массив аргументов с shell даёт предупреждение Node
	const r = spawnSync(`npx --yes ${REDOCLY} ${args.join(' ')}`, { stdio: 'inherit', shell: true });
	if (r.status) process.exit(r.status);
}

const task = process.argv[2];

if (task === 'lint') {
	redocly(['lint', ...specs.map((f) => `openapi/${f}`)]);
} else if (task === 'bundle') {
	mkdirSync('site/bundle', { recursive: true });
	for (const f of specs) redocly(['bundle', `openapi/${f}`, '-o', `site/bundle/${f.replace('.yaml', '.json')}`]);
} else {
	console.error('Использование: node scripts/tasks.mjs lint|bundle');
	process.exit(1);
}
