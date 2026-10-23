#!/usr/bin/env node
// Local-only comparison. This program never performs network or auth operations.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (['--version-json', '--rc-dir', '--rc-config'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('missing option');
      out[arg.slice(2)] = argv[++i];
    } else throw new Error('unsupported option');
  }
  return out;
}

function decodeVersion(raw) {
  let response;
  try { response = JSON.parse(raw); } catch { throw new Error('invalid JSON'); }
  const version = response?.result ?? response;
  if (!version || !Array.isArray(version.modules)) throw new Error('missing modules; request include=modules');
  const modules = version.modules.map((item) => {
    if (typeof item?.name !== 'string' || typeof item?.content_base64 !== 'string') throw new Error('invalid module entry');
    return {
      name: item.name,
      contentType: typeof item.content_type === 'string' ? item.content_type : 'unknown',
      bytes: Buffer.from(item.content_base64, 'base64')
    };
  });
  return { version, modules };
}

function typeFor(name) {
  if (name.toLowerCase().endsWith('.map')) return 'application/source-map';
  if (name.toLowerCase().endsWith('.wasm')) return 'application/wasm';
  return 'application/javascript+module';
}

function readLocalModules(directory) {
  let root;
  try { root = fs.realpathSync(directory); } catch { throw new Error('RC bundle directory unavailable'); }
  const extensions = new Set(['.js', '.mjs', '.cjs', '.map', '.wasm']);
  const result = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        const name = path.relative(root, absolute).split(path.sep).join('/');
        result.push({ name, contentType: typeFor(name), bytes: fs.readFileSync(absolute) });
      }
    }
  };
  walk(root);
  if (!result.length) throw new Error('no recognized module files in RC bundle');
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function readJsonc(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Error('RC config unavailable'); }
  raw = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(raw); } catch { throw new Error('RC config is not valid JSONC'); }
}

