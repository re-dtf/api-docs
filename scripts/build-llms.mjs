// Собирает для агентов llms.txt (оглавление) и llms-full.txt (всё одним текстом) из docs/*.md и site/bundle/*.json.
// Сначала нужен `npm run bundle`. Зависимостей нет.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const BUNDLE = 'site/bundle';
const AREAS = {
	auth: 'Вход и обновление токена',
	feed: 'Ленты, новости, поиск',
	posts: 'Посты: чтение, удаление, история',
	comments: 'Комментарии и реакции',
	subsites: 'Профили и подписки',
	notifications: 'Уведомления',
	editor: 'Редактор, публикация, загрузка',
	realtime: 'WebSocket и реалтайм'
};
const DOCS = ['auth', 'realtime', 'conventions', 'status'];

const ref = (doc, node) => {
	while (node?.$ref) node = node.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k.replace(/~1/g, '/')], doc);
	return node;
};

/** Именованные схемы, встреченные в типах: выводятся один раз в разделе «Схемы» */
const named = new Map();

/** Схема в виде компактного типа: `{ id: integer; name?: string }`. Именованные схемы — по имени. */
function typeOf(doc, schema, depth = 0, expand = false) {
	const prefix = '#/components/schemas/';
	if (!expand && schema?.$ref?.startsWith(prefix)) {
		const name = schema.$ref.slice(prefix.length);
		if (!named.has(name)) named.set(name, { doc, schema: ref(doc, schema) });
		return name;
	}
	schema = ref(doc, schema);
	if (!schema) return 'any';
	if (schema.allOf) return typeOf(doc, { type: 'object', properties: Object.assign({}, ...schema.allOf.map((s) => ref(doc, s)?.properties)) }, depth);
	const alt = schema.oneOf || schema.anyOf;
	if (alt) return alt.map((s) => typeOf(doc, s, depth)).join(' | ');
	if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
	const types = [].concat(schema.type || (schema.properties ? 'object' : 'any'));
	return types.map((t) => {
		if (t === 'array') return `${typeOf(doc, schema.items, depth + 1)}[]`;
		if (t !== 'object') return t;
		if (!schema.properties) return 'object';
		if (depth >= 6) return 'object';
		const req = new Set(schema.required || []);
		const fields = Object.entries(schema.properties).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${typeOf(doc, v, depth + 1)}`);
		return `{ ${fields.join('; ')} }`;
	}).join(' | ');
}

const oneLine = (s = '') => s.replace(/\s+/g, ' ').trim();

function auth(doc, op) {
	const sec = op.security ?? doc.security;
	if (!sec || sec.length === 0) return 'не нужна';
	return sec.some((s) => Object.keys(s).length === 0) ? 'токен необязателен' : 'нужен токен (JWTAuthorization)';
}

function renderOp(doc, path, method, op) {
	const server = op.servers?.[0]?.url ?? doc.servers[0].url;
	const out = [`### ${op.operationId}: ${method.toUpperCase()} ${server}${path}`, '', op.summary];
	out.push(`Статус: ${op['x-status']}; подтверждено: ${(op['x-evidence'] || []).join(', ')}; проверено ${op['x-checked']}. Авторизация: ${auth(doc, op)}.`);
	if (op.description) out.push('', op.description.trim());
	const params = (op.parameters || []).map((p) => ref(doc, p));
	const pathItem = doc.paths[path].parameters || [];
	for (const p of [...pathItem.map((p) => ref(doc, p)), ...params]) {
		out.push(`- ${p.in} \`${p.name}\`: ${typeOf(doc, p.schema)}${p.required ? ', обязателен' : ''}${p.description ? `. ${oneLine(p.description)}` : ''}`);
	}
	const body = op.requestBody?.content;
	if (body) {
		const [mime, { schema }] = Object.entries(body)[0];
		out.push(`- тело (${mime}): ${typeOf(doc, schema)}`);
	}
	for (const [code, res] of Object.entries(op.responses || {})) {
		const r = ref(doc, res);
		const schema = r.content && Object.values(r.content)[0]?.schema;
		out.push(`- ответ ${code}: ${oneLine(r.description)}${schema ? ` → ${typeOf(doc, schema)}` : ''}`);
	}
	return out.join('\n');
}

const parts = ['# API DTF', '', 'Проверенное описание API DTF (api.dtf.ru). Ниже общие правила, авторизация и справочник по эндпоинтам.'];

for (const name of DOCS) parts.push('', readFileSync(`docs/${name}.md`, 'utf8').trim());

parts.push('', '# Справочник по эндпоинтам');
for (const file of readdirSync(BUNDLE).filter((f) => f.endsWith('.json'))) {
	const doc = JSON.parse(readFileSync(`${BUNDLE}/${file}`, 'utf8'));
	const area = file.replace('.json', '');
	parts.push('', `## ${AREAS[area] ?? doc.info.title}`);
	if (doc.info.description) parts.push('', doc.info.description.trim());
	for (const [path, item] of Object.entries(doc.paths)) {
		for (const method of ['get', 'post', 'put', 'delete']) {
			if (item[method]) parts.push('', renderOp(doc, path, method, item[method]));
		}
	}
}

// Раздел «Схемы»: имена из типов выше, включая те, что вложены друг в друга
const defined = new Set();
const schemaLines = [];
for (let more = true; more;) {
	more = false;
	for (const [name, { doc, schema }] of [...named]) {
		if (defined.has(name)) continue;
		defined.add(name);
		more = true;
		const description = oneLine(schema.description);
		schemaLines.push(`- \`${name}\` = ${typeOf(doc, schema, 0, true)}${description ? ` (${description})` : ''}`);
	}
}
parts.push('', '# Схемы', '', ...schemaLines.sort());

mkdirSync('site/docs', { recursive: true });
for (const d of DOCS) copyFileSync(`docs/${d}.md`, `site/docs/${d}.md`);
writeFileSync('site/llms-full.txt', parts.join('\n') + '\n');

const index = [
	'# API DTF',
	'',
	'> Проверенное описание API DTF (api.dtf.ru): вход и токены, ленты, посты, комментарии, профили, уведомления, редактор.',
	'',
	'## Документы',
	'',
	'- [Всё одним файлом](llms-full.txt): правила, авторизация, справочник по эндпоинтам',
	...DOCS.map((d) => `- [docs/${d}.md](docs/${d}.md)`),
	'',
	'## Спецификации OpenAPI',
	'',
	...Object.entries(AREAS).map(([a, t]) => `- [${t}](bundle/${a}.json)`)
];
writeFileSync('site/llms.txt', index.join('\n') + '\n');
console.log(`llms-full.txt: ${Math.round(parts.join('\n').length / 1024)} КБ, llms.txt`);