function safeSourceLabel(value) {
  const parts = String(value).replace(/\\/g, '/').replace(/^[a-z]+:\/\//i, '').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || 'unknown-source';
}

function sourceMapInfo(module) {
  if (!module.name.toLowerCase().endsWith('.map') && !module.contentType.includes('source-map')) return null;
  let map;
  try { map = JSON.parse(module.bytes.toString('utf8')); } catch { return { available: false }; }
  if (!Array.isArray(map.sources)) return { available: false };
  const sources = map.sources.map((source, index) => {
    const content = Array.isArray(map.sourcesContent) ? map.sourcesContent[index] : null;
    return { label: safeSourceLabel(source), hash: typeof content === 'string' ? sha256(Buffer.from(content)) : null };
  }).sort((a, b) => a.label.localeCompare(b.label));
  return { available: true, contentHashesAvailable: sources.every((source) => typeof source.hash === 'string'), sourceCount: sources.length, sources };
}

function routesIn(module) {
  if (module.name.toLowerCase().endsWith('.map')) return [];
  const text = module.bytes.toString('utf8');
  const routes = new Set();
  for (const match of text.matchAll(/["'](\/api\/[A-Za-z0-9_.$*{}\/:?-]+)["']/g)) routes.add(match[1]);
  return [...routes].sort();
}

function summarize(modules, mainModule) {
  return modules.map((module) => {
    const map = sourceMapInfo(module);
    const text = map ? '' : module.bytes.toString('utf8');
    return {
      name: module.name,
      contentType: module.contentType,
      bytes: module.bytes.length,
      sha256: sha256(module.bytes),
      isMainModule: module.name === mainModule,
      apiRouteIndicators: routesIn(module),
      handlerTokenIndicators: map ? null : {
        fetch: /\bfetch\b/.test(text),
        scheduled: /\bscheduled\b/.test(text),
        export: /\bexport\b/.test(text)
      },
      sourceMap: map
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function diff(left, right) {
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  return {
    onlyProduction: left.filter((item) => !rightSet.has(item)).sort(),
    onlyRC: right.filter((item) => !leftSet.has(item)).sort()
  };
}

function sourceDiff(prodSummary, rcSummary) {
  const makeMap = (items) => new Map(items.filter((item) => item.sourceMap?.available && item.sourceMap.contentHashesAvailable)
    .flatMap((item) => item.sourceMap.sources.map((source) => [`${item.name}:${source.label}`, source.hash])));
  const prod = makeMap(prodSummary);
  const rc = makeMap(rcSummary);
  if (!prod.size || !rc.size) return { available: false, reason: 'source map with sourcesContent missing on one or both sides' };
  const added = [];
  const removed = [];
  const changed = [];
  const keys = new Set([...prod.keys(), ...rc.keys()]);
  for (const key of [...keys].sort()) {
    const label = key.slice(key.indexOf(':') + 1);
    if (!prod.has(key)) added.push(label);
    else if (!rc.has(key)) removed.push(label);
    else if (prod.get(key) !== rc.get(key)) changed.push(label);
  }
  return { available: true, added, removed, changed, unchangedCount: keys.size - added.length - removed.length - changed.length };
}

function safeBindings(version) {
  const values = version.bindings ?? version.resources?.bindings;
  if (!Array.isArray(values)) return { available: false, items: [] };
  return {
    available: true,
    items: values.map((binding) => {
      const item = {
        name: typeof binding?.name === 'string' ? binding.name : 'unknown',
        type: typeof binding?.type === 'string' ? binding.type : 'unknown'
      };
      if (item.type === 'd1' && typeof (binding.database_id ?? binding.id) === 'string') {
        item.databaseId = binding.database_id ?? binding.id;
      }
      return item;
    }).sort((a, b) => `${a.name}:${a.type}`.localeCompare(`${b.name}:${b.type}`))
  };
}

function safeAssetConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const result = {};
  for (const key of ['base_path', 'html_handling', 'not_found_handling']) {
    if (typeof config[key] === 'string') result[key] = config[key];
  }
  if (typeof config.run_worker_first === 'boolean') result.run_worker_first = config.run_worker_first;
  else if (Array.isArray(config.run_worker_first)) {
    result.run_worker_first = config.run_worker_first.filter((item) => typeof item === 'string' && /^!?\//.test(item));
  }
  return result;
}

function cronsFrom(value) {
  const crons = value?.triggers?.crons ?? value?.triggers?.cron ?? value?.crons;
  return Array.isArray(crons) && crons.every((item) => typeof item === 'string') ? [...crons].sort() : null;
}

function apiFeatureIndicators(routes, modules) {
  const codeRoutes = routes.join('\n');
  const hasScheduled = modules.some((module) => module.handlerTokenIndicators?.scheduled === true);
  return {
    authenticationApi: /\/api\/(auth|login|logout|session|register)(\/|$)/i.test(codeRoutes),
    groupCalendarApi: /\/api\/shared\/calendar/i.test(codeRoutes),
    personalEventsApi: /\/api\/(personal|personal-events)/i.test(codeRoutes),
    pushApi: /\/api\/(push|notifications?)/i.test(codeRoutes),
    profileApi: /\/api\/profile/i.test(codeRoutes),
    budgetOrWageApi: /\/api\/(budget|wage)/i.test(codeRoutes),
    scheduledHandlerToken: hasScheduled
  };
}

function compare(raw, rcDir, rcConfigPath) {
  const { version, modules: prodRaw } = decodeVersion(raw);
  const rcRaw = readLocalModules(rcDir);
  const main = typeof version.main_module === 'string' ? version.main_module : null;
  const prod = summarize(prodRaw, main);
  const rc = summarize(rcRaw, main);
  const prodRoutes = [...new Set(prod.flatMap((item) => item.apiRouteIndicators))].sort();
  const rcRoutes = [...new Set(rc.flatMap((item) => item.apiRouteIndicators))].sort();
  const prodFeatures = apiFeatureIndicators(prodRoutes, prod);
  const rcFeatures = apiFeatureIndicators(rcRoutes, rc);
  const prodCrons = cronsFrom(version);
  const prodMainHash = prod.find((item) => item.name === main)?.sha256 ?? null;
  const rcMainHash = rc.find((item) => item.name === main)?.sha256 ?? null;
  const rcConfig = rcConfigPath ? readJsonc(rcConfigPath) : null;
  const rcCrons = rcConfig ? cronsFrom(rcConfig) : null;
  return {
    mode: 'local-only; static indicators are heuristic, not runtime proof',
    production: {
      versionId: typeof version.id === 'string' ? version.id : null,
      createdOn: typeof version.created_on === 'string' ? version.created_on : null,
      mainModule: main,
      modules: prod,
      apiFeatureIndicators: prodFeatures,
      bindings: safeBindings(version),
      cronTriggers: prodCrons,
      assetConfig: safeAssetConfig(version.assets?.config)
    },
    rc: {
      mainModule: main,
      modules: rc,
      apiFeatureIndicators: rcFeatures,
      cronTriggersFromConfig: rcCrons
    },
    differences: {
      moduleNames: diff(prod.map((item) => item.name), rc.map((item) => item.name)),
      apiRouteIndicators: diff(prodRoutes, rcRoutes),
      apiFeatureIndicators: Object.fromEntries(Object.keys(prodFeatures).map((key) => [key, { production: prodFeatures[key], rc: rcFeatures[key], equal: prodFeatures[key] === rcFeatures[key] }])),
      cronTriggersEqual: prodCrons !== null && rcCrons !== null ? prodCrons.join('\n') === rcCrons.join('\n') : null,
      mainModuleHashEqual: prodMainHash !== null && prodMainHash === rcMainHash,
      sourceContent: sourceDiff(prod, rc)
    },
    limitations: [
      'API route and handler indicators are heuristic string scans.',
      'This comparison does not enumerate the Static Assets manifest or prove runtime behavior.',
      'TypeScript source comparison requires source maps with sourcesContent on both sides.'
    ]
  };
}

function runSelfTest() {
  const sentinel = 'SENSITIVE_DUMMY_SOURCE_MUST_NOT_PRINT';
  const make = (route, includeScheduled = true) => {
    const code = Buffer.from(`export default { fetch(request) {}, ${includeScheduled ? 'scheduled() {}' : ''} }; const r = '${route}'; const auth='/api/auth/login'; const push='/api/push/subscribe';`);
    const map = Buffer.from(JSON.stringify({ version: 3, file: 'index.js', sources: ['../../src/shared.ts'], sourcesContent: [`export const route='${route}';${sentinel}`], names: [], mappings: '' }));
    const modules = [
      { name: 'index.js', content_type: 'application/javascript+module', content_base64: code.toString('base64') },
      { name: 'index.js.map', content_type: 'application/source-map', content_base64: map.toString('base64') }
    ];
    const version = { id: 'dummy', main_module: 'index.js', modules, bindings: [{ name: 'DB', type: 'd1', database_id: 'dummy-d1-id' }, { name: 'VAPID_PRIVATE_KEY', type: 'secret_text', text: 'DO_NOT_EMIT' }], triggers: { crons: ['*/1 * * * *'] } };
    return { version, json: JSON.stringify({ success: true, result: version }), modules: modules.map((item) => ({ name: item.name, contentType: item.content_type, bytes: Buffer.from(item.content_base64, 'base64') })) };
  };
  const first = make('/api/shared/calendar/sync');
  const second = make('/api/personal/events', false);
  const firstSummary = summarize(first.modules, 'index.js');
  const sameSummary = summarize(first.modules, 'index.js');
  const changedSummary = summarize(second.modules, 'index.js');
  const tests = [];
  const check = (condition, name) => { if (!condition) throw new Error(`self-test failed: ${name}`); tests.push(name); };
  check(firstSummary[0].sha256 === sameSummary[0].sha256, 'module hash');
  check(firstSummary[0].apiRouteIndicators.includes('/api/shared/calendar/sync'), 'route detection');
  check(diff(firstSummary.flatMap((m) => m.apiRouteIndicators), changedSummary.flatMap((m) => m.apiRouteIndicators)).onlyRC.includes('/api/personal/events'), 'route difference');
  check(sourceDiff(firstSummary, changedSummary).changed.includes('src/shared.ts'), 'source-map source diff');
  check(changedSummary[0].handlerTokenIndicators.scheduled === false, 'scheduled token indicator');
  check(safeBindings(first.version).items[0].name === 'DB' && safeBindings(first.version).items[0].databaseId === 'dummy-d1-id', 'safe D1 binding metadata');
  check(cronsFrom(first.version)[0] === '*/1 * * * *', 'cron extraction');
  const features = apiFeatureIndicators(firstSummary.flatMap((item) => item.apiRouteIndicators), firstSummary);
  check(features.authenticationApi && features.pushApi && features.groupCalendarApi && features.scheduledHandlerToken, 'auth/push/calendar/cron feature indicators');
  const output = JSON.stringify({ firstSummary, changedSummary, source: sourceDiff(firstSummary, changedSummary), bindings: safeBindings(first.version) });
  check(!output.includes(sentinel) && !output.includes('DO_NOT_EMIT'), 'no source or binding values emitted');
  const decoded = decodeVersion(first.json);
  check(decoded.modules.length === 2 && decoded.version.main_module === 'index.js', 'API response decode');
  process.stdout.write(`SELF-TESTS PASSED: ${tests.length} assertions; no source text or binding values emitted.\n`);
}

function printHelp() {
  process.stdout.write([
    'Local-only Worker version comparator (no HTTP, CLI auth, environment, or credential access).',
    'Usage: node compare-worker-version.mjs --version-json <private-response.json> --rc-dir <dry-run-bundle> [--rc-config <wrangler.jsonc>]',
    '       node compare-worker-version.mjs --self-test',
    'Output includes module names/sizes/hashes, heuristic route/handler indicators, safe binding names/types, and optional source-map hashes. It never prints module/source-map contents.'
  ].join('\n') + '\n');
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) printHelp();
  else if (options.selfTest) runSelfTest();
  else {
    if (!options['version-json'] || !options['rc-dir']) throw new Error('required input missing');
    let raw;
    try { raw = fs.readFileSync(options['version-json'], 'utf8'); } catch { throw new Error('private version JSON unreadable'); }
    process.stdout.write(`${JSON.stringify(compare(raw, options['rc-dir'], options['rc-config']), null, 2)}\n`);
  }
} catch (error) {
  const message = error?.message?.startsWith('self-test failed:') ? error.message : 'input validation failed; module contents were not printed';
  process.stderr.write(`${message}\nUse --help for usage.\n`);
  process.exitCode = 2;
}
